/**
 * Seams between the Mission mode pieces: the loopback gateway that carries the tools, the service
 * that runs them, and the session manager. No Electron imports.
 */
import type { MissionRole, MissionTool, MissionToolArgs } from '../../shared/mission-mode';

/** A validated tool call, already bound to the caller's session and role by its gateway token. */
export interface MissionToolCall<T extends MissionTool = MissionTool> {
  sessionId: string;
  missionId: string;
  role: MissionRole;
  tool: T;
  args: MissionToolArgs[T];
}

/** What the model sees; `isError` maps to MCP's tool-error result. */
export interface MissionToolResult {
  text: string;
  isError?: boolean;
}

/** Implemented by MissionService; the gateway dispatches every authorized call here. */
export interface MissionToolHandler {
  call(call: MissionToolCall): Promise<MissionToolResult>;
}

/** Live identity the gateway re-reads on every request; null revokes. */
export interface MissionSessionIdentity {
  missionId: string;
  role: MissionRole;
}

/** The capability one session's `vocs-mission` stdio client connects with. */
export interface MissionGatewayAttachment {
  url: string;
  token: string;
}

/** What the session manager and MCP resolution need from the gateway. */
export interface MissionGatewayPort {
  /** Null for sessions that are not (or no longer) part of a live mission. */
  attach(sessionId: string): MissionGatewayAttachment | null;
  revoke(sessionId: string): void;
}
