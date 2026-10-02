import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createCommentWriteCoordinator,
  createFileIntentStore,
  createMemoryStore,
  parseVerificationChallenge,
} from '../providers/comment-writes.js';

function fakeMoltbook(options = {}) {
  const identity = { id: 'agent-me', name: 'heartbeat-agent' };
  const comments = new Map();
  const pendingByCode = new Map();
  let createCount = 0;
  let verifyCount = 0;
  let idCounter = 0;
  let threadFailures = options.threadFailures || 0;
  const nowIso = () => new Date(options.nowMs || Date.now()).toISOString();

  function list(postId) { return comments.get(postId) || []; }
  function publish(postId, comment) {
    const arr = list(postId);
    if (!arr.some(c => c.id === comment.id)) arr.push(comment);
    comments.set(postId, arr);
  }

  async function request(path, opts = {}) {
    if (path === '/home') return { success: true, your_account: identity };
    if (path.startsWith('/posts/') && path.includes('/comments?')) {
      if (threadFailures > 0) {
        threadFailures--;
        return { success: false, error: 'temporary read failure' };
      }
      const postId = path.split('/')[2];
      return { success: true, comments: structuredClone(list(postId)), has_more: false };
    }
    if (path.startsWith('/posts/') && path.endsWith('/comments') && opts.method === 'POST') {
      createCount++;
      if (options.createDelayMs) await new Promise(r => setTimeout(r, options.createDelayMs));
      const postId = path.split('/')[2];
      const body = JSON.parse(opts.body);
      const id = `c-${++idCounter}`;
      const comment = { id, content: body.content, parent_id: body.parent_id || null, author: identity, created_at: nowIso() };
      if (options.creationReject) return { success: false, error: 'auth unavailable' };
      if (!options.verification) {
        publish(postId, comment);
        return { success: true, comment };
      }
      const code = `v-${idCounter}`;
      pendingByCode.set(code, { postId, comment });
      if (options.publishBeforeVerify) publish(postId, comment);
      const response = {
        success: true,
        verification: { verification_code: code, challenge_text: options.challenge || 'eight times seven' },
      };
      if (!options.omitCreateCommentId) response.comment = { ...comment };
      return response;
    }
    if (path === '/verify' && opts.method === 'POST') {
      verifyCount++;
      const body = JSON.parse(opts.body);
      const pending = pendingByCode.get(body.verification_code);
      if (options.verifyFails) return { success: false, error: 'Incorrect answer' };
      if (!pending) return { success: false, error: 'Unknown verification code' };
      if (body.answer !== (options.expectedAnswer || '56.00')) return { success: false, error: 'Incorrect answer' };
      publish(pending.postId, pending.comment);
      return { success: true, comment: pending.comment };
    }
    throw new Error(`Unhandled request: ${path}`);
  }

  return {
    request,
    comments,
    get createCount() { return createCount; },
    get verifyCount() { return verifyCount; },
  };
}

const baseInput = { post_id: 'post-1', content: 'hello from heartbeat' };

test('regression fixture reproduces the legacy duplicate sequence before reconciliation', async () => {
  const api = fakeMoltbook({ verification: true, publishBeforeVerify: true, verifyFails: true });
  const body = JSON.stringify({ content: baseInput.content });
  const first = await api.request('/posts/post-1/comments', { method: 'POST', body });
  const code = first.verification.verification_code;
  const verify = await api.request('/verify', { method: 'POST', body: JSON.stringify({ verification_code: code, answer: '56.00' }) });
  assert.equal(verify.success, false);
  assert.equal(api.comments.get('post-1').length, 1, 'the first comment is already live despite verify failure');
  await api.request('/posts/post-1/comments', { method: 'POST', body });
  assert.equal(api.createCount, 2);
  assert.equal(api.comments.get('post-1').length, 2, 'blind recreate duplicates the live comment');
});

