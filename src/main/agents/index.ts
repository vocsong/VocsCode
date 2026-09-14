/** Vesta: the in-app assistant. The agent loop is pi's (src/main/harness/pi.ts runs the same
 *  runtime for whole sessions); what lives here is the part that must not be delegated: the
 *  capability allowlist, the risk tiers, and the rule that nothing which changes state runs
 *  before the user approves it.
 *
 *  One step's gated calls become a single proposal the user answers as a batch, and every tool
 *  call reaches this class over the bridge in ./pi-runtime.ts before anything is invoked. */
import { randomUUID } from 'node:crypto';
import type { AgentClientContext, AgentItem, AgentProposal, AgentState } from '../../shared/agent';
import type { AppSettings, HarnessId, ImageAttachment, ModelInfo, SessionMeta } from '../../shared/types';
import { PI_ENV_KEYS } from '../harness/pi';
import { errorMessage, shortId } from '../util/async';
import { contextBlock, systemPrompt } from './context';
import { PiAgentRuntime, type VestaRuntime, type VestaToolCall, type CapabilityOutcome } from './pi-runtime';
import { capabilityFor, piToolDefs, runCapability, summarize, tierOf } from './tools';

/** A proposal nobody answers eventually declines itself rather than pinning the loop open. */
const APPROVAL_TIMEOUT_MS = 15 * 60_000;
/** Gated calls in one batch; a model asking for more than this has lost the plot. */
const MAX_BATCH = 25;
/** Streaming re-renders are batched to this interval. */
const PUSH_INTERVAL_MS = 60;

export interface VestaDeps {
  getSettings(): AppSettings;
  listSessions(): SessionMeta[];
  getSession(id: string): SessionMeta | undefined;
  getSecret(providerId: string): Promise<string | undefined>;
  /** The handler registry, bound late (the registry owns this agent). */
  invoke(channel: string, req: unknown): Promise<unknown>;
  push(state: AgentState): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  /** Resolved pi binary, or null when pi is not installed. */
  piBinary(): string | null;
  /** The bundled capability-bridge extension for pi. */
  piExtension(): string;
  /** Working directory for the assistant's pi process; the focused project when there is one. */
  piCwd(): string;
  /** Test seam: build the runtime for one conversation. */
  createRuntime?(opts: ConstructorParameters<typeof PiAgentRuntime>[0]): VestaRuntime;
}

/** The gated calls of the assistant message being executed, and the decision they share. */
interface StepBatch {
  actions: Map<string, number>;
  proposal: AgentProposal;
  decision: Promise<boolean>;
  settings: AppSettings;
}

export class Vesta {
  private items: AgentItem[] = [];
  private busy = false;
  private runtime: VestaRuntime | null = null;
  /** Settings snapshot for the turn in flight; capabilities are built from it per step. */
  private settings: AppSettings = {} as AppSettings;
  /** The assistant bubble currently streaming. */
  private stepId: string | null = null;
  private stepText = '';
  private batch: StepBatch | null = null;
  /** Calls refused before execution (over a batch limit or malformed arguments). */
  private readonly refused = new Map<string, string>();
  private pending?: { proposal: AgentProposal; decide: (approve: boolean) => void };
  private flushTimer?: ReturnType<typeof setTimeout>;
  /** Memoized pi resolution: `which` touches the filesystem and state() is pushed while streaming. */
  private piPath?: string | null;
  private readonly nonce = randomUUID();

  constructor(private readonly deps: VestaDeps) {}

  state(): AgentState {
    return {
      items: this.items,
      busy: this.busy,
      model: this.runtime?.model,
      unavailable: this.resolvePi() ? undefined : 'pi is not installed. Install it under Settings → Harnesses and Vesta can start.'
    };
  }

  private resolvePi(): string | null {
    if (this.piPath === undefined) this.piPath = this.deps.piBinary();
    return this.piPath;
  }

