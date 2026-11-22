/**
 * Analytics dashboard and integrated PTY terminal IPC handlers (`analytics:*`, `terminal:*`).
 */
import type { HandlerContext } from './types';

export function registerTerminalAnalyticsHandlers(ctx: HandlerContext): void {
  const { deps, handle, missionGuard } = ctx;
  const { sessions, terminals } = deps;
  const { pathKey, recordTerminalVerdict } = missionGuard;

  // `days: 0` is all time; only an absent request falls back to the 30-day default.
  handle('analytics:summary', (req) => deps.analytics.summary(req && typeof req === 'object' && typeof req.days === 'number' ? Math.max(0, req.days) : 30));
  handle('analytics:executions', (req) => {
    const q = req && typeof req === 'object' ? req : {};
    const ids = Array.isArray(q.ids) ? q.ids.filter((x): x is string => typeof x === 'string').slice(0, 200) : undefined;
    return deps.analytics.queryExecutions({
      ids,
      signature: typeof q.signature === 'string' ? q.signature : undefined,
      sessionId: typeof q.sessionId === 'string' ? q.sessionId : undefined,
      days: typeof q.days === 'number' ? Math.max(0, q.days) : undefined,
      limit: typeof q.limit === 'number' ? Math.min(200, Math.max(1, Math.floor(q.limit))) : 50
    });
  });

  handle('terminal:list', () => terminals.list());
  handle('terminal:screen', ({ terminalId, lines }) => terminals.screenText(String(terminalId ?? ''), typeof lines === 'number' ? lines : undefined));
  handle('terminal:shells', () => terminals.shells());
  handle('terminal:create', ({ sessionId, shell, cols, rows }) => {
    sessions.assertNotHousekeeping?.(sessionId);
    const info = terminals.create(sessionId, { shell, cols, rows });
    // The guard just cleared this session's cwd (or nothing could own it); keystrokes reuse that.
    const session = sessions.get(sessionId);
    if (session && pathKey(session.cwd) === pathKey(info.cwd)) recordTerminalVerdict(info, true);
    return info;
  });
  handle('terminal:attach', ({ terminalId, cols, rows }) => terminals.attach(terminalId, cols, rows));
  handle('terminal:detach', ({ terminalId }) => terminals.detach(terminalId));
  handle('terminal:input', ({ terminalId, data }) => terminals.input(terminalId, data));
  handle('terminal:resize', ({ terminalId, cols, rows }) => terminals.resize(terminalId, cols, rows));
  handle('terminal:ack', ({ terminalId, chars }) => terminals.ack(terminalId, chars));
  handle('terminal:kill', ({ terminalId }) => terminals.kill(terminalId));
  handle('terminal:restart', ({ terminalId }) => terminals.restart(terminalId));
  handle('terminal:close', ({ terminalId }) => terminals.close(terminalId));
  handle('terminal:clear', ({ terminalId }) => terminals.clear(terminalId));
  handle('terminal:rename', ({ terminalId, title }) => terminals.rename(terminalId, title));
}
