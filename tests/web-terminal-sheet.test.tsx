/** @vitest-environment jsdom */
/** The web terminal sheet (src/web/sheets/TerminalSheet.tsx, P3.5): it streams the session's terminal,
 *  types into it from the line field and the key strip, opens a new one, re-watches after a
 *  reconnect, keeps watching but hides typing in view-only mode, and tells an older desktop apart
 *  from a broken one. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installHarness, loadWebModules, setTransport } from './support/web-shell';
import type { RemoteTerminalFrame } from '../src/shared/remote-terminal';
import type { TerminalInfo } from '../src/shared/terminal';

let rtl: typeof import('@testing-library/react');
let TerminalSheet: typeof import('../src/web/sheets/TerminalSheet').TerminalSheet;

const term = (id: string, patch: Partial<TerminalInfo> = {}): TerminalInfo => ({ id, sessionId: 's1', title: `shell ${id}`, shell: 'bash', shellName: 'bash', cwd: '/repo', createdAt: 1, pid: 99, ...patch });

function desk(opts: { canWrite?: boolean; terminals?: TerminalInfo[]; watch?: (id: string) => Promise<unknown> } = {}) {
  let terminals = opts.terminals ?? [term('t1')];
  const listeners = new Set<(frame: RemoteTerminalFrame) => void>();
  const invoke = vi.fn(async (channel: string, request: { terminalId?: string; sessionId?: string }) => {
    switch (channel) {
      case 'terminal:list':
        return terminals;
      case 'terminal:watch':
        if (opts.watch) return opts.watch(request.terminalId!);
        return { terminalId: request.terminalId, snapshot: `hello from ${request.terminalId}\r\n$ `, seq: 3, cols: 40, rows: 8, info: term(request.terminalId!) };
      case 'terminal:create': {
        const created = term('t2');
        terminals = [...terminals, created];
        return created;
      }
      default:
        return undefined;
    }
  });
  const canWrite = opts.canWrite ?? true;
  setTransport({
    invoke,
    on: (channel: string, listener: (frame: RemoteTerminalFrame) => void) => {
      if (channel !== 'push:remoteTerminal') return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    can: (channel: string) => canWrite || !['terminal:input', 'terminal:create'].includes(channel)
  });
  const push = (frame: RemoteTerminalFrame) => [...listeners].forEach((l) => l(frame));
  const calls = (channel: string) => invoke.mock.calls.filter(([c]) => c === channel).map(([, r]) => r);
  return { invoke, push, calls };
}

beforeEach(async () => {
  installHarness();
  ({ rtl } = await loadWebModules());
  ({ TerminalSheet } = await import('../src/web/sheets/TerminalSheet'));
});

afterEach(() => {
  rtl.cleanup();
});

describe('web terminal sheet', () => {
  it('streams the terminal and types into it from the line field and the key strip', async () => {
    const d = desk();
    rtl.render(<TerminalSheet sessionId="s1" online onClose={() => undefined} />);
    await rtl.screen.findByText('hello from t1', {}, { timeout: 5000 });
    d.push({ terminalId: 't1', kind: 'data', seq: 4, data: 'streamed output\r\n' });
    d.push({ terminalId: 't1', kind: 'data', seq: 2, data: 'already on screen' });
    await rtl.screen.findByText(/streamed output/, {}, { timeout: 5000 });
    expect(rtl.screen.queryByText(/already on screen/)).toBeNull();
    rtl.fireEvent.change(rtl.screen.getByLabelText('Terminal input'), { target: { value: 'git status' } });
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Run' }));
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Ctrl+C (interrupt)' }));
    await rtl.waitFor(() => expect(d.calls('terminal:input')).toEqual([{ terminalId: 't1', data: 'git status\r\x03' }]));
    // A hardware keyboard on the view itself sends xterm sequences.
    rtl.fireEvent.keyDown(rtl.screen.getByTestId('remote-terminal'), { key: 'ArrowUp' });
    await rtl.waitFor(() => expect(d.calls('terminal:input')).toContainEqual({ terminalId: 't1', data: '\x1b[A' }));
  });

  it('keeps watching but offers no typing or new terminal in view-only mode', async () => {
    const d = desk({ canWrite: false });
    rtl.render(<TerminalSheet sessionId="s1" online onClose={() => undefined} />);
    await rtl.screen.findByText('hello from t1', {}, { timeout: 5000 });
    expect(rtl.screen.getByTestId('terminal-view-only')).toBeTruthy();
    expect(rtl.screen.queryByLabelText('Terminal input')).toBeNull();
    expect(rtl.screen.queryByTestId('terminal-new')).toBeNull();
    rtl.fireEvent.keyDown(rtl.screen.getByTestId('remote-terminal'), { key: 'a' });
    await new Promise((r) => setTimeout(r, 50));
    expect(d.calls('terminal:input')).toEqual([]);
  });

  it('opens a new terminal for the session and streams it', async () => {
    const d = desk({ terminals: [] });
    rtl.render(<TerminalSheet sessionId="s1" online onClose={() => undefined} />);
    await rtl.screen.findByText('No terminal is open for this session on the computer.');
    rtl.fireEvent.click(rtl.screen.getByTestId('terminal-new'));
    await rtl.screen.findByText('hello from t2', {}, { timeout: 5000 });
    expect(d.calls('terminal:create')).toEqual([{ sessionId: 's1' }]);
    expect(d.calls('terminal:watch')).toEqual([{ terminalId: 't2' }]);
  });

  it('watches again from a fresh snapshot when the computer comes back', async () => {
    const d = desk();
    const view = rtl.render(<TerminalSheet sessionId="s1" online onClose={() => undefined} />);
    await rtl.screen.findByText('hello from t1', {}, { timeout: 5000 });
    view.rerender(<TerminalSheet sessionId="s1" online={false} onClose={() => undefined} />);
    expect(rtl.screen.getByText('Reconnecting to the computer…')).toBeTruthy();
    view.rerender(<TerminalSheet sessionId="s1" online onClose={() => undefined} />);
    await rtl.waitFor(() => expect(d.calls('terminal:watch')).toHaveLength(2));
  });

  it('asks to update a desktop that does not have the live terminal yet', async () => {
    desk({ watch: async () => { throw new Error('channel not available remotely'); } });
    rtl.render(<TerminalSheet sessionId="s1" online onClose={() => undefined} />);
    await rtl.screen.findByText('This computer runs an older Vocs Code: update it to use the live terminal.', {}, { timeout: 5000 });
  });

  it('offers no typing into a shell that is not running', async () => {
    const d = desk({ terminals: [term('t1', { pid: undefined, exit: { code: 1 } })] });
    rtl.render(<TerminalSheet sessionId="s1" online onClose={() => undefined} />);
    await rtl.screen.findByText('hello from t1', {}, { timeout: 5000 });
    expect(rtl.screen.getByText("This terminal's shell is not running, so it cannot take input.")).toBeTruthy();
    expect(rtl.screen.queryByLabelText('Terminal input')).toBeNull();
    rtl.fireEvent.keyDown(rtl.screen.getByTestId('remote-terminal'), { key: 'a' });
    await new Promise((r) => setTimeout(r, 50));
    expect(d.calls('terminal:input')).toEqual([]);
  });

  it('says so when the desktop closes the terminal', async () => {
    const d = desk();
    rtl.render(<TerminalSheet sessionId="s1" online onClose={() => undefined} />);
    await rtl.screen.findByText('hello from t1', {}, { timeout: 5000 });
    d.push({ terminalId: 't1', kind: 'closed' });
    await rtl.screen.findByText('This terminal was closed on the computer.');
    expect(rtl.screen.queryByLabelText('Terminal input')).toBeNull();
  });
});
