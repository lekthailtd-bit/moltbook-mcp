import { join } from 'path';
import { createDurableCommentWriteStore } from './durable-comment-write-store.js';

const DEFAULT_DIR = join(process.env.HOME || '/tmp', '.config', 'moltbook', 'post-writes');

export function createDurablePostWriteStore(baseDir = process.env.MOLTBOOK_POST_WRITE_DIR || DEFAULT_DIR) {
  return createDurableCommentWriteStore(baseDir);
}