test('strict verification parser handles observed arithmetic forms without treating bare and as plus', () => {
  const cases = [
    ['eight plus four', 12],
    ['sum of eight and four', 12],
    ['ten minus three', 7],
    ['subtract three from ten', 7],
    ['eight times seven', 56],
    ['product of eight and seven', 56],
    ['multiply twelve by three', 36],
    ['divide twelve by three', 4],
    ['12 / 3', 4],
    ['A lobster moves 23 cm per second for 4 seconds. How far does it travel?', 92],
    ['ThIrTy TwO NeWtOnS times SeVeN', 224],
  ];
  for (const [challenge, answer] of cases) {
    const parsed = parseVerificationChallenge(challenge);
    assert.equal(parsed.success, true, challenge);
    assert.equal(parsed.answer, answer, challenge);
  }
  assert.equal(parseVerificationChallenge('eight and seven').success, false);
  assert.equal(parseVerificationChallenge('eight plus seven times two').success, false);
});

test('normal comment requiring verification succeeds and publishes once', async () => {
  const api = fakeMoltbook({ verification: true, challenge: 'eight times seven' });
  const c = createCommentWriteCoordinator({ request: api.request, store: createMemoryStore() });
  const result = await c.submit(baseInput);
  assert.equal(result.success, true);
  assert.equal(api.createCount, 1);
  assert.equal(api.verifyCount, 1);
  assert.equal(api.comments.get('post-1').length, 1);
});

test('agent-owned comment verification returns raw challenge and accepts explicit answer', async () => {
  const api = fakeMoltbook({ verification: true, challenge: 'mysterious phrasing', expectedAnswer: '56.00' });
  const c = createCommentWriteCoordinator({ request: api.request, store: createMemoryStore() });
  const pending = await c.submit(baseInput, { auto_verify: false });
  assert.equal(pending.success, false);
  assert.equal(pending.state, 'verification_pending');
  assert.equal(pending.challenge, 'mysterious phrasing');
  assert.equal(api.verifyCount, 0);
  const result = await c.verify({
    verification_code: pending.verification_code,
    challenge: pending.challenge,
    answer: '56.00',
  });
  assert.equal(result.success, true);
  assert.equal(api.verifyCount, 1);
  assert.equal(api.comments.get('post-1').length, 1);
});

test('incorrect comment verification is terminal and cannot be retried with another answer', async () => {
  const api = fakeMoltbook({ verification: true, challenge: 'mysterious phrasing', expectedAnswer: '75.00' });
  const c = createCommentWriteCoordinator({ request: api.request, store: createMemoryStore() });
  const pending = await c.submit(baseInput, { auto_verify: false });
  const rejected = await c.verify({ verification_code: pending.verification_code, answer: '40.00' });
  assert.equal(rejected.success, false);
  assert.equal(rejected.state, 'verification_rejected');
  assert.equal(api.verifyCount, 1);

  const second = await c.verify({ verification_code: pending.verification_code, answer: '75.00' });
  assert.equal(second.success, false);
  assert.equal(second.state, 'verification_rejected');
  assert.equal(api.verifyCount, 1, 'terminal rejection must not consume another provider attempt');
});

test('verification reports failure but already-published comment reconciles as success', async () => {
  const api = fakeMoltbook({ verification: true, publishBeforeVerify: true, verifyFails: true });
  const c = createCommentWriteCoordinator({ request: api.request, store: createMemoryStore() });
  const result = await c.submit(baseInput);
  assert.equal(result.success, true);
  assert.equal(result.reconciled, true);
  assert.equal(api.createCount, 1);
  assert.equal(api.verifyCount, 1);
  assert.equal(api.comments.get('post-1').length, 1);
});

test('malformed challenge fails safely and retry does not recreate', async () => {
  const api = fakeMoltbook({ verification: true, challenge: 'eight and seven mysterious units', omitCreateCommentId: true });
  const store = createMemoryStore();
  const c = createCommentWriteCoordinator({ request: api.request, store });
  const first = await c.submit(baseInput);
  assert.equal(first.success, false);
  assert.equal(first.state, 'verification_unparseable');
  assert.equal(first.safe_to_recreate, false);
  const second = await c.submit(baseInput);
  assert.equal(second.success, false);
  assert.equal(api.createCount, 1);
  assert.equal(api.verifyCount, 0);
});

