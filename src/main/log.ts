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
 * Provider keys and bearer tokens must never reach the log file (AGENTS.md invariant). Callers are
 * expected not to log them in the first place; this is the safety net for a harness stderr line, a
 * thrown error message that echoes a request header, or a settings dump. Conservative on purpose:
 * only well-known key prefixes and `key=value` shapes are masked, ordinary prose is left alone.
 */
const SECRET_PATTERNS: RegExp[] = [
  // Anthropic, OpenAI, OpenRouter, DeepSeek, Mistral… all issue `sk-…` keys.
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // Groq, xAI, Google, GitHub tokens.
  /\bgsk_[A-Za-z0-9]{16,}/g,
  /\bxai-[A-Za-z0-9]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // Authorization headers.
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  // Any `api_key=…` / `"apiKey": "…"` / `token: …` assignment, however it was serialized. Runs after
  // the Bearer rule, so an already-masked header is not masked twice.
  /\b((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|password|authorization)["']?\s*[:=]\s*["']?)(?!\[redacted\])(?!bearer\b)([^"'\s,;}&]{6,})/gi
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match, prefix?: string) => (typeof prefix === 'string' && match.startsWith(prefix) ? `${prefix}[redacted]` : '[redacted]'));
  }
  return out;
}

/**
 * `debug` lines are dropped unless asked for; everything else is always written. The size is tracked
 * in memory rather than stat'ed per line, because this runs on the UI thread.
 */
export function createLogger(dir: string, debug: boolean): LoggerHandle {
  const file = path.join(dir, 'main.log');
  let stream: WriteStream | null = null;
  let bytes = 0;
  let warnedUnwritable = false;

  /** The log file itself is the thing that failed, so the console is the only place left to say so. */
  const unwritable = (reason: unknown): void => {
    stream = null;
    if (warnedUnwritable) return;
    warnedUnwritable = true;
    console.warn(`[${new Date().toISOString()}] WARN log file ${file} is not writable (${reason instanceof Error ? reason.message : String(reason)}); logging to the console only`);
  };

  const open = (): void => {
    mkdirSync(dir, { recursive: true });
    try {
      bytes = statSync(file).size;
    } catch {
      bytes = 0;
    }
    stream = createWriteStream(file, { flags: 'a' });
    stream.on('error', unwritable); // a locked or read-only log must not take the app down
  };

  const rotate = (): void => {
    const old = stream;
    stream = null;
    old?.end();
    try {
      rmSync(`${file}.1`, { force: true });
      renameSync(file, `${file}.1`);
      open();
    } catch (e) {
      unwritable(e);
    }
  };

  try {
    open();
  } catch (e) {
    unwritable(e);
  }

  const log: Logger = (level, message) => {
    if (level === 'debug' && !debug) return;
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${redactSecrets(message)}`;
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

/** `Error` stacks for the log, anything else as a string. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return typeof error === 'string' ? error : String(error);
}
