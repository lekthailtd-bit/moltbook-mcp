import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createFileIntentStore } from '../providers/comment-writes.js';

test('public comment write store facade retains old logical write identities', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moltbook-write-facade-'));
  try {
    const store = createFileIntentStore(dir);
    store.save({ key: 'oldest', status: 'published', comment_id: 'c-old' });
    for (let i = 0; i < 520; i++) {
      store.save({ key: `intent-${i}`, status: i % 2 ? 'ambiguous' : 'published' });
    }
    assert.equal(store.load('oldest')?.comment_id, 'c-old');
    assert.equal(store.list().length, 521);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