  reset(): void {
    this.cancel();
    void this.runtime?.dispose().catch(() => undefined);
    this.runtime = null;
    this.items = [];
    this.stepId = null;
    this.stepText = '';
    this.batch = null;
    this.refused.clear();
    this.pushNow();
  }

  /** Answers the running batch's proposal; the waiting tool call then runs or declines. */
  resolveProposal(proposalId: string, approve: boolean): void {
    if (!this.pending || this.pending.proposal.id !== proposalId) return;
    const decide = this.pending.decide;
    this.pending = undefined;
    decide(approve);
  }

  cancel(): void {
    this.runtime?.abort();
    if (this.pending) {
      this.pending.proposal.status = 'cancelled';
      const decide = this.pending.decide;
      this.pending = undefined;
      decide(false);
    }
    this.batch = null;
    this.busy = false;
    this.pushNow();
  }

  /** Stops the pi process; called once when the app quits. */
  async dispose(): Promise<void> {
    await this.runtime?.dispose().catch(() => undefined);
    this.runtime = null;
  }

  async send(text: string, client?: AgentClientContext, images?: ImageAttachment[]): Promise<void> {
    const message = text.trim();
    const attachments = images?.length ? images : undefined;
    if (!message && !attachments) return;
    if (this.busy) {
      this.add({ id: shortId('e'), kind: 'error', text: 'Vesta is still working on the previous message. Stop it first.' });
      return;
    }
    this.add({ id: shortId('u'), kind: 'user', text: message, images: attachments });

    // Re-resolve so pi installed since the last message is picked up without a restart.
    this.piPath = undefined;
    const bin = this.resolvePi();
    if (!bin) {
      this.add({ id: shortId('e'), kind: 'error', text: this.state().unavailable ?? 'pi is not available.' });
      return;
    }
    const settings = this.deps.getSettings();
    this.settings = settings;
    const sessions = this.deps.listSessions();
    const active = client?.sessionId ? this.deps.getSession(client.sessionId) : undefined;
    const prompt = systemPrompt(contextBlock({ settings, sessions, active, client }));
    this.busy = true;
    this.stepId = null;
    this.stepText = '';
    this.batch = null;
    this.refused.clear();
    this.pushNow();

    try {
      const runtime = await this.ensureRuntime(bin, active);
      await runtime.prompt(message, prompt, attachments);
      this.pushNow();
    } catch (error) {
      this.busy = false;
      const detail = errorMessage(error);
      this.deps.log('warn', `vesta turn failed: ${detail}`);
      this.add({ id: shortId('e'), kind: 'error', text: detail });
      this.pushNow();
    }
  }

  /* ---------------------------------------------------------------- */

  private async ensureRuntime(bin: string, active: SessionMeta | undefined): Promise<VestaRuntime> {
    if (this.runtime && !this.runtime.dead) return this.runtime;
    await this.runtime?.dispose().catch(() => undefined);
    // Events from a runtime that has been replaced (reset, crashed child) must not touch the
    // transcript; only the runtime in this.runtime now is allowed to.
    let created: VestaRuntime | null = null;
    const current = (): boolean => this.runtime === created;
    const opts: ConstructorParameters<typeof PiAgentRuntime>[0] = {
      bin,
      extension: this.deps.piExtension(),
      tools: piToolDefs(),
      model: this.settings.agentModel,
      cwd: active?.cwd || this.deps.piCwd(),
      env: await this.piEnv(),
      nonce: this.nonce,
      log: (level, message) => this.deps.log(level, message),
      events: {
        stepStart: () => {
          if (!current()) return;
          this.stepId = shortId('a');
          this.stepText = '';
        },
        text: (delta) => {
          if (!current()) return;
          if (!this.stepId) this.stepId = shortId('a');
          this.stepText += delta;
          this.setAssistant(this.stepId, this.stepText);
        },
        stepEnd: (text, calls) => {
          if (!current()) return;
          this.finishStep(text, calls);
        },
        settled: (error) => {
          if (!current()) return;
          this.busy = false;
          this.batch = null;
          if (error) this.add({ id: shortId('e'), kind: 'error', text: error });
          this.pushNow();
        },
        exited: (detail) => {
          if (!current()) return;
          this.runtime = null;
          if (this.busy || this.pending) {
            this.busy = false;
            this.batch = null;
            this.add({ id: shortId('e'), kind: 'error', text: detail });
            this.pushNow();
          }
        },
        run: (call) => (current() ? this.runCall(call) : Promise.resolve({ ok: false, detail: 'Stopped.' }))
      }
    };
    created = (this.deps.createRuntime ?? ((o) => new PiAgentRuntime(o)))(opts);
    this.runtime = created;
    return created;
  }

