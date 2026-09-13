/** Pi 0.85.1 compatibility shims. The running Pi supplies all execution code. */
import { prepareToolArguments, TOOL_GUIDELINES, type CompatibleTool } from './tool-arguments';

// Structural boundaries keep this external resource independent of the desktop's dependencies.
interface Context {
  cwd: string;
  isProjectTrusted(): boolean;
  ui: { notify(message: string, type?: string): void };
}
interface Definition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  promptGuidelines?: string[];
  prepareArguments?: (args: unknown) => unknown;
  execute: (...args: unknown[]) => unknown;
  [key: string]: unknown;
}
interface Pi {
  registerTool(definition: Definition): void;
  getAllTools(): { name: string; description: string; parameters: unknown }[];
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  on(event: string, handler: (event: Record<string, unknown>, ctx: Context) => unknown): void;
}
interface Settings {
  getImageAutoResize(): boolean;
  getShellCommandPrefix(): string | undefined;
  getShellPath(): string | undefined;
}
interface Sdk {
  getAgentDir(): string;
  SettingsManager: { create(cwd: string, agentDir: string, options: { projectTrusted: boolean }): Settings };
  createReadToolDefinition(cwd: string, options: { autoResizeImages: boolean }): Definition;
  createWriteToolDefinition(cwd: string): Definition;
  createEditToolDefinition(cwd: string): Definition;
  createBashToolDefinition(cwd: string, options: { commandPrefix?: string; shellPath?: string }): Definition;
}
const NAMES: CompatibleTool[] = ['read', 'write', 'edit', 'bash'];
const READY = 'VCODE_PI_READY::';
const ERROR = 'VCODE_PI_ERROR::';
const INPUT = 'VCODE_PI_TOOL_INPUT::';

export default async function vocsCodeTools(pi: Pi): Promise<void> {
  // Jiti resolves this bare public export against the running Pi, including bundled CLIs.
  const packageName = '@earendil-works/pi-coding-agent';
  const sdk = await import(packageName) as unknown as Sdk;
  const incompatible = (detail: string) => new Error(`Incompatible Pi runtime: Vocs Code tool compatibility requires Pi 0.85.1 APIs. ${detail}`);
  for (const name of ['createReadToolDefinition', 'createWriteToolDefinition', 'createEditToolDefinition', 'createBashToolDefinition', 'getAgentDir'] as const) {
    if (typeof sdk[name] !== 'function') throw incompatible(`Missing ${name}; update Pi.`);
  }
  if (typeof sdk.SettingsManager?.create !== 'function') throw incompatible('Missing SettingsManager.create; update Pi.');
  let definitions = new Map<string, Definition>();
  let ready = false;
  const notify = (ctx: Context, marker: string, payload: Record<string, unknown>) => {
    ctx.ui.notify(marker + JSON.stringify({ version: 1, nonce: process.env.VOCS_CODE_PI_NONCE, ...payload }), 'info');
  };
  const verify = () => {
    if (!ready) throw incompatible('Tool overrides are not ready.');
    const actual = pi.getAllTools();
    for (const [name, expected] of definitions) {
      const registered = actual.find((tool) => tool.name === name);
      // Public metadata reflects the winning definition. A competing extension must not win silently.
      if (!registered || registered.parameters !== expected.parameters || registered.description !== expected.description) {
        throw incompatible(`Another extension replaced ${name}. Disable the conflicting tool override.`);
      }
    }
  };
  const fail = (ctx: Context, error: unknown) => {
    ready = false;
    const message = error instanceof Error ? error.message : String(error);
    notify(ctx, ERROR, { capability: 'tools', message });
    return message;
  };
  pi.on('session_start', (_event, ctx) => {
    try {
      ready = false;
      if (typeof ctx.isProjectTrusted !== 'function') throw incompatible('Missing project trust context; update Pi.');
      const settings = sdk.SettingsManager.create(ctx.cwd, sdk.getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
      const available = new Set(pi.getAllTools().map((tool) => tool.name));
      const active = pi.getActiveTools();
      const builtins: Record<CompatibleTool, Definition> = {
        read: sdk.createReadToolDefinition(ctx.cwd, { autoResizeImages: settings.getImageAutoResize() }),
        write: sdk.createWriteToolDefinition(ctx.cwd),
        edit: sdk.createEditToolDefinition(ctx.cwd),
        bash: sdk.createBashToolDefinition(ctx.cwd, { commandPrefix: settings.getShellCommandPrefix(), shellPath: settings.getShellPath() }),
      };
      if (typeof builtins.edit.prepareArguments !== 'function') throw incompatible('Missing edit argument preparation; update Pi.');
      definitions = new Map();
      for (const name of NAMES) {
        // Do not resurrect --exclude-tools / --tools filtered names.
        if (!available.has(name)) continue;
        const original = builtins[name];
        if (original.name !== name || typeof original.execute !== 'function' || !original.parameters || typeof original.parameters !== 'object') {
          throw incompatible(`Invalid ${name} definition; update Pi.`);
        }
        const definition: Definition = {
          ...original,
          parameters: { ...original.parameters },
          description: `${original.description}\n${TOOL_GUIDELINES[name]}`,
          promptGuidelines: [...(original.promptGuidelines ?? []), TOOL_GUIDELINES[name]],
          prepareArguments(args) {
            const prepared = prepareToolArguments(name, args);
            return original.prepareArguments ? original.prepareArguments(prepared) : prepared;
          },
        };
        definitions.set(name, definition);
        pi.registerTool(definition);
      }
      // Register only after Pi has established its initial active set; preserve defaultTools/--no-tools.
      pi.setActiveTools(active);
      ready = true;
      verify();
      notify(ctx, READY, { capability: 'tools', tools: [...definitions.keys()] });
    } catch (error) {
      fail(ctx, error);
      throw error;
    }
  });
  pi.on('before_agent_start', (_event, ctx) => {
    try { verify(); } catch (error) { fail(ctx, error); }
  });
  pi.on('tool_call', (event, ctx) => {
    try { verify(); } catch (error) { return { block: true, reason: fail(ctx, error) }; }
    if (typeof event.toolName === 'string' && definitions.has(event.toolName)) {
      // This is validated, normalized input, not model prose. Never feed it back into execution.
      notify(ctx, INPUT, { toolCallId: event.toolCallId, toolName: event.toolName, input: event.input });
    }
    return undefined;
  });
  pi.on('session_shutdown', (_event, ctx) => {
    ready = false;
    definitions.clear();
    notify(ctx, READY, { capability: 'tools', ready: false });
  });
}
