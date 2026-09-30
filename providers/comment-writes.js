import { createCommentWriteCoordinator as createCoreCoordinator } from './comment-writes-core.js';
import { createDurableCommentWriteStore } from './durable-comment-write-store.js';

export * from './comment-writes-core.js';
export { createDurableCommentWriteStore };

// Public/default file-backed storage is deliberately non-pruning. Logical write
// identities are part of the idempotency contract and cannot safely expire by
// time or count without authoritative reconciliation.
export function createFileIntentStore(baseDir) {
  return createDurableCommentWriteStore(baseDir);
}

export function createCommentWriteCoordinator(options = {}) {
  const { store = createDurableCommentWriteStore(), ...rest } = options;
  return createCoreCoordinator({ ...rest, store });
}

let singleton;
export function getCommentWriteCoordinator() {
  if (!singleton) singleton = createCommentWriteCoordinator();
  return singleton;
}
