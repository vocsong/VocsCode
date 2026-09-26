/** Cooperative per-check port allocation. The OS socket is held until the suspended command is
 * ready to run; the numeric claim lasts through tree teardown (including uncertain ownership).
 * A script must honor PORT/VOCS_MISSION_PORT. This cannot isolate hardcoded ports or prevent an
 * unrelated application binding between reservation release and the check's own listen(). */
import { createServer, type Server } from 'node:net';

export interface CheckPortLease {
  readonly port: number;
  /** Release the socket immediately before resuming the check; retain the operation's claim. */
  prepareForSpawn(): Promise<void>;
  /** Only after quiescence or when no check was ever spawned. */
  release(): Promise<void>;
}

const claimed = new Set<number>();

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
  });
}

export async function allocateCheckPort(): Promise<CheckPortLease> {
  for (let attempt = 0; attempt < 64; attempt++) {
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { server.close(); reject(error); };
      server.once('error', failed);
      server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => { server.off('error', failed); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') { await close(server); throw new Error('Check port allocation failed'); }
    const port = address.port;
    if (claimed.has(port)) { await close(server); continue; }
    claimed.add(port);
    let closing: Promise<void> | undefined;
    const prepareForSpawn = () => closing ??= close(server).catch((error) => { closing = undefined; throw error; });
    return {
      port, prepareForSpawn,
      release: async () => { await prepareForSpawn(); claimed.delete(port); },
    };
  }
  throw new Error('Could not allocate an unclaimed verification port');
}
