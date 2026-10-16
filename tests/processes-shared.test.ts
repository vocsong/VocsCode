/**
 * How the Processes panel names and groups processes: what a process runs rather than which
 * interpreter runs it (from real command lines the app's harnesses produce), and groups ordered so
 * the processes left behind come first, each as a tree in start order.
 */
import { describe, expect, it } from 'vitest';
import { describeProcess, groupProcesses, rootsOf, splitCommandLine, type TrackedProcess } from '../src/shared/processes';

describe('splitCommandLine', () => {
  it('follows Windows argv quoting rules', () => {
    expect(splitCommandLine('"C:\\Program Files\\nodejs\\node.exe" G:\\a\\b.mjs --x "y z"')).toEqual(['C:\\Program Files\\nodejs\\node.exe', 'G:\\a\\b.mjs', '--x', 'y z']);
    expect(splitCommandLine('cmd /d /s /c "\\"C:\\npm\\pi.cmd\\" --mode rpc"')).toEqual(['cmd', '/d', '/s', '/c', '"C:\\npm\\pi.cmd" --mode rpc']);
    expect(splitCommandLine('a\\\\"b c"')).toEqual(['a\\b c']);
    expect(splitCommandLine('  ')).toEqual([]);
  });
});

describe('describeProcess', () => {
  const name = (command: string, exe = 'x.exe') => describeProcess({ name: exe, command });

  it('names the harness CLIs and app services', () => {
    expect(name('G:\\Vocs-Code\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe --output-format stream-json --mcp-config "{\\"mcpServers\\":{}}"')).toBe('Claude Code');
    expect(name('C:\\Users\\me\\codex.exe app-server')).toBe('Codex app-server');
    expect(name('"node"   "C:\\Users\\me\\AppData\\Roaming\\Vocs Code\\runtime\\\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" --mode rpc')).toBe('Pi');
    expect(name('C:\\WINDOWS\\system32\\cmd.exe /d /s /c "C:\\Users\\me\\AppData\\Roaming\\npm\\gitnexus.cmd serve --port 56500 --host 127.0.0.1"')).toBe('gitnexus serve --port 56500 --host 127.0.0.1');
    expect(name('"C:\\Program Files\\nodejs\\node.exe" G:\\Vocs-Code\\resources\\mcp\\vocs-memory.mjs')).toBe('vocs-memory.mjs');
    expect(name('C:\\WINDOWS\\system32\\cmd.exe /d /s /c ""C:\\Users\\me\\AppData\\Roaming\\Vocs Code (Dev)\\runtime\\pi.cmd" --mode rpc -e G:\\x.ts"')).toBe('pi --mode rpc -e G:\\x.ts');
  });

  it('names what a tool shell or npm actually runs', () => {
    expect(name('node C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\npm\\bin\\npm-cli.js run dev')).toBe('npm run dev');
    expect(name('"C:\\Program Files\\nodejs\\node.exe" G:\\proj\\node_modules\\vite\\bin\\vite.js --port 5173')).toBe('vite --port 5173');
    expect(
      name(`"C:\\Program Files\\Git\\bin\\bash.exe" -c "source /c/Users/me/.claude/shell-snapshots/snapshot-bash-1.sh 2>/dev/null || true && eval 'npm run update' \\< /dev/null && pwd -P >| /tmp/claude-1-cwd"`)
    ).toBe('npm run update');
    expect(name('"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"  -NoProfile -Command "$__claudeCodeScript = $env:CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT; Invoke-Expression -Command $__claudeCodeScript"')).toBe('PowerShell (Claude Code tool)');
    expect(name('/bin/bash ./scripts/batch-job.sh --all', 'bash')).toBe('batch-job.sh --all');
    expect(name('node -e "setInterval(() => {}, 1000)"')).toBe('node -e "setInterval(() => {}, 1000)"');
    expect(name('python3 -c "import time; time.sleep(60)"', 'python3')).toBe('python3 -c "import time; time.sleep(60)"');
  });

  it('falls back to the executable name without a readable command line', () => {
    expect(describeProcess({ name: 'esbuild.exe' })).toBe('esbuild');
  });
});

const p = (pid: number, ppid: number, startedAt: number, over: Partial<TrackedProcess> = {}): TrackedProcess => ({ pid, ppid, startedAt, name: 'node.exe', owner: {}, memory: 10, cpu: 1, ...over });

describe('groupProcesses', () => {
  it('puts left-behind processes first, then the active session, other sessions, then the app', () => {
    const groups = groupProcesses(
      [
        p(10, 1, 100, { owner: { label: 'GitNexus server' } }),
        p(20, 1, 200, { owner: { sessionId: 'other' } }),
        p(30, 1, 300, { owner: { sessionId: 'active' } }),
        p(40, 99, 50, { owner: { sessionId: 'active' }, orphaned: true })
      ],
      'active'
    );
    expect(groups.map((g) => g.key)).toEqual(['orphaned', 'session:active', 'session:other', 'app']);
  });

  it('nests each child under its parent in start order, and sums the group', () => {
    const [group] = groupProcesses([p(3, 2, 300), p(2, 1, 200), p(4, 1, 250), p(5, 2, 350), p(6, 4, 100)]);
    // 6's recorded parent 4 started after it, so that link names a reused PID: 6 is its own root.
    expect(group.rows.map((r) => [r.process.pid, r.depth])).toEqual([
      [6, 0],
      [2, 0],
      [3, 1],
      [5, 1],
      [4, 0]
    ]);
    expect(group.memory).toBe(50);
    expect(group.cpu).toBe(5);
    expect(rootsOf(group.rows).map((r) => r.pid)).toEqual([6, 2, 4]);
  });
});
