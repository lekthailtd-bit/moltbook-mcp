import { createHash, randomUUID } from 'crypto';
import {
  mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync,
  openSync, closeSync, unlinkSync, statSync, chmodSync,
} from 'fs';
import { join } from 'path';
import { moltFetch } from './api.js';

const DEFAULT_DIR = join(process.env.HOME || '/tmp', '.config', 'moltbook', 'comment-writes');
const LOCK_STALE_MS = 5 * 60 * 1000;
const RECONCILE_WINDOW_MS = 20 * 60 * 1000;
const MAX_INTENTS = 500;
const INTENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function canonicalContent(value) {
  return String(value ?? '').normalize('NFC').replace(/\r\n/g, '\n');
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function commentWriteKey({ post_id, parent_id = null, content, idempotency_key = null }) {
  return hash(['comment-v1', post_id, parent_id || '', canonicalContent(content), idempotency_key || ''].join('\0'));
}

function parseNumberishToken(token) {
  if (/^-?\d+(?:\.\d+)?$/.test(token)) return Number(token);
  return null;
}

const ONES = new Map(Object.entries({
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
}));
const TENS = new Map(Object.entries({ twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }));
const SCALE = new Map(Object.entries({ hundred: 100, thousand: 1000 }));

function normalizeChallenge(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/×/g, ' * ')
    .replace(/\bx\b/g, ' * ')
    .replace(/÷/g, ' / ')
    .replace(/(?<=[a-z])[^a-z0-9\s](?=[a-z])/g, '')
    .replace(/[^a-z0-9.+\-*/\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readNumberWords(tokens, start) {
  let total = 0;
  let current = 0;
  let used = 0;
  let saw = false;
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i];
    const direct = parseNumberishToken(token);
    if (direct !== null) {
      if (used > 0) break;
      return { value: direct, used: 1 };
    }
    if (ONES.has(token)) {
      current += ONES.get(token);
      saw = true;
      used++;
      continue;
    }
    if (TENS.has(token)) {
      current += TENS.get(token);
      saw = true;
      used++;
      continue;
    }
    if (SCALE.has(token)) {
      if (!saw) break;
      const scale = SCALE.get(token);
      if (scale === 100) current = Math.max(1, current) * 100;
      else { total += Math.max(1, current) * scale; current = 0; }
      used++;
      continue;
    }
    break;
  }
  return used ? { value: total + current, used } : null;
}

function extractNumbers(normalized) {
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < tokens.length;) {
    const parsed = readNumberWords(tokens, i);
    if (parsed) {
      out.push({ value: parsed.value, start: i, end: i + parsed.used - 1 });
      i += parsed.used;
    } else {
      i++;
    }
  }
  return out;
}

function arithmeticResult(op, a, b, reverse = false) {
  const left = reverse ? b : a;
  const right = reverse ? a : b;
  let answer;
  if (op === '+') answer = left + right;
  else if (op === '-') answer = left - right;
  else if (op === '*') answer = left * right;
  else if (op === '/') answer = right === 0 ? NaN : left / right;
  if (!Number.isFinite(answer)) return null;
  return { success: true, answer, formatted: Number(answer).toFixed(2), expression: `${left} ${op} ${right}` };
}

