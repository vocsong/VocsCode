/** The adapter contract every harness implements, plus the dangerous-command patterns they all gate on. */
import type {
  ApprovalDecision,
  ApprovalRequest,
  AppSettings,
  EffortLevel,
  HarnessId,
  HarnessRef,
  ModelInfo,
  ModelRef,
  PermissionMode,
  SessionEvent,
  SessionMeta,
  UserInput
} from '../../shared/types';
import type { RuntimeResolver } from '../runtime';
import type { ResolvedServer } from '../mcp/effective';

export type ApprovalDraft = Omit<ApprovalRequest, 'id' | 'sessionId' | 'harness' | 'createdAt'>;

/** Everything an adapter needs from the host. No Electron types so adapters stay testable in Node. */
export interface HarnessContext {
  readonly sessionId: string;
  /** Live snapshot of the session metadata (read-only for adapters). */
  session(): SessionMeta;
  settings(): AppSettings;
  runtime: RuntimeResolver;
  /** Per-session scratch/storage directory. */
  sessionDir: string;
  permissionMode(): PermissionMode;
  effort(): EffortLevel | undefined;
  getApiKey(providerId: string): Promise<string | undefined>;
  /**
   * The MCP servers this session should be started with: the global list merged with the repo's
   * `.mcp.json` under the user's per-repo switches, `${VAR}` references resolved and stdio
   * commands normalized for the platform. Empty for a harness that cannot take them.
   */
  mcpServers(): Promise<ResolvedServer[]>;
  emit(event: SessionEvent): void;
  requestApproval(draft: ApprovalDraft): Promise<ApprovalDecision>;
  updateRef(patch: Partial<HarnessRef>): void;
  updateMeta(patch: Partial<Pick<SessionMeta, 'activeModel' | 'activeEffort' | 'title' | 'queued' | 'statusDetail'>>): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
  readJson<T>(name: string): Promise<T | null>;
  writeJson(name: string, data: unknown): Promise<void>;
}

export interface HarnessAdapter {
  readonly id: HarnessId;
  /** True while a turn is in progress. */
  readonly busy: boolean;
  start(): Promise<void>;
  /** Submit user input. Resolves once accepted by the harness (not when the turn finishes). */
  send(input: UserInput): Promise<void>;
  interrupt(): Promise<void>;
  setModel(model: ModelRef): Promise<void>;
  setEffort(effort: EffortLevel): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** False means the adapter accepted the request but had too little context to reduce. */
  compact?(): Promise<boolean | void>;
  listModels?(): Promise<ModelInfo[]>;
  dispose(): Promise<void>;
}

export interface HarnessFactory {
  id: HarnessId;
  create(ctx: HarnessContext): HarnessAdapter;
}

// Best-effort detection of obviously destructive shell commands; not exhaustive.
// Verbatim copy kept in resources/pi/vocs-code-approvals.ts — keep the two in sync.
export const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  // rm: recursive + force flags in any arrangement, including shell-quoted flags
  /\brm\s+(?=(?:(?:"[^"]*"|'[^']*'|-\S+)\s+)*(?:"-[a-z]*r[a-z]*"|'-[a-z]*r[a-z]*'|"--recursive"|'--recursive'|-[a-z]*r[a-z]*\b|--recursive\b))(?=(?:(?:"[^"]*"|'[^']*'|-\S+)\s+)*(?:"-[a-z]*f[a-z]*"|'-[a-z]*f[a-z]*'|"--force"|'--force'|-[a-z]*f[a-z]*\b|--force\b))/i,
  /\brm\s+(?:(?:-\S+|"-{1,2}[a-zA-Z-]+"|'-{1,2}[a-zA-Z-]+')\s+)*(?:"-[a-z]*r[a-z]*"|'-[a-z]*r[a-z]*'|"--recursive"|'--recursive'|-[a-z]*r[a-z]*\b)(?:\s+-\S+|\s+"-{1,2}[a-zA-Z-]+"|\s+'-{1,2}[a-zA-Z-]+')*\s+["']?[\/~]/i,
  // dd reading from or writing to a device node
  /\bmkfs\b|\bdd\s+(?:\S+\s+)*(?:if|of)=\/dev\//i,
  // chmod 777 with a recursive flag, in any order
  /\bchmod\s+(?=(?:\S+\s+)*(?:-[a-z]*r[a-z]*\b|--recursive\b))(?=(?:\S+\s+)*777)/i,
  // git force-push: --force, --force-with-lease, -f or a +-prefixed refspec, allowing global git options before push
  /\bgit(?:\s+-{1,2}\S+(?:\s+"[^"]*"|\s+\S+)?)*\s+push\b(?=\s)[^|;&]*?(?:--force(?:-with-lease)?\b|\s-f\b|\s\+\S)/i,
  /\bgit\s+reset\s+--hard\b/i,
  // any -f-containing flag cluster in any position
  /\bgit\s+clean\s+(?:-\S+\s+)*-[a-z]*f/i,
  /\bgit\s+checkout\s+--\s+\./i,
  /\b(shutdown|reboot|halt)\b/i,
  /\bformat(?:\.com)?\s+[a-z]:/i,
  // Windows del/rd/rmdir with recursive-quiet flags in any order
  /\bdel\s+(?:\/[a-z]+\s+)*\/[sq]/i,
  /\b(?:rd|rmdir)\s+(?:\/[a-z]+\s+)*\/s/i,
  // Remove-Item and its aliases with a recurse flag
  /\b(?:remove-item|ri)\s+(?:\S+\s+)*(?:-recurse\b|-[a-z]*r\b)/i,
  /\bnpm\s+publish\b|\bpnpm\s+publish\b|\byarn\s+publish\b/i,
  // Downloaded or decoded payloads piped directly into a shell
  /\b(?:curl|wget|base64)\b[^|;&\r\n]*\|\s*(?:ba)?sh\b/i,
  // PowerShell's download-and-evaluate aliases, including its pipeline form
  /\b(?:iex|invoke-expression)\s*(?:\(\s*)?(?:iwr|invoke-webrequest|irm|invoke-restmethod)\b/i,
  /\b(?:iwr|invoke-webrequest|irm|invoke-restmethod|curl|wget)\b[^|;&\r\n]*\|\s*(?:iex|invoke-expression)\b/i,
  /\b(?:sudo|doas|pkexec)\b/i,
  /(?:^|[|;&]\s*)\bsu(?:\s+(?!--?(?:help|version|h)\b)\S+|\s*$)/i,
  // arbitrary encoded payloads
  /\b(?:powershell|pwsh)(?:\.exe)?\s+(?:\S+\s+)*(?:-encodedcommand\b|-enc\b|-e\b)/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/
];

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND_PATTERNS.some((re) => re.test(command));
}
