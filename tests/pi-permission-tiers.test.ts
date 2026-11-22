/**
 * The Vocs Code tier contract as pi's shared gate (`decideToolCall`) enforces it, for the parent
 * approvals extension and every subagent child alike. One row per action class, one column per tier.
 */
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideToolCall, type GateDecision, type Mode } from '../resources/pi/subagent-gate';

type Outcome = 'run' | 'ask' | 'deny';

const cwd = process.cwd();
const outsideFile = path.join(path.dirname(cwd), 'outside-vocs-tier.txt');
const builtinRead = 'mcp__gitnexus__query';
const readOnlyMcp = new Set([builtinRead, 'mcp__cua_driver__get_window_state', 'mcp__vocs_memory__knowledge_search']);

const TIERS: Mode[] = ['plan', 'ask', 'accept-edits', 'auto', 'full-auto'];

/** [action, tool, input, outcome per tier in TIERS order] */
const CONTRACT: [string, string, Record<string, unknown>, Outcome[]][] = [
  ['read', 'read', { path: 'src/a.ts' }, ['run', 'run', 'run', 'run', 'run']],
  ['search', 'grep', { pattern: 'x' }, ['run', 'run', 'run', 'run', 'run']],
  ['edit inside the project', 'edit', { path: 'src/a.ts' }, ['deny', 'ask', 'run', 'run', 'run']],
  ['write inside the project', 'write', { path: 'src/new.ts' }, ['deny', 'ask', 'run', 'run', 'run']],
  ['ordinary shell', 'bash', { command: 'npm test' }, ['deny', 'ask', 'ask', 'run', 'run']],
  ['ordinary powershell', 'powershell', { command: 'Get-ChildItem' }, ['deny', 'ask', 'ask', 'run', 'run']],
  ['dangerous shell', 'bash', { command: 'git push --force' }, ['deny', 'ask', 'ask', 'ask', 'run']],
  ['dangerous powershell', 'powershell', { command: 'Remove-Item -Recurse x' }, ['deny', 'ask', 'ask', 'ask', 'run']],
  ['edit outside the project', 'edit', { path: outsideFile }, ['deny', 'ask', 'ask', 'ask', 'run']],
  ['third-party MCP tool', 'mcp__notes__write', { text: 'x' }, ['deny', 'ask', 'ask', 'run', 'run']],
  // An MCP argument named `command` is not a shell command; the tool is gated as an MCP tool.
  ['third-party MCP tool with a shell-like argument', 'mcp__runner__exec', { command: 'rm -rf /' }, ['deny', 'ask', 'ask', 'run', 'run']],
  ['built-in non-read-only tool', 'mcp__gitnexus__rename', { symbol: 'a' }, ['deny', 'ask', 'ask', 'run', 'run']],
  ['built-in read-only tool', builtinRead, { query: 'auth' }, ['run', 'run', 'run', 'run', 'run']],
  ['cua read-only tool', 'mcp__cua_driver__get_window_state', {}, ['run', 'run', 'run', 'run', 'run']],
  ['cua click', 'mcp__cua_driver__click', {}, ['deny', 'ask', 'ask', 'run', 'run']]
];

function outcome(decision: GateDecision): Outcome {
  return decision.action === 'allow' ? 'run' : decision.action === 'block' ? 'deny' : 'ask';
}

describe('pi gate follows the tier contract', () => {
  const cases = CONTRACT.flatMap(([action, tool, input, outcomes]) => TIERS.map((mode, i) => [action, mode, tool, input, outcomes[i]!] as const));
  it.each(cases)('%s in %s: %s', async (_action, mode, tool, input, expected) => {
    const decision = await decideToolCall({ tool, input, cwd, mode, sessionAllowed: new Set(), readOnlyMcp });
    expect(outcome(decision)).toBe(expected);
  });

  it('trusts a built-in read only through the provenance-derived set, never its name', async () => {
    for (const mode of ['plan', 'ask', 'accept-edits'] as Mode[]) {
      const decision = await decideToolCall({ tool: builtinRead, input: {}, cwd, mode, sessionAllowed: new Set() });
      expect(outcome(decision)).toBe(mode === 'plan' ? 'deny' : 'ask');
    }
  });
});

describe('pi "Allow for session" grants', () => {
  it('are keyed per tool name', async () => {
    const granted = new Set(['mcp__notes__write']);
    expect(outcome(await decideToolCall({ tool: 'mcp__notes__write', input: {}, cwd, mode: 'ask', sessionAllowed: granted }))).toBe('run');
    expect(outcome(await decideToolCall({ tool: 'mcp__notes__delete', input: {}, cwd, mode: 'ask', sessionAllowed: granted }))).toBe('ask');
    expect(outcome(await decideToolCall({ tool: 'bash', input: { command: 'ls' }, cwd, mode: 'ask', sessionAllowed: granted }))).toBe('ask');
  });

  it.each(['ask', 'accept-edits', 'auto'] as Mode[])('never cover a dangerous command or an outside edit in %s mode', async (mode) => {
    const granted = new Set(['bash', 'edit']);
    expect(outcome(await decideToolCall({ tool: 'bash', input: { command: 'git reset --hard' }, cwd, mode, sessionAllowed: granted }))).toBe('ask');
    expect(outcome(await decideToolCall({ tool: 'edit', input: { path: path.join(os.tmpdir(), 'x.txt') }, cwd, mode, sessionAllowed: granted }))).toBe('ask');
  });

  it('never lift plan mode', async () => {
    const granted = new Set(['bash', 'mcp__notes__write']);
    for (const tool of granted) {
      expect(outcome(await decideToolCall({ tool, input: { command: 'ls' }, cwd, mode: 'plan', sessionAllowed: granted }))).toBe('deny');
    }
  });
});
