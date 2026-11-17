/** Shared by the app and standalone MCP processes: one filesystem mutex per project wiki. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Only whitespace is presentation: punctuation, Unicode and identifier case carry meaning. */
export function sameKnowledgeClaim(a, b) {
  const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const left = normalize(a);
  return !!left && left === normalize(b);
}

/** Rejection is conservative: keep legacy case/punctuation-insensitive refusal without trusting
 * its truncated 32-bit lookup key as proof. This broader match never authorizes an overwrite. */
export function sameRejectedKnowledgeClaim(a, b) {
  const normalize = (value) => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  const left = normalize(a);
  return !!left && left === normalize(b);
}

export function knowledgeCollision(id) {
  return new Error(`Knowledge page "${id}" already contains a different claim. Choose a different title for a new page, or pass explicit pageId (app) / page_id (MCP) for an intentional update.`);
}

/**
 * mkdir is the cross-process boundary, not a cached page snapshot. Never steal an old lock: the
 * owner may only be paused. After a crash, stop all writers before manually removing _write.lock.
 */
export async function withKnowledgeWriteLock(root, action, { timeoutMs = 5000 } = {}) {
  await fs.mkdir(root, { recursive: true });
  const lock = path.join(root, '_write.lock');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`Knowledge wiki is busy (${lock}). Retry later; after a crashed writer, stop all app/MCP writers before manually removing _write.lock.`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await action();
  } finally {
    await fs.rmdir(lock);
  }
}

/** A unique sibling temp + rename keeps both old and new pages complete, including on failure. */
export async function writeKnowledgeFileAtomic(file, content) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, content, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}