export function parseVerificationChallenge(challenge) {
  if (!challenge || typeof challenge !== 'string') return { success: false, error: 'Missing math challenge', challenge };
  const normalized = normalizeChallenge(challenge);
  const nums = extractNumbers(normalized);
  if (nums.length < 2) return { success: false, error: 'Could not identify two operands', challenge, normalized };
  const [first, second] = nums;

  const symbolic = normalized.match(/(?:^|\s)(-?\d+(?:\.\d+)?)\s*([+\-*/])\s*(-?\d+(?:\.\d+)?)(?:\s|$)/);
  if (symbolic) {
    const extraOps = (normalized.match(/[+*/]/g) || []).length + (normalized.match(/\s-\s/g) || []).length;
    if (extraOps === 1) return arithmeticResult(symbolic[2], Number(symbolic[1]), Number(symbolic[3]));
  }

  const families = [];
  if (/\b(product|times|multiply|multiplied)\b/.test(normalized)) families.push('*');
  if (/\b(sum|plus|add|added|combined|together|total)\b/.test(normalized)) families.push('+');
  if (/\b(difference|minus|subtract|subtracted|remaining|left)\b/.test(normalized)) families.push('-');
  if (/\b(quotient|divide|divided)\b/.test(normalized)) families.push('/');

  const asksDistance = /\b(how far|distance|travel|travels|traveled|travelled)\b/.test(normalized);
  const hasRate = /\b(per second|per sec|each second|speed|velocity|rate)\b/.test(normalized);
  const hasDuration = /\b(for|over)\b/.test(normalized) && /\b(seconds?|secs?|minutes?|mins?|hours?)\b/.test(normalized);
  if (asksDistance && hasRate && hasDuration) families.push('*');

  const uniqueFamilies = [...new Set(families)];
  if (uniqueFamilies.length !== 1) {
    return { success: false, error: uniqueFamilies.length ? 'Ambiguous arithmetic operator' : 'Could not determine arithmetic operator', challenge, normalized };
  }

  const op = uniqueFamilies[0];
  const reverse = op === '-' && /\bsubtract\b.*\bfrom\b/.test(normalized);
  return arithmeticResult(op, first.value, second.value, reverse) || { success: false, error: 'Invalid arithmetic result', challenge, normalized };
}

export function extractVerification(data) {
  if (!data) return null;
  const verification = data.verification || data.comment?.verification || data.post?.verification || data.data?.verification || data;
  const verification_code = verification?.verification_code;
  const challenge = verification?.challenge_text || verification?.challenge || verification?.math_challenge || verification?.question;
  if (!verification_code) return null;
  return { verification_code, challenge: challenge || null };
}

function extractStableIds(data) {
  const ids = new Set();
  const candidates = [
    data?.comment?.id, data?.data?.comment?.id, data?.comment_id, data?.content_id,
    data?.data?.comment_id, data?.data?.content_id,
  ];
  for (const id of candidates) if (id) ids.add(String(id));
  return [...ids];
}

