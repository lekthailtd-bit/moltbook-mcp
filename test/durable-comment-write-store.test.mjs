import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDurableCommentWriteStore } from '../providers/durable-comment-write-store.js';

test('durable production write store never auto-prunes idempotency intents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moltbook-write-retention-'));
  try {
    const store = createDurableCommentWriteStore(dir);
    const oldest = {
      key: 'intent-0000', kind: 'comment', post_id: 'post-old', parent_id: null,
      content: 'old protected write', status: 'published', comment_id: 'c-old',
      created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z',
    };
    store.save(oldest);
    for (let i = 1; i <= 520; i++) {
      store.save({
        key: `intent-${String(i).padStart(4, '0')}`,
        kind: 'comment', post_id: `post-${i}`, parent_id: null,
        content: `write ${i}`, status: i % 2 ? 'ambiguous' : 'published',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      });
    }
    assert.equal(store.load(oldest.key)?.comment_id, 'c-old');
    assert.equal(store.list().length, 521);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('durable store lock single-flights the same intent key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moltbook-write-lock-'));
  try {
    const first = createDurableCommentWriteStore(dir);
    const second = createDurableCommentWriteStore(dir);
    const release = first.acquire('same-key');
    assert.equal(typeof release, 'function');
    assert.equal(second.acquire('same-key'), null);
    release();
    const release2 = second.acquire('same-key');
    assert.equal(typeof release2, 'function');
    release2();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
