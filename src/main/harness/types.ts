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
  compact?(): Promise<void>;
  listModels?(): Promise<ModelInfo[]>;
  dispose(): Promise<void>;
}

export interface HarnessFactory {
  id: HarnessId;
  create(ctx: HarnessContext): HarnessAdapter;
}

export const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i,
  /\brm\s+-rf?\s+[\/~]/i,
  /\bgit\s+push\b.*(--force|-f)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+checkout\s+--\s+\./i,
  /\bmkfs\b|\bdd\s+if=/i,
  /\b(shutdown|reboot|halt)\b/i,
  /\bformat\s+[a-z]:/i,
  /\bdel\s+\/[sq]/i,
  /\bRemove-Item\b.*-Recurse/i,
  /\bnpm\s+publish\b|\bpnpm\s+publish\b|\byarn\s+publish\b/i,
  /\bcurl\b.*\|\s*(ba)?sh\b/i,
  /\bchmod\s+-R\s+777\b/i,
  /\b(sudo|doas)\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/
];

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND_PATTERNS.some((re) => re.test(command));
}
