/**
 * The Mission mode built-in MCP server: one stdio thin client per mission session, carrying the
 * session's gateway capability (`src/main/mission-mode/gateway.ts`). It is not one of the MCP tab's
 * built-ins — no toggle, no per-repo switch — and only a session in a live mission ever gets it.
 *
 * No Electron imports.
 */
import { MISSION_SERVER_ID } from '../../shared/mission-mode';
import type { McpServerDef } from '../../shared/types';
import type { MissionGatewayAttachment } from '../mission-mode/contracts';
import { which } from '../runtime';

export const VOCS_MISSION_SERVER_ID = MISSION_SERVER_ID;
/** How the stdio client learns where the gateway is; the token is a per-session secret. */
export const MISSION_GATEWAY_URL_ENV = 'VOCS_MISSION_GATEWAY_URL';
export const MISSION_GATEWAY_TOKEN_ENV = 'VOCS_MISSION_GATEWAY_TOKEN';

/**
 * Materializes the server with an absolute command (Node, or Electron in Node mode), so ACP, which
 * refuses a relative one, takes it as is. The app sets `builtin`: harnesses trust the Mission tools
 * by that provenance, never by the server's name.
 */
export function missionServerDef(deps: { missionServerPath?: string; attachment: MissionGatewayAttachment | null }): McpServerDef | null {
  if (!deps.missionServerPath || !deps.attachment) return null;
  const node = which('node');
  return {
    id: VOCS_MISSION_SERVER_ID,
    transport: 'stdio',
    command: node ?? process.execPath,
    args: [deps.missionServerPath],
    env: {
      ...(node ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
      [MISSION_GATEWAY_URL_ENV]: deps.attachment.url,
      [MISSION_GATEWAY_TOKEN_ENV]: deps.attachment.token
    },
    description: 'Mission mode coordination tools for this session',
    builtin: VOCS_MISSION_SERVER_ID
  };
}

/** A definition carrying a Mission gateway capability (complete or not). */
export function isMissionGatewayDef(def: Pick<McpServerDef, 'id' | 'env'>): boolean {
  return def.id === VOCS_MISSION_SERVER_ID && (def.env?.[MISSION_GATEWAY_URL_ENV] !== undefined || def.env?.[MISSION_GATEWAY_TOKEN_ENV] !== undefined);
}
