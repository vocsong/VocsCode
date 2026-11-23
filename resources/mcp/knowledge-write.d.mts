export function sameKnowledgeClaim(a: string | undefined, b: string | undefined): boolean;
export function sameRejectedKnowledgeClaim(a: string | undefined, b: string | undefined): boolean;
export function knowledgeCollision(id: string): Error;
export function withKnowledgeWriteLock<T>(root: string, action: () => Promise<T>, options?: { timeoutMs?: number }): Promise<T>;
export function writeKnowledgeFileAtomic(file: string, content: string): Promise<void>;
