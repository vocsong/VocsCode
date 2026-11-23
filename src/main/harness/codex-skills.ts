/**
 * Codex's skills as harness commands. Codex has no slash commands outside its TUI — app-server and
 * exec hand `/name` text to the model as written — but it runs a skill named in a turn as `$name`.
 * So both Codex adapters list skills (`skills/list`) for the composer's `/` popover and translate a
 * picked `/name args` into Codex's own `$name args` before the turn goes out.
 */
import type { HarnessCommand } from '../../shared/harness-commands';
import { withTimeout } from '../util/async';
import { JsonRpcStdioClient } from './jsonrpc';
import { spawnTool } from './spawn';

export interface CodexSkill {
  name: string;
  description: string;
  /** SKILL.md, which app-server takes on a `skill` input item so it need not look the name up. */
  path: string;
}

interface SkillMetadataLike {
  name?: unknown;
  description?: unknown;
  shortDescription?: unknown;
  interface?: { shortDescription?: unknown } | null;
  path?: unknown;
  enabled?: unknown;
}

/** Enabled skills for `cwd`, first occurrence of a name winning (Codex lists repo skills before user ones). */
export async function listCodexSkills(rpc: Pick<JsonRpcStdioClient, 'request'>, cwd: string): Promise<CodexSkill[]> {
  const res = await withTimeout(rpc.request<{ data?: { skills?: SkillMetadataLike[] }[] }>('skills/list', { cwds: [cwd] }), 20_000, 'codex skills/list');
  const out: CodexSkill[] = [];
  const seen = new Set<string>();
  for (const entry of res?.data ?? []) {
    for (const s of entry.skills ?? []) {
      if (s.enabled === false || typeof s.name !== 'string' || typeof s.path !== 'string' || seen.has(s.name.toLowerCase())) continue;
      seen.add(s.name.toLowerCase());
      const short = [s.interface?.shortDescription, s.shortDescription, s.description].find((d): d is string => typeof d === 'string' && !!d.trim());
      out.push({ name: s.name, description: short ?? '', path: s.path });
    }
  }
  return out;
}

/** Exec has no protocol of its own: the same binary answers one `skills/list` through app-server, then exits. */
export async function readCodexSkills(bin: string, cwd: string, env: NodeJS.ProcessEnv): Promise<CodexSkill[]> {
  const rpc = new JsonRpcStdioClient(spawnTool(bin, ['app-server'], { env }));
  try {
    await withTimeout(rpc.request('initialize', { clientInfo: { name: 'vocs-code', version: '0.1.0' } }), 10_000, 'codex initialize');
    rpc.notify('initialized');
    return await listCodexSkills(rpc, cwd);
  } finally {
    await rpc.close();
  }
}

export function codexSkillCommands(skills: readonly CodexSkill[]): HarnessCommand[] {
  return skills.map((s) => ({ name: s.name, description: s.description || undefined, kind: 'skill' }));
}

/**
 * `/name args` for a known skill becomes `$name args`, the form Codex resolves; anything else is
 * returned unchanged with no skill. `known` is whatever list the adapter has — its live one, or the
 * session's last reported list before the first `skills/list` answers.
 */
export function codexSkillInvocation<T extends { name: string }>(text: string, known: readonly T[]): { text: string; skill?: T } {
  const m = /^\/([\w:.-]+)(?=\s|$)/.exec(text);
  if (!m) return { text };
  const skill = known.find((s) => s.name.toLowerCase() === m[1].toLowerCase());
  return skill ? { text: `$${skill.name}${text.slice(m[0].length)}`, skill } : { text };
}
