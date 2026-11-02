import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureResult } from '../src/main/runtime';
import { readCodexMcpServerIds } from '../src/main/mcp/codex';

const { runCapture } = vi.hoisted(() => ({ runCapture: vi.fn() }));
vi.mock('../src/main/runtime', () => ({ runCapture }));

const result = (over: Partial<CaptureResult> = {}): CaptureResult => ({ code: 0, stdout: '[]', stderr: '', ...over });

beforeEach(() => {
  runCapture.mockReset();
  runCapture.mockResolvedValue(result());
});

describe('effective native Codex MCP config', () => {
  it('asks the selected runtime for effective config in the session directory without starting servers', async () => {
    expect(await readCodexMcpServerIds('/runtime/codex', '/project/worktree')).toEqual([]);
    expect(runCapture).toHaveBeenCalledExactlyOnceWith('/runtime/codex', ['mcp', 'list', '--json'], { cwd: '/project/worktree', timeoutMs: 5_000 });
  });

  it('returns only valid transport ids, including disabled servers, without copying native credentials', async () => {
    runCapture.mockResolvedValue(result({ stdout: JSON.stringify([
      { name: 'gitnexus', enabled: false, transport: { type: 'stdio', command: '/private/bin/mcp', args: ['private-argument'], env: { TOKEN: 'private-env-token' } } },
      { name: 'vocs-memory', transport: { type: 'streamable_http', url: 'https://user:private-url-token@example.com/mcp', http_headers: { Authorization: 'Bearer private-header-token' } } },
      { name: 'gitnexus', transport: { type: 'stdio', command: 'duplicate' } },
      { name: 'missing-transport' },
      { name: 'missing-command', transport: { type: 'stdio' } },
      { name: 'empty-command', transport: { type: 'stdio', command: ' ' } },
      { name: 'missing-url', transport: { type: 'streamable_http' } },
      { name: 'unknown', transport: { type: 'sse', url: 'https://example.com/sse' } },
      { name: 'invalid/id', transport: { type: 'stdio', command: 'mcp' } },
      null
    ]) }));
    expect(await readCodexMcpServerIds('/runtime/codex', '/project')).toEqual(['gitnexus', 'vocs-memory']);
    expect(runCapture.mock.calls[0]).toEqual(['/runtime/codex', ['mcp', 'list', '--json'], { cwd: '/project', timeoutMs: 5_000 }]);
  });

  it.each([
    { name: 'nonzero exit', value: result({ code: 1, stdout: '[{"name":"gitnexus","transport":{"type":"stdio","command":"mcp"}}]', stderr: 'private-error' }) },
    { name: 'unavailable process', value: result({ code: null, stderr: 'spawn ENOENT' }) },
    { name: 'truncated output', value: result({ stdout: '[{"name":"gitnexus","transport":{"type":"stdio","command":"mcp"}}]', truncated: true }) },
    { name: 'timed out process', value: result({ timedOut: true }) },
    { name: 'malformed JSON', value: result({ stdout: '[{"name":"gitnexus"' }) },
    { name: 'unexpected object', value: result({ stdout: '{"servers":[]}' }) },
    { name: 'null result', value: result({ stdout: 'null' }) }
  ])('falls back safely for $name', async ({ value }) => {
    runCapture.mockResolvedValue(value);
    expect(await readCodexMcpServerIds('/runtime/codex', '/project')).toEqual([]);
  });

  it('does not expose probe failures to the session', async () => {
    runCapture.mockRejectedValue(new Error('native-private-token'));
    expect(await readCodexMcpServerIds('/runtime/codex', '/project')).toEqual([]);
  });
});