function commentTimestamp(comment) {
  const raw = comment?.created_at || comment?.createdAt || comment?.published_at || comment?.timestamp;
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function flattenComments(comments, inferredParent = null, out = []) {
  for (const comment of comments || []) {
    const parent = comment.parent_id ?? comment.parent?.id ?? inferredParent ?? null;
    out.push({ comment, parent_id: parent });
    if (Array.isArray(comment.replies)) flattenComments(comment.replies, comment.id || parent, out);
  }
  return out;
}

function sameAuthor(comment, identity) {
  if (!identity) return false;
  const author = comment?.author || {};
  const identityId = identity.id || identity.agent_id || identity.user_id;
  const authorId = author.id || author.agent_id || author.user_id;
  if (identityId && authorId) return String(identityId) === String(authorId);
  const identityName = identity.name || identity.username;
  const authorName = author.name || author.username;
  return Boolean(identityName && authorName && String(identityName) === String(authorName));
}

function makeResult(intent, extra = {}) {
  return {
    success: intent?.status === 'published',
    state: intent?.status || 'unknown',
    write_key: intent?.key || null,
    comment_id: intent?.comment_id || null,
    content_id: intent?.content_id || null,
    reconciled: Boolean(intent?.reconciled),
    safe_to_recreate: false,
    ...extra,
  };
}

export function createFileIntentStore(baseDir = process.env.MOLTBOOK_COMMENT_WRITE_DIR || DEFAULT_DIR) {
  const intentsDir = join(baseDir, 'intents');
  const locksDir = join(baseDir, 'locks');
  function ensure() {
    mkdirSync(intentsDir, { recursive: true, mode: 0o700 });
    mkdirSync(locksDir, { recursive: true, mode: 0o700 });
    try { chmodSync(baseDir, 0o700); chmodSync(intentsDir, 0o700); chmodSync(locksDir, 0o700); } catch {}
  }
  function file(key) { return join(intentsDir, `${key}.json`); }
  function load(key) {
    ensure();
    try { return JSON.parse(readFileSync(file(key), 'utf8')); } catch { return null; }
  }
  function prune() {
    let files;
    try { files = readdirSync(intentsDir).filter(n => n.endsWith('.json')).map(n => join(intentsDir, n)); } catch { return; }
    const now = Date.now();
    const meta = files.map(path => { try { return { path, stat: statSync(path) }; } catch { return null; } }).filter(Boolean).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    for (let i = 0; i < meta.length; i++) {
      if (i >= MAX_INTENTS || now - meta[i].stat.mtimeMs > INTENT_RETENTION_MS) try { unlinkSync(meta[i].path); } catch {}
    }
  }
  function save(intent) {
    ensure();
    const dest = file(intent.key);
    const tmp = `${dest}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(intent, null, 2), { mode: 0o600 });
    renameSync(tmp, dest);
    try { chmodSync(dest, 0o600); } catch {}
    prune();
  }
  function list() {
    ensure();
    return readdirSync(intentsDir).filter(n => n.endsWith('.json')).map(n => {
      try { return JSON.parse(readFileSync(join(intentsDir, n), 'utf8')); } catch { return null; }
    }).filter(Boolean);
  }
  function findByVerificationCode(code) { return list().find(i => i.verification_code === code) || null; }
  function acquire(key) {
    ensure();
    const lockPath = join(locksDir, `${key}.lock`);
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
      return () => { try { closeSync(fd); } catch {} try { unlinkSync(lockPath); } catch {} };
    } catch (err) {
      if (err?.code !== 'EEXIST') return null;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          return acquire(key);
        }
      } catch {}
      return null;
    }
  }
  return { load, save, list, findByVerificationCode, acquire };
}

export function createMemoryStore() {
  const intents = new Map();
  const locks = new Set();
  return {
    load: key => intents.has(key) ? structuredClone(intents.get(key)) : null,
    save: intent => intents.set(intent.key, structuredClone(intent)),
    list: () => [...intents.values()].map(v => structuredClone(v)),
    findByVerificationCode: code => [...intents.values()].find(i => i.verification_code === code) || null,
    acquire: key => {
      if (locks.has(key)) return null;
      locks.add(key);
      return () => locks.delete(key);
    },
  };
}

async function fetchIdentity(request) {
  const home = await request('/home');
  if (!home || home.success === false || home.error) return null;
  return home.your_account || home.account || home.agent || null;
}

async function fetchAllComments(request, postId) {
  const comments = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({ sort: 'new', limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const data = await request(`/posts/${postId}/comments?${query.toString()}`);
    if (!data || data.success === false || data.error) return { ok: false, error: data?.error || 'Failed to fetch comments', comments };
    if (Array.isArray(data.comments)) comments.push(...data.comments);
    if (!data.has_more || !data.next_cursor) return { ok: true, comments };
    if (seen.has(data.next_cursor)) return { ok: false, error: 'Comment pagination repeated a cursor', comments };
    seen.add(data.next_cursor);
    cursor = data.next_cursor;
  }
  return { ok: false, error: 'Comment pagination exceeded safety limit', comments };
}

export function createCommentWriteCoordinator({ request = moltFetch, store = createFileIntentStore(), now = () => Date.now(), reconcileWindowMs = RECONCILE_WINDOW_MS } = {}) {
  async function reconcile(intent) {
    let thread;
    try { thread = await fetchAllComments(request, intent.post_id); }
    catch (err) { return { state: 'unknown', reason: `thread_fetch_failed:${err.message}` }; }
    if (!thread.ok) return { state: 'unknown', reason: `thread_fetch_failed:${thread.error}` };
    const flat = flattenComments(thread.comments);

    const stableIds = new Set([...(intent.stable_ids || []), intent.comment_id, intent.content_id].filter(Boolean).map(String));
    if (stableIds.size) {
      const byId = flat.find(({ comment }) => stableIds.has(String(comment.id || comment.comment_id || comment.content_id || '')));
      if (byId) return { state: 'published', comment: byId.comment, reason: 'stable_id' };
    }

    let identity;
    try { identity = await fetchIdentity(request); }
    catch (err) { return { state: 'unknown', reason: `identity_fetch_failed:${err.message}` }; }
    if (!identity) return { state: 'unknown', reason: 'identity_unavailable' };

    const firstAttempt = new Date(intent.first_attempt_at || intent.created_at || 0).getTime();
    const matches = flat.filter(({ comment, parent_id }) => {
      if (canonicalContent(comment.content) !== canonicalContent(intent.content)) return false;
      if (String(parent_id || '') !== String(intent.parent_id || '')) return false;
      if (!sameAuthor(comment, identity)) return false;
      const ts = commentTimestamp(comment);
      if (!Number.isFinite(firstAttempt) || !ts) return false;
      return ts >= firstAttempt - 5000 && ts <= firstAttempt + reconcileWindowMs;
    });
    if (matches.length === 1) return { state: 'published', comment: matches[0].comment, reason: 'context_author_content_time' };
    if (matches.length > 1) return { state: 'ambiguous_multiple', reason: 'multiple_exact_matches' };
    return { state: 'absent', reason: 'authoritative_no_match' };
  }

  function persist(intent, patch = {}) {
    Object.assign(intent, patch, { updated_at: new Date(now()).toISOString() });
    store.save(intent);
    return intent;
  }

  function publish(intent, comment, reason) {
    const stableIds = extractStableIds({ comment });
    return persist(intent, {
      status: 'published',
      comment_id: comment?.id || intent.comment_id || stableIds[0] || null,
      stable_ids: [...new Set([...(intent.stable_ids || []), ...stableIds])],
      reconciled: reason !== 'create_response' && reason !== 'verify_response',
      reconciliation_reason: reason,
      last_error: null,
    });
  }

  async function reconcileAndPersist(intent) {
    const result = await reconcile(intent);
    if (result.state === 'published') {
      publish(intent, result.comment, result.reason);
      return makeResult(intent, { already_published: true });
    }
    persist(intent, { last_reconciliation: result, last_reconciled_at: new Date(now()).toISOString() });
    return { success: false, state: result.state, reason: result.reason, write_key: intent.key, safe_to_recreate: false };
  }

  function isTerminalVerificationFailure(data) {
    if (!data || data.success !== false) return false;
    const message = `${data.error || ''} ${data.message || ''}`.toLowerCase();
    return /incorrect answer|wrong answer|invalid answer|verification (?:failed|rejected|expired)|challenge (?:failed|rejected|expired)|expired challenge/.test(message);
  }

  async function attemptVerification(intent, challenge, explicit = false, suppliedAnswer = null) {
    let parsed;
    const direct = suppliedAnswer == null ? '' : String(suppliedAnswer).trim();
    if (direct) {
      parsed = { success: true, formatted: direct, expression: 'agent_supplied' };
    } else {
      parsed = parseVerificationChallenge(challenge);
      if (!parsed.success) {
        persist(intent, { status: 'verification_unparseable', parser_error: parsed.error, challenge });
        return { parsed, verifyData: null };
      }
    }
    const prior = (intent.verification_attempts || []).find(a => a.answer === parsed.formatted);
    if (prior && !explicit) return { parsed, verifyData: prior.response || null, skipped: true };
    let verifyData;
    try {
      verifyData = await request('/verify', {
        method: 'POST',
        body: JSON.stringify({ verification_code: intent.verification_code, answer: parsed.formatted }),
      });
    } catch (err) {
      verifyData = { success: false, error: `Verification request failed: ${err.message}` };
    }
    const attempts = [...(intent.verification_attempts || []), {
      at: new Date(now()).toISOString(),
      answer: parsed.formatted,
      expression: parsed.expression,
      source: direct ? 'agent' : 'compat_parser',
      response: verifyData,
    }];
    const stable = extractStableIds(verifyData);
    const terminalFailure = isTerminalVerificationFailure(verifyData);
    persist(intent, {
      verification_attempts: attempts,
      stable_ids: [...new Set([...(intent.stable_ids || []), ...stable])],
      status: verifyData?.success
        ? 'verification_succeeded'
        : terminalFailure ? 'verification_rejected' : 'verification_pending',
      last_error: verifyData?.success ? null : (verifyData?.error || 'Verification did not report success'),
    });
    if (verifyData?.success && verifyData?.comment) publish(intent, verifyData.comment, 'verify_response');
    return { parsed, verifyData };
  }

  async function submit(input, options = {}) {
    const content = canonicalContent(input.content);
    const key = commentWriteKey({ ...input, content });
    const release = store.acquire(key);
    if (!release) return { success: false, state: 'ambiguous', reason: 'write_in_progress', write_key: key, safe_to_recreate: false };
    try {
      let intent = store.load(key);
      if (intent?.status === 'published') return makeResult(intent, { already_published: true });
      if (intent?.status === 'abstained') return makeResult(intent, { state: 'abstained', reason: 'verification_abstained' });

      if (intent?.create_started_at) {
        const reconciled = await reconcileAndPersist(intent);
        if (reconciled.success) return reconciled;

        if (intent.verification_code) {
          const challenge = intent.challenge;
          if (options.auto_verify !== false && challenge) {
            await attemptVerification(intent, challenge, false);
            const afterVerify = await reconcileAndPersist(intent);
            if (afterVerify.success) return afterVerify;
            return {
              success: false,
              state: intent.status === 'verification_unparseable' ? 'verification_unparseable' : 'verification_pending',
              reason: intent.last_error || afterVerify.reason,
              write_key: key,
              verification_code: intent.verification_code,
              challenge: intent.challenge,
              safe_to_recreate: false,
            };
          }
          return {
            success: false,
            state: intent.status === 'verification_unparseable' ? 'verification_unparseable' : 'verification_pending',
            reason: intent.last_error || reconciled.reason,
            write_key: key,
            verification_code: intent.verification_code,
            challenge: intent.challenge,
            safe_to_recreate: false,
          };
        }

        if (!(intent.status === 'creation_rejected' && reconciled.state === 'absent')) {
          return { success: false, state: 'ambiguous', reason: reconciled.reason, write_key: key, safe_to_recreate: false };
        }
      }

      if (!intent) {
        intent = {
          key,
          kind: 'comment',
          post_id: input.post_id,
          parent_id: input.parent_id || null,
          content,
          idempotency_key: input.idempotency_key || null,
          created_at: new Date(now()).toISOString(),
          first_attempt_at: options.first_attempt_at || new Date(now()).toISOString(),
          status: 'prepared',
          create_attempts: 0,
          stable_ids: [],
        };
        store.save(intent);

        if (options.reconcile_before_create) {
          const pre = await reconcileAndPersist(intent);
          if (pre.success) return pre;
          if (pre.state !== 'absent') {
            persist(intent, { status: 'ambiguous', last_error: `Pre-create reconciliation failed: ${pre.reason}` });
            return { ...pre, state: 'ambiguous', safe_to_recreate: false };
          }
        }
      }

      persist(intent, {
        status: 'creating',
        create_started_at: new Date(now()).toISOString(),
        create_attempts: (intent.create_attempts || 0) + 1,
      });

      const body = { content };
      if (input.parent_id) body.parent_id = input.parent_id;
      let data;
      try {
        data = await request(`/posts/${input.post_id}/comments`, { method: 'POST', body: JSON.stringify(body) });
      } catch (err) {
        persist(intent, { status: 'create_ambiguous', last_error: `Create request failed: ${err.message}` });
        const reconciled = await reconcileAndPersist(intent);
        if (reconciled.success) return reconciled;
        return { success: false, state: 'ambiguous', reason: intent.last_error, write_key: key, safe_to_recreate: false };
      }

      const stable = extractStableIds(data);
      const verification = extractVerification(data);
      persist(intent, {
        create_response: data,
        stable_ids: [...new Set([...(intent.stable_ids || []), ...stable])],
        comment_id: data?.comment?.id || intent.comment_id || null,
        content_id: data?.content_id || intent.content_id || null,
        verification_code: verification?.verification_code || intent.verification_code || null,
        challenge: verification?.challenge || intent.challenge || null,
      });

      if (data?.success && data?.comment && !verification) {
        publish(intent, data.comment, 'create_response');
        return makeResult(intent);
      }

      if (verification) {
        persist(intent, { status: 'verification_pending' });
        if (verification.challenge && options.auto_verify !== false) {
          await attemptVerification(intent, verification.challenge, false);
        }
        const reconciled = await reconcileAndPersist(intent);
        if (reconciled.success) return reconciled;
        return {
          success: false,
          state: intent.status === 'verification_unparseable' ? 'verification_unparseable' : 'verification_pending',
          reason: intent.last_error || reconciled.reason,
          write_key: key,
          verification_code: intent.verification_code,
          challenge: intent.challenge,
          safe_to_recreate: false,
        };
      }

      const reconciled = await reconcileAndPersist(intent);
      if (reconciled.success) return reconciled;
      if (reconciled.state === 'absent' && data?.success === false) {
        persist(intent, { status: 'creation_rejected', last_error: data?.error || 'Creation rejected' });
        return {
          success: false,
          state: 'creation_rejected',
          reason: intent.last_error,
          write_key: key,
          safe_to_recreate: false,
          retry_after_reconciliation: true,
        };
      }
      persist(intent, { status: 'create_ambiguous', last_error: data?.error || 'Creation state could not be established' });
      return { success: false, state: 'ambiguous', reason: intent.last_error, write_key: key, safe_to_recreate: false };
    } finally {
      release();
    }
  }

  async function verify({ verification_code, challenge = null, answer = null }) {
    const linked = store.findByVerificationCode(verification_code);
    if (!linked) {
      const direct = answer == null ? '' : String(answer).trim();
      let parsed;
      if (direct) parsed = { success: true, formatted: direct, expression: 'agent_supplied' };
      else parsed = parseVerificationChallenge(challenge);
      if (!parsed.success) return { ...parsed, success: false, state: 'verification_unparseable', linked_write: false, safe_to_recreate: false };
      const data = await request('/verify', {
        method: 'POST', body: JSON.stringify({ verification_code, answer: parsed.formatted }),
      });
      return {
        ...data,
        state: data?.success
          ? 'verification_succeeded_unlinked'
          : isTerminalVerificationFailure(data) ? 'verification_rejected_unlinked' : 'verification_ambiguous_unlinked',
        linked_write: false,
        _challenge: challenge,
        _answer: parsed.formatted,
        _answer_source: direct ? 'agent' : 'compat_parser',
        _expression: parsed.expression,
        safe_to_recreate: false,
      };
    }

    const release = store.acquire(linked.key);
    if (!release) return { success: false, state: 'ambiguous', reason: 'write_in_progress', write_key: linked.key, safe_to_recreate: false };
    try {
      const intent = store.load(linked.key) || linked;
      if (intent.status === 'published') return makeResult(intent, { already_published: true });
      if (intent.status === 'abstained') return makeResult(intent, { state: 'abstained', reason: 'verification_abstained' });
      if (intent.status === 'verification_rejected') {
        return makeResult(intent, { state: 'verification_rejected', reason: intent.last_error || 'verification_rejected' });
      }
      if (typeof answer === 'string' && answer.trim().toUpperCase() === 'ABSTAIN') {
        persist(intent, {
          status: 'abstained',
          abstained_at: new Date(now()).toISOString(),
          abstention_reason: 'agent_abstained',
        });
        return makeResult(intent, { state: 'abstained', reason: 'verification_abstained' });
      }
      const effectiveChallenge = challenge || intent.challenge;
      const attempted = await attemptVerification(intent, effectiveChallenge, true, answer);
      const reconciled = await reconcileAndPersist(intent);
      if (reconciled.success) {
        return {
          ...reconciled,
          _answer: attempted.parsed?.formatted || null,
          _answer_source: answer == null ? 'compat_parser' : 'agent',
        };
      }
      return {
        success: false,
        state: intent.status === 'verification_unparseable'
          ? 'verification_unparseable'
          : intent.status === 'verification_rejected' ? 'verification_rejected' : 'verification_pending',
        reason: intent.last_error || reconciled.reason,
        write_key: intent.key,
        verification_code,
        challenge: effectiveChallenge,
        _answer: attempted.parsed?.formatted || null,
        _answer_source: answer == null ? 'compat_parser' : 'agent',
        safe_to_recreate: false,
      };
    } finally { release(); }
  }

  async function retryPending(pending) {
    return submit({
      post_id: pending.post_id,
      parent_id: pending.parent_id || null,
      content: pending.content,
      idempotency_key: pending.idempotency_key || null,
    }, {
      reconcile_before_create: true,
      auto_verify: false,
      first_attempt_at: pending.queued_at || pending.first_attempt_at || new Date(now()).toISOString(),
    });
  }

  return { submit, verify, retryPending, reconcile, store };
}

let singleton;
export function getCommentWriteCoordinator() {
  if (!singleton) singleton = createCommentWriteCoordinator();
  return singleton;
}
