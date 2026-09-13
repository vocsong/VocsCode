/** Actual installed Pi CLI, isolated credentials/settings, scripted model, real dispatch. */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { LineSplitter } from '../src/main/util/async';
import { shutdownChild } from '../src/main/harness/spawn';

// RPC is a versioned external boundary; tests assert the concrete event shapes below.
export type PiEvent = Record<string, any>;
export interface ScriptedCall { id: string; name: string; arguments: Record<string, unknown> }

export function piIntegrationPaths(): { cli: string; resources: string } {
  const packageDir = process.env.VOCS_CODE_PI_PACKAGE_DIR ?? path.join(process.env.APPDATA ?? path.join(homedir(), '.config'), 'Vocs Code', 'runtime', 'node_modules', '@earendil-works', 'pi-coding-agent');
  const manifestPath = path.join(packageDir, 'package.json');
  if (!existsSync(manifestPath)) throw new Error(`Selected Pi integration runtime is unavailable: ${manifestPath}. Set VOCS_CODE_PI_PACKAGE_DIR to an installed @earendil-works/pi-coding-agent directory.`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== '0.85.1') throw new Error(`Pi integration requires the inspected 0.85.1 runtime, found ${manifest.version}.`);
  const cli = path.join(packageDir, manifest.bin.pi);
  if (!existsSync(cli)) throw new Error(`Pi CLI is unavailable: ${cli}`);
  const resources = path.resolve(process.env.VOCS_CODE_PI_RESOURCES_DIR ?? 'resources/pi');
  for (const file of ['vocs-code-tools.ts', 'tool-arguments.ts', 'vocs-code-approvals.ts']) {
    if (!existsSync(path.join(resources, file))) throw new Error(`Pi resource is unavailable: ${path.join(resources, file)}`);
  }
  return { cli, resources };
}

export class PiOfflineRunner {
  readonly events: PiEvent[] = [];
  readonly child: ChildProcess;
  stderr = '';
  private counter = 0;
  private waiters = new Set<{ match: (event: PiEvent) => boolean; resolve: (event: PiEvent) => void; reject: (error: Error) => void }>();
  private ended = false;

  constructor(options: { cwd: string; agentDir: string; mode?: string; extraArgs?: string[]; modeFile?: string; competing?: boolean; choice?: (payload: PiEvent) => string }) {
    const { cli, resources } = piIntegrationPaths();
    const fixture = path.resolve('tests/fixtures/pi-scripted-provider.mjs');
    const args = [cli, '--mode', 'rpc', '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-approve',
      '-e', path.join(resources, 'vocs-code-approvals.ts'),
      ...(options.competing ? ['-e', fixture] : []),
      '-e', path.join(resources, 'vocs-code-tools.ts'),
      ...(!options.competing ? ['-e', fixture] : []),
      '--provider', 'vocs-offline', '--model', 'scripted', '--thinking', 'off', ...(options.extraArgs ?? ['--no-session'])];
    this.child = spawn(process.execPath, args, {
      cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, PI_CODING_AGENT_DIR: options.agentDir, PI_OFFLINE: '1', PI_TELEMETRY: '0',
        VOCS_CODE_PI_NONCE: 'offline-process', VOCS_CODE_PERMISSION_MODE: options.mode ?? 'full-auto',
        VOCS_CODE_MODE_FILE: options.modeFile ?? '', VOCS_CODE_PI_COMPETING_TOOL: options.competing ? '1' : '0' },
    });
    this.child.stderr?.on('data', (data: Buffer) => { this.stderr += data.toString(); });
    this.child.stdout?.on('data', (data: Buffer) => splitter.push(data));
    this.child.on('error', (error) => this.rejectAll(error));
    this.child.on('close', (code) => {
      this.ended = true;
      this.rejectAll(new Error(`Pi exited (${code}): ${this.stderr}`));
    });
    const splitter = new LineSplitter((line) => {
      let event: PiEvent;
      try { event = JSON.parse(line); } catch { this.stderr += line + '\n'; return; }
      this.events.push(event);
      for (const waiter of [...this.waiters]) if (waiter.match(event)) waiter.resolve(event);
      if (event.type === 'extension_ui_request' && event.method === 'select' && event.title?.startsWith('VCODE_APPROVAL::')) {
        const payload = JSON.parse(event.title.slice('VCODE_APPROVAL::'.length));
        this.send({ type: 'extension_ui_response', id: event.id, value: options.choice?.(payload) ?? 'Deny' });
      }
    });
  }
  private rejectAll(error: Error): void { for (const waiter of [...this.waiters]) waiter.reject(error); }
  send(command: PiEvent): void { this.child.stdin!.write(JSON.stringify(command) + '\n'); }
  waitFor(match: (event: PiEvent) => boolean, from = this.events.length, timeout = 30000): Promise<PiEvent> {
    const found = this.events.slice(from).find(match);
    if (found) return Promise.resolve(found);
    if (this.ended) return Promise.reject(new Error(`Pi already exited: ${this.stderr}`));
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.waiters.delete(waiter); };
      const waiter = { match, resolve: (event: PiEvent) => { cleanup(); resolve(event); }, reject: (error: Error) => { cleanup(); reject(error); } };
      const timer = setTimeout(() => waiter.reject(new Error(`Pi RPC timed out: ${this.stderr}\n${JSON.stringify(this.events.slice(-4))}`)), timeout);
      this.waiters.add(waiter);
    });
  }
  async request(type: string, fields: PiEvent = {}): Promise<PiEvent> {
    const id = `r${++this.counter}`;
    const answer = this.waitFor((event) => event.type === 'response' && event.id === id);
    this.send({ type, id, ...fields });
    const response = await answer;
    if (!response.success) throw new Error(response.error ?? `${type} failed`);
    return response.data ?? {};
  }
  async ready(): Promise<PiEvent> {
    const state = await this.request('get_state');
    const capabilities = this.events.filter((event) => event.type === 'extension_ui_request' && event.method === 'notify' && event.message?.startsWith('VCODE_PI_READY::'))
      .map((event) => JSON.parse(event.message.slice('VCODE_PI_READY::'.length)));
    for (const capability of ['approvals', 'tools']) {
      if (!capabilities.some((entry) => entry.version === 1 && entry.nonce === 'offline-process' && entry.capability === capability && entry.ready !== false)) {
        throw new Error(`Missing ${capability} readiness: ${this.stderr}\n${JSON.stringify(this.events)}`);
      }
    }
    return state;
  }
  async prompt(calls: ScriptedCall[]): Promise<PiEvent[]> {
    const from = this.events.length;
    await this.request('prompt', { message: JSON.stringify({ calls }) });
    await this.waitFor((event) => event.type === 'agent_settled', from);
    return this.events.slice(from);
  }
  async close(): Promise<void> { await shutdownChild(this.child, 1500); }
}
