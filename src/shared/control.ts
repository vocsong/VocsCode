/** Narrow, versioned automation API. Never accept an IPC channel, filesystem path or approval decision. */
import { z } from 'zod';

export const CONTROL_VERSION = 1;
export const CONTROL_MAX_BYTES = 256 * 1024;
export const CONTROL_SCOPES = ['control:discover', 'control:read', 'control:create', 'control:send', 'control:interrupt'] as const;
export type ControlScope = typeof CONTROL_SCOPES[number];
export const controlScopeSchema = z.enum(CONTROL_SCOPES);
export const controlIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
export const controlPrincipalSchema = z.strictObject({
  accountId: z.string().regex(/^(vocs-v1|github:[1-9]\d{0,19})$/),
  controllerId: z.string().uuid(),
  scopes: z.array(controlScopeSchema).max(CONTROL_SCOPES.length),
  /** Short-lived gateway attestation deadline, never caller-selected or renewed by the desktop. */
  validUntil: z.number().int().positive(),
});
export type ControllerPrincipal = z.infer<typeof controlPrincipalSchema>;
const target = { instanceId: z.string().uuid() };
const project = { ...target, projectId: controlIdSchema };
const session = { ...project, sessionId: controlIdSchema };
const intent = { admissionWindowId: z.string().uuid(), idempotencyKey: z.string().min(1).max(200) };
const page = { offset: z.number().int().min(0).max(1_000_000).default(0), limit: z.number().int().min(1).max(100).default(50) };
export const controlParams = {
  'capabilities': z.strictObject({}),
  'projects.list': z.strictObject({ ...target, ...page }),
  'sessions.list': z.strictObject({ ...project, ...page }),
  'sessions.get': z.strictObject(session),
  'sessions.transcript': z.strictObject({ ...session, ...page }),
  'windows.create': z.strictObject(target),
  'sessions.create': z.strictObject({ ...project, ...intent, title: z.string().trim().min(1).max(160).optional() }),
  'sessions.send': z.strictObject({ ...session, ...intent, text: z.string().min(1).max(100_000).refine((text) => !!text.trim()) }),
  'operations.get': z.strictObject({ ...target, operationId: z.string().uuid() }),
  'operations.interrupt': z.strictObject({ ...target, operationId: z.string().uuid() }),
} as const;
export type ControlMethod = keyof typeof controlParams;
export const controlRequestSchema = z.strictObject({ method: z.enum(Object.keys(controlParams) as [ControlMethod, ...ControlMethod[]]), params: z.unknown() });
export interface ControlRequest { method: ControlMethod; params: unknown }
export const CONTROL_REQUIRED_SCOPE: Record<ControlMethod, ControlScope> = {
  capabilities: 'control:discover', 'projects.list': 'control:discover', 'sessions.list': 'control:discover',
  'sessions.get': 'control:discover', 'sessions.transcript': 'control:read', 'windows.create': 'control:discover',
  'sessions.create': 'control:create', 'sessions.send': 'control:send', 'operations.get': 'control:discover',
  'operations.interrupt': 'control:interrupt',
};
export type ControlErrorCode = 'invalid_request' | 'denied' | 'unavailable' | 'busy' | 'conflict' | 'expired' | 'storage_unavailable' | 'unknown';
export class ControlError extends Error {
  constructor(readonly code: ControlErrorCode) { super(code); }
}
export function controlErrorCode(error: unknown): ControlErrorCode {
  return error instanceof ControlError ? error.code : error instanceof z.ZodError ? 'invalid_request' : 'unknown';
}
export interface ControlOperation {
  id: string;
  controllerId: string;
  accountId: string;
  instanceId: string;
  projectId: string;
  sessionId?: string;
  method: 'sessions.create' | 'sessions.send';
  admissionWindowId: string;
  idempotencyKey: string;
  payloadHash: string;
  state: 'accepted' | 'dispatched' | 'succeeded' | 'failed' | 'interrupted' | 'unknown';
  inputId?: string;
  runtimeId?: string;
  turnId?: string;
  outputIds?: string[];
  createdAt: number;
  updatedAt: number;
}
export interface ControlProject { id: string; root: string; canonicalRoot: string; name: string }
export interface ControlGrant {
  id: string;
  accountId: string;
  controllerId: string;
  name: string;
  projectIds: string[];
  scopes: ControlScope[];
  permissionModes: Array<'ask' | 'accept-edits' | 'plan' | 'auto' | 'full-auto'>;
  harnesses: Array<'claude' | 'codex' | 'codex-exec' | 'cursor' | 'pi' | 'acp' | 'native'>;
  expiresAt: number;
  revokedAt?: number;
}
/** Owner-only input. The service resolves paths from already-known folders, never from automation. */
export const controlGrantInputSchema = z.strictObject({
  accountId: controlPrincipalSchema.shape.accountId, controllerId: z.string().uuid(),
  name: z.string().trim().min(1).max(100), projectIds: z.array(controlIdSchema).min(1).max(100),
  scopes: z.array(controlScopeSchema).min(1).max(CONTROL_SCOPES.length),
  permissionModes: z.array(z.enum(['ask', 'accept-edits', 'plan', 'auto', 'full-auto'])).min(1).max(5),
  harnesses: z.array(z.enum(['claude', 'codex', 'codex-exec', 'cursor', 'pi', 'acp', 'native'])).min(1).max(7),
  expiresAt: z.number().int().positive(),
});
export type ControlGrantInput = z.infer<typeof controlGrantInputSchema>;
export interface ControlOwnerState { instanceId: string; enabled: boolean; projects: ControlProject[]; grants: ControlGrant[] }
export interface ControlReply { ok: boolean; result?: unknown; error?: ControlErrorCode }
export const controlHostRequestSchema = z.strictObject({
  t: z.literal('control.request'), id: z.string().uuid(), hostId: z.string().min(1).max(256),
  principal: controlPrincipalSchema, request: controlRequestSchema, expiresAt: z.number().int(),
});
