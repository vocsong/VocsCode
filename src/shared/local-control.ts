/** Separate local wire, with no cloud principal or grant-management methods. */
import { z } from 'zod';

export const LOCAL_CONTROL_VERSION = 1;
export const LOCAL_CONTROL_REQUEST_BYTES = 8192;
export const LOCAL_CONTROL_REPLY_BYTES = 256 * 1024;
export const LOCAL_CONTROL_METHODS = ['capabilities', 'projects.list', 'sessions.list'] as const;

const profileId = z.string().regex(/^[a-f0-9]{64}$/);
const instanceId = z.uuid();
const target = { v: z.literal(LOCAL_CONTROL_VERSION), profileId, instanceId };
const targetSchema = z.strictObject({
  ...target,
  pipeName: z.string().regex(/^vocs-code-local-[a-f0-9]{32}$/),
  pid: z.number().int().min(1).max(0xffffffff),
  started: z.string().regex(/^[1-9]\d{0,18}$/),
});
export type LocalControlTarget = z.infer<typeof targetSchema>;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function encodeLocalControlTarget(value: LocalControlTarget): string {
  return `v1.${base64url(new TextEncoder().encode(JSON.stringify(targetSchema.parse(value))))}`;
}

/** Copy from the intended desktop's owner panel. This describes a peer; it isn't a password. */
export function decodeLocalControlTarget(value: string): LocalControlTarget {
  if (value.length > 1024 || !/^v1\.[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid local target.');
  const encoded = value.slice(3);
  const bytes = Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/')), (byte) => byte.charCodeAt(0));
  if (base64url(bytes) !== encoded) throw new Error('Invalid local target.');
  return targetSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}

export const localControlRequestSchema = z.strictObject({
  ...target,
  request: z.strictObject({ method: z.enum(LOCAL_CONTROL_METHODS), params: z.unknown() }),
});
export const localControlReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), result: z.record(z.string(), z.unknown()) }),
  z.strictObject({ ok: z.literal(false), error: z.enum([
    'invalid_request', 'denied', 'unavailable', 'busy', 'conflict', 'expired', 'storage_unavailable', 'unknown', 'incompatible',
  ]) }),
]);
export type LocalControlReply = z.infer<typeof localControlReplySchema>;
export interface LocalControlOwnerState {
  supported: boolean;
  projects: Array<{ id: string; root: string; name: string }>;
  approvedProjectIds: string[];
  target: string | null;
}
