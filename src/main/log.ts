/**
 * Main-process logging. Console output is invisible in a packaged build, so every line also goes to
 * a rotating file under userData/logs — without it a freeze or a crash leaves nothing to read.
 */
import { createWriteStream, mkdirSync, renameSync, rmSync, statSync, type WriteStream } from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type Logger = (level: LogLevel, message: string) => void;

/** Rotate at 2 MB and keep one previous file, so the log can never fill a disk. */
const MAX_BYTES = 2_000_000;

export interface LoggerHandle {
  log: Logger;
  /** Path of the current log file, or null when it could not be opened. */
  file: string | null;
}

/**
 * `debug` lines are dropped unless asked for; everything else is always written. The size is tracked
 * in memory rather than stat'ed per line, because this runs on the UI thread.
 */
export function createLogger(dir: string, debug: boolean): LoggerHandle {
  const file = path.join(dir, 'main.log');
  let stream: WriteStream | null = null;
  let bytes = 0;

  const open = (): void => {
    mkdirSync(dir, { recursive: true });
    try {
      bytes = statSync(file).size;
    } catch {
      bytes = 0;
    }
    stream = createWriteStream(file, { flags: 'a' });
    stream.on('error', () => (stream = null)); // a locked or read-only log must not take the app down
  };

  const rotate = (): void => {
    const old = stream;
    stream = null;
    old?.end();
    try {
      rmSync(`${file}.1`, { force: true });
      renameSync(file, `${file}.1`);
      open();
    } catch {
      /* carry on without a file */
    }
  };

  try {
    open();
  } catch {
    stream = null;
  }

  const log: Logger = (level, message) => {
    if (level === 'debug' && !debug) return;
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    if (!stream) return;
    const chunk = `${line}\n`;
    bytes += Buffer.byteLength(chunk);
    stream.write(chunk);
    if (bytes > MAX_BYTES) rotate();
  };

  return { log, file: stream ? file : null };
}
