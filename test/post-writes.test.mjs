import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  classifyPostPublication,
  createPostWriteCoordinator,
} from '../providers/post-writes.js';
import { createDurablePostWriteStore } from '../providers/durable-post-write-store.js';
import { createMemoryStore } from '../providers/comment-writes.js';

function fakeMoltbook(options = {}) {
  const posts = new Map();
  const pendingByCode = new Map();
  let createCount = 0;
  let verifyCount = 0;
  let idCounter = 0;

  async function request(path, opts = {}) {
    if (path === '/posts' && opts.method === 'POST') {
      createCount++;
      const body = JSON.parse(opts.body);
      const id = `p-${++idCounter}`;
      const requiresVerification = options.verification !== false;
      const post = {
        id,
        title: body.title,
        content: body.content || null,
        verification_status: requiresVerification ? 'pending' : 'verified',
        is_deleted: false,
      };
      posts.set(id, post);
      if (!requiresVerification) return { success: true, post: structuredClone(post) };
      const code = `v-${idCounter}`;
      pendingByCode.set(code, id);
      return {
        success: true,
        post: structuredClone(post),
        verification: {
          verification_code: code,
          challenge_text: options.challenge || 'eight times seven',
        },
      };
    }

    if (path.startsWith('/posts/') && !opts.method) {
      const id = path.split('/')[2];
      const post = posts.get(id);
      if (!post) return { success: false, error: 'not found' };
      return { success: true, post: structuredClone(post) };
    }

    if (path === '/verify' && opts.method === 'POST') {
      verifyCount++;
      const body = JSON.parse(opts.body);
      const id = pendingByCode.get(body.verification_code);
      if (!id) return { success: false, error: 'Unknown verification code' };
      if (options.verifyFails) return { success: false, error: 'Incorrect answer' };
      if (body.answer !== (options.expectedAnswer || '56.00')) {
        const post = posts.get(id);
        post.verification_status = 'failed';
        return { success: false, error: 'Incorrect answer' };
      }
      const post = posts.get(id);
      if (options.verifySuccessWithoutImmediateReadback) {
        return { success: true };
      }
      post.verification_status = 'verified';
      return { success: true, post: structuredClone(post) };
    }

    throw new Error(`Unhandled request: ${path}`);
  }

  return {
    request,
    posts,
    markVerified(id) {
      const post = posts.get(id);
      if (!post) throw new Error(`Unknown post: ${id}`);
      post.verification_status = 'verified';
    },
    get createCount() { return createCount; },
    get verifyCount() { return verifyCount; },
  };
}

const input = {
  submolt: 'general',
  title: 'Useful business agents wanted',
  content: 'Bring specific operator-grade criticism.',
};

test('publication classification requires provider verified status', () => {
  assert.deepEqual(
    classifyPostPublication({ id: 'p1', verification_status: 'verified', is_deleted: false }),
    { state: 'published', reason: 'verification_status_verified' },
  );
  assert.deepEqual(
    classifyPostPublication({ id: 'p2', verification_status: 'pending', is_deleted: false }),
    { state: 'verification_pending', reason: 'verification_status_pending' },
  );
  assert.equal(classifyPostPublication({ id: 'p3' }).state, 'unknown');
});

test('ghost post readback stays pending and retry never creates a second post', async () => {
  const api = fakeMoltbook({ verification: true });
  const c = createPostWriteCoordinator({ request: api.request, store: createMemoryStore() });

  const first = await c.submit(input);
  assert.equal(first.success, false);
  assert.equal(first.state, 'verification_pending');
  assert.equal(first.post.verification_status, 'pending');
  assert.equal(first.safe_to_recreate, false);
  assert.equal(api.createCount, 1);

  const second = await c.submit(input);
  assert.equal(second.success, false);
  assert.equal(second.state, 'verification_pending');
  assert.equal(second.post.verification_status, 'pending');
  assert.notEqual(second.state, 'published');
  assert.equal(second.already_published, undefined);
  assert.equal(api.createCount, 1, 'HTTP-200 readback of a pending post must not authorize another create');
});

