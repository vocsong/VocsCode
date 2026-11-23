/** JSON command and notification shared by the host and its bundled Pi extension. */
export const SUBAGENT_CONTROL_COMMAND = 'vocs-subagent-control';
export const SUBAGENT_CONTROL_MARKER = 'VCODE_SUBAGENT_CONTROL::';
export type SubagentControlKind = 'stop' | 'steer';
