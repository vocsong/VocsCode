/** Turns Vesta's capability allowlist into tool definitions, and runs one call against the
 *  handler registry. Anything not on the allowlist fails here rather than reaching a handler. */
import { AGENT_CAPABILITIES, CAPABILITIES_BY_NAME, type AgentCapability, type CapabilityContext } from '../../shared/agent-manifest';
import type { RiskTier } from '../../shared/agent';
import { errorMessage, truncate } from '../util/async';

/** How much of a tool result the model sees; enough for a branch list, not enough to blow the context. */
const RESULT_CHARS = 8000;

/** The manifest as plain JSON-schema definitions for pi's capability bridge extension. */
export function piToolDefs(): { name: string; description: string; parameters: Record<string, unknown> }[] {
  return AGENT_CAPABILITIES.map((c) => ({ name: c.name, description: c.description, parameters: c.parameters }));
}

export function capabilityFor(name: string): AgentCapability | undefined {
  return CAPABILITIES_BY_NAME.get(name);
}

export function tierOf(cap: AgentCapability, args: Record<string, unknown>): RiskTier {
  try {
    return cap.tier(args);
  } catch {
    // A malformed argument object must not be treated as harmless.
    return 'destructive';
  }
}

export function summarize(cap: AgentCapability, args: Record<string, unknown>): string {
  try {
    return cap.summarize(args);
  } catch {
    return cap.name;
  }
}

export interface CapabilityOutcome {
  ok: boolean;
  /** What the model sees as the tool result. */
  detail: string;
}

/** Invokes one capability's channel. Never throws: a failure is a tool result the model can react to. */
export async function runCapability(
  cap: AgentCapability,
  args: Record<string, unknown>,
  ctx: CapabilityContext,
  invoke: (channel: string, req: unknown) => Promise<unknown>
): Promise<CapabilityOutcome> {
  let request: unknown;
  try {
    request = await cap.request(args, ctx);
  } catch (e) {
    return { ok: false, detail: `Invalid arguments: ${errorMessage(e)}` };
  }
  try {
    const raw = await invoke(cap.channel, request);
    const value = cap.project ? cap.project(raw) : raw;
    return { ok: true, detail: truncate(value === undefined ? 'done' : JSON.stringify(value), RESULT_CHARS) };
  } catch (e) {
    return { ok: false, detail: `Failed: ${errorMessage(e)}` };
  }
}