test('ambiguous create/verify result reconciles on retry without second create', async () => {
  const api = fakeMoltbook({ verification: true, publishBeforeVerify: true, verifyFails: true, threadFailures: 1 });
  const store = createMemoryStore();
  const c = createCommentWriteCoordinator({ request: api.request, store });
  const first = await c.submit(baseInput);
  assert.equal(first.success, false);
  assert.equal(first.state, 'verification_pending');
  const second = await c.submit(baseInput);
  assert.equal(second.success, true);
  assert.equal(second.reconciled, true);
  assert.equal(api.createCount, 1);
  assert.equal(api.comments.get('post-1').length, 1);
});

test('same text in a genuinely different post is not deduplicated', async () => {
  const api = fakeMoltbook();
  const c = createCommentWriteCoordinator({ request: api.request, store: createMemoryStore() });
  assert.equal((await c.submit({ post_id: 'post-a', content: 'same text' })).success, true);
  assert.equal((await c.submit({ post_id: 'post-b', content: 'same text' })).success, true);
  assert.equal(api.createCount, 2);
});

test('reply reconciliation respects parent_id and does not match same text in another context', async () => {
  const api = fakeMoltbook({ verification: true, publishBeforeVerify: true, verifyFails: true, omitCreateCommentId: true });
  api.comments.set('post-1', [{
    id: 'other', content: 'same reply', parent_id: 'parent-other',
    author: { id: 'agent-me', name: 'heartbeat-agent' }, created_at: new Date().toISOString(),
  }]);
  const c = createCommentWriteCoordinator({ request: api.request, store: createMemoryStore() });
  const result = await c.submit({ post_id: 'post-1', parent_id: 'parent-target', content: 'same reply' });
  assert.equal(result.success, true);
  assert.equal(result.reconciled, true);
  assert.equal(api.createCount, 1);
  assert.notEqual(result.comment_id, 'other');
});

test('sequential heartbeat processes share durable intent and cannot duplicate ambiguous write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moltbook-write-test-'));
  try {
    const api = fakeMoltbook({ verification: true, publishBeforeVerify: true, verifyFails: true, threadFailures: 1 });
    const c1 = createCommentWriteCoordinator({ request: api.request, store: createFileIntentStore(dir) });
    const first = await c1.submit(baseInput);
    assert.equal(first.success, false);
    const c2 = createCommentWriteCoordinator({ request: api.request, store: createFileIntentStore(dir) });
    const second = await c2.submit(baseInput);
    assert.equal(second.success, true);
    assert.equal(api.createCount, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent duplicate calls single-flight at the write boundary', async () => {
  const api = fakeMoltbook({ createDelayMs: 40 });
  const store = createMemoryStore();
  const c = createCommentWriteCoordinator({ request: api.request, store });
  const [a, b] = await Promise.all([c.submit(baseInput), c.submit(baseInput)]);
  assert.equal(api.createCount, 1);
  assert.equal([a, b].filter(x => x.success).length, 1);
  assert.equal([a, b].filter(x => x.reason === 'write_in_progress').length, 1);
});

test('pending retry reconciles legacy queued comment before creating anything', async () => {
  const api = fakeMoltbook();
  const existing = {
    id: 'existing-1', content: 'queued text', parent_id: null,
    author: { id: 'agent-me', name: 'heartbeat-agent' }, created_at: new Date().toISOString(),
  };
  api.comments.set('post-q', [existing]);
  const c = createCommentWriteCoordinator({ request: api.request, store: createMemoryStore() });
  const result = await c.retryPending({ post_id: 'post-q', content: 'queued text', queued_at: new Date().toISOString() });
  assert.equal(result.success, true);
  assert.equal(result.reconciled, true);
  assert.equal(result.comment_id, 'existing-1');
  assert.equal(api.createCount, 0);
});