  /** Provider credentials pi should inherit, so Vesta works from the same keychain. */
  private async piEnv(): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = {};
    for (const [providerId, envKey] of Object.entries(PI_ENV_KEYS)) {
      if (process.env[envKey]) continue;
      const value = await this.deps.getSecret(providerId);
      if (value) env[envKey] = value;
    }
    return env;
  }

  /** Settles the assistant bubble and, for gated calls, opens the batch the user reviews. */
  private finishStep(text: string, calls: VestaToolCall[]): void {
    const id = this.stepId;
    this.stepId = null;
    this.stepText = '';
    if (id) {
      if (text.trim()) this.setAssistant(id, text);
      else this.remove(id);
    }
    if (!calls.length) {
      if (!text.trim()) this.add({ id: shortId('e'), kind: 'error', text: `${this.runtime?.model ?? 'pi'} returned an empty reply.` });
      return;
    }
    const planned = calls.map((call) => {
      const cap = capabilityFor(call.name);
      const badArgs = !!call.args && typeof call.args === 'object' && '__parseError' in call.args;
      return { call, cap, badArgs, tier: cap && !badArgs ? tierOf(cap, call.args) : ('read' as const) };
    });
    const gated = planned.filter((p) => p.cap && !p.badArgs && p.tier !== 'read');
    if (!gated.length) return;
    if (gated.length > MAX_BATCH) {
      for (const p of gated) this.refused.set(p.call.id, 'Declined: too many changes were requested at once. Propose them in smaller batches.');
      return;
    }
    const destructive = gated.some((p) => p.tier === 'destructive');
    const proposal: AgentProposal = {
      id: shortId('p'),
      tier: destructive ? 'destructive' : 'write',
      title: gated.length === 1 ? summarize(gated[0].cap!, gated[0].call.args) : `${gated.length} changes`,
      actions: gated.map((p) => ({ capability: p.cap!.name, summary: summarize(p.cap!, p.call.args), args: p.call.args })),
      status: 'pending'
    };
    const actions = new Map(gated.map((p, i) => [p.call.id, i]));
    this.add({ id: shortId('i'), kind: 'proposal', proposal });
    const decision = this.awaitDecision(proposal).then((approved) => {
      if (approved) proposal.status = 'applied';
      else if (proposal.status === 'pending') proposal.status = 'rejected';
      proposal.results = proposal.actions.map(() => undefined as unknown as string);
      this.pushNow();
      return approved;
    });
    this.batch = { actions, proposal, decision, settings: this.settings };
  }

  /** Runs one capability after the gate has decided; the model gets the outcome as its tool result. */
  private async runCall(call: VestaToolCall): Promise<CapabilityOutcome> {
    const cap = capabilityFor(call.name);
    if (!cap) {
      this.deps.log('warn', `vesta asked for an unknown tool: ${call.name}`);
      return { ok: false, detail: `Unknown tool "${call.name}". Use only the tools you were given.` };
    }
    const refused = this.refused.get(call.id);
    if (refused) {
      this.refused.delete(call.id);
      return { ok: false, detail: refused };
    }
    if (!!call.args && typeof call.args === 'object' && '__parseError' in call.args) return { ok: false, detail: 'Arguments were not valid JSON. Send them again.' };

    const batch = this.batch;
    const gated = tierOf(cap, call.args) !== 'read';
    let proposal: AgentProposal | undefined;
    let actionIndex: number | undefined;
    if (gated) {
      if (batch && batch.actions.has(call.id)) {
        proposal = batch.proposal;
        actionIndex = batch.actions.get(call.id);
        const approved = await batch.decision;
        if (!approved) {
          this.pushNow();
          return { ok: false, detail: 'The user declined this action.' };
        }
      } else {
        // A gated call the step never announced (a stale bridge request); ask about it alone.
        proposal = {
          id: shortId('p'),
          tier: tierOf(cap, call.args) === 'destructive' ? 'destructive' : 'write',
          title: summarize(cap, call.args),
          actions: [{ capability: cap.name, summary: summarize(cap, call.args), args: call.args }],
          status: 'pending'
        };
        this.add({ id: shortId('i'), kind: 'proposal', proposal });
        const approved = await this.awaitDecision(proposal);
        if (approved) proposal.status = 'applied';
        else if (proposal.status === 'pending') proposal.status = 'rejected';
        proposal.results = [];
        this.pushNow();
        if (!approved) return { ok: false, detail: 'The user declined this action.' };
        actionIndex = 0;
        this.batch = { actions: new Map([[call.id, 0]]), proposal, decision: Promise.resolve(true), settings: batch?.settings ?? this.settings };
      }
    }

    const settings = batch?.settings ?? this.settings;
    const outcome = await runCapability(cap, call.args, { settings, models: (harness) => this.listModels(harness) }, this.deps.invoke);
    if (proposal && actionIndex !== undefined && proposal.results) {
      proposal.results[actionIndex] = outcome.ok ? 'Done' : outcome.detail;
      if (!outcome.ok) proposal.status = 'failed';
    } else if (!gated) {
      this.add({ id: shortId('t'), kind: 'tool', capability: cap.name, summary: summarize(cap, call.args), ok: outcome.ok, detail: outcome.ok ? undefined : outcome.detail });
    }
    this.pushNow();
    return outcome;
  }

  /** The harness's catalog for a capability to check an argument against; the same reply the New Session dialog gets. */
  private async listModels(harness: HarnessId): Promise<{ models: ModelInfo[]; error?: string }> {
    try {
      const raw = (await this.deps.invoke('harness:models', { harness })) as { models?: unknown; error?: string } | undefined;
      return { models: Array.isArray(raw?.models) ? (raw.models as ModelInfo[]) : [], error: raw?.error };
    } catch (e) {
      return { models: [], error: errorMessage(e) };
    }
  }

  private awaitDecision(proposal: AgentProposal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending?.proposal.id === proposal.id) {
          this.pending = undefined;
          resolve(false);
        }
      }, APPROVAL_TIMEOUT_MS);
      this.pending = {
        proposal,
        decide: (approve) => {
          clearTimeout(timer);
          resolve(approve);
        }
      };
    });
  }

  private add(item: AgentItem): void {
    this.items = [...this.items, item];
    this.pushNow();
  }

  private remove(id: string): void {
    if (!this.items.some((i) => i.id === id)) return;
    this.items = this.items.filter((i) => i.id !== id);
    this.pushNow();
  }

  private setAssistant(id: string, text: string): void {
    const idx = this.items.findIndex((i) => i.id === id);
    const item: AgentItem = { id, kind: 'assistant', text };
    this.items = idx >= 0 ? this.items.map((i, n) => (n === idx ? item : i)) : [...this.items, item];
    this.schedulePush();
  }

  private schedulePush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.deps.push(this.state());
    }, PUSH_INTERVAL_MS);
  }

  private pushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.deps.push(this.state());
  }
}