test('agent-supplied answer verifies the same durable post intent', async () => {
  const api = fakeMoltbook({ verification: true, challenge: 'two crustaceans each carry mysterious bundles', expectedAnswer: '56.00' });
  const store = createMemoryStore();
  const c = createPostWriteCoordinator({ request: api.request, store });

  const pending = await c.submit(input);
  assert.equal(pending.state, 'verification_pending');
  assert.equal(api.verifyCount, 0, 'post creation must not auto-solve semantic challenges');

  const verified = await c.verify({
    verification_code: pending.verification_code,
    challenge: pending.challenge,
    answer: '56.00',
  });
  assert.equal(verified.success, true);
  assert.equal(verified.state, 'published');
  assert.equal(verified._answer_source, 'agent');
  assert.equal(api.verifyCount, 1);

  const retry = await c.submit(input);
  assert.equal(retry.success, true);
  assert.equal(retry.already_published, true);
  assert.equal(api.createCount, 1);
});

test('compat parser is fallback only when no explicit answer is supplied', async () => {
  const api = fakeMoltbook({ verification: true, challenge: 'eight times seven' });
  const c = createPostWriteCoordinator({ request: api.request, store: createMemoryStore() });
  const pending = await c.submit(input);
  const verified = await c.verify({ verification_code: pending.verification_code });
  assert.equal(verified.success, true);
  assert.equal(verified._answer_source, 'compat_parser');
  assert.equal(api.verifyCount, 1);
});

test('accepted post verification is spent during readback lag and later reconciles without resubmission', async () => {
  const api = fakeMoltbook({ verification: true, verifySuccessWithoutImmediateReadback: true });
  const c = createPostWriteCoordinator({ request: api.request, store: createMemoryStore() });
  const pending = await c.submit(input);

  const accepted = await c.verify({ verification_code: pending.verification_code, answer: '56.00' });
  assert.equal(accepted.success, false);
  assert.equal(accepted.state, 'verification_succeeded_pending_reconciliation');
  assert.equal(accepted.verification_accepted, true);
  assert.equal(api.verifyCount, 1);

  const secondVerify = await c.verify({ verification_code: pending.verification_code, answer: '999.00' });
  assert.equal(secondVerify.success, false);
  assert.equal(secondVerify.state, 'verification_succeeded_pending_reconciliation');
  assert.equal(secondVerify.verification_accepted, true);
  assert.equal(api.verifyCount, 1, 'accepted answer must never be resubmitted while readback lags');

  api.markVerified(pending.post_id);
  const reconciled = await c.submit(input);
  assert.equal(reconciled.success, true);
  assert.equal(reconciled.state, 'published');
  assert.equal(reconciled.already_published, true);
  assert.equal(api.verifyCount, 1);
  assert.equal(api.createCount, 1);
});

test('provider-rejected post verification is terminal and cannot spend a second attempt', async () => {
  const api = fakeMoltbook({ verification: true, expectedAnswer: '75.00' });
  const c = createPostWriteCoordinator({ request: api.request, store: createMemoryStore() });
  const pending = await c.submit(input);
  const rejected = await c.verify({ verification_code: pending.verification_code, answer: '40.00' });
  assert.equal(rejected.success, false);
  assert.equal(rejected.state, 'verification_rejected');
  assert.equal(rejected.post.verification_status, 'failed');
  assert.equal(api.verifyCount, 1);

  const second = await c.verify({ verification_code: pending.verification_code, answer: '75.00' });
  assert.equal(second.success, false);
  assert.equal(second.state, 'verification_rejected');
  assert.equal(api.verifyCount, 1, 'terminal rejection must not consume another provider attempt');
});

test('ABSTAIN is terminal for the durable post intent and never recreates', async () => {
  const api = fakeMoltbook({ verification: true, challenge: 'ambiguous nonsense' });
  const c = createPostWriteCoordinator({ request: api.request, store: createMemoryStore() });
  const pending = await c.submit(input);
  const abstained = await c.verify({ verification_code: pending.verification_code, answer: 'ABSTAIN' });
  assert.equal(abstained.success, false);
  assert.equal(abstained.state, 'abstained');
  assert.equal(api.verifyCount, 0);

  const retry = await c.submit(input);
  assert.equal(retry.state, 'abstained');
  assert.equal(api.createCount, 1);
});

test('durable post intent survives coordinator restart and prevents duplicate create', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moltbook-post-write-'));
  try {
    const api = fakeMoltbook({ verification: true });
    const c1 = createPostWriteCoordinator({ request: api.request, store: createDurablePostWriteStore(dir) });
    const first = await c1.submit(input);
    assert.equal(first.state, 'verification_pending');

    const c2 = createPostWriteCoordinator({ request: api.request, store: createDurablePostWriteStore(dir) });
    const second = await c2.submit(input);
    assert.equal(second.state, 'verification_pending');
    assert.equal(api.createCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
