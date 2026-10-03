import { createHash } from 'crypto';
import { moltFetch } from './api.js';
import { createDurablePostWriteStore } from './durable-post-write-store.js';
import { extractVerification, parseVerificationChallenge } from './comment-writes.js';

function canonicalText(value) {
  return String(value ?? '').normalize('NFC').replace(/\r\n/g, '\n');
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isTerminalVerificationFailure(data) {
  if (!data || data.success !== false) return false;
  const message = `${data.error || ''} ${data.message || ''}`.toLowerCase();
  return /incorrect answer|wrong answer|invalid answer|verification (?:failed|rejected|expired)|challenge (?:failed|rejected|expired)|expired challenge/.test(message);
}

export function postWriteKey({ submolt, title, content = '', url = '', idempotency_key = null }) {
  return hash([
    'post-v1',
    canonicalText(submolt),
    canonicalText(title),
    canonicalText(content),
    canonicalText(url),
    idempotency_key || '',
  ].join('\0'));
}

export function classifyPostPublication(post) {
  if (!post?.id) return { state: 'unknown', reason: 'missing_post' };
  if (post.is_deleted) return { state: 'verification_rejected', reason: 'post_deleted' };

  const verificationStatus = String(post.verification_status || '').trim().toLowerCase();
  if (verificationStatus === 'verified') {
    return { state: 'published', reason: 'verification_status_verified' };
  }
  if (['pending', 'unverified'].includes(verificationStatus)) {
    return { state: 'verification_pending', reason: `verification_status_${verificationStatus}` };
  }
  if (['rejected', 'failed', 'expired'].includes(verificationStatus)) {
    return { state: 'verification_rejected', reason: `verification_status_${verificationStatus}` };
  }
  return {
    state: 'unknown',
    reason: verificationStatus ? `verification_status_${verificationStatus}` : 'verification_status_missing',
  };
}

export { createDurablePostWriteStore };

function makeResult(intent, extra = {}) {
  return {
    success: intent?.status === 'published',
    state: intent?.status || 'unknown',
    write_key: intent?.key || null,
    post_id: intent?.post_id || null,
    verification_code: intent?.verification_code || null,
    challenge: intent?.challenge || null,
    linked_write: true,
    safe_to_recreate: false,
    ...extra,
  };
}

export function createPostWriteCoordinator({
  request = moltFetch,
  store = createDurablePostWriteStore(),
  now = () => Date.now(),
} = {}) {
  function persist(intent, patch = {}) {
    Object.assign(intent, patch, { updated_at: new Date(now()).toISOString() });
    store.save(intent);
    return intent;
  }

  function publish(intent, post, reason) {
    return persist(intent, {
      status: 'published',
      post_id: post?.id || intent.post_id || null,
      verification_status: post?.verification_status || 'verified',
      reconciled: reason !== 'create_response' && reason !== 'verify_response',
      reconciliation_reason: reason,
      last_error: null,
    });
  }

  async function reconcile(intent) {
    if (!intent?.post_id) return { state: 'unknown', reason: 'post_id_unavailable' };
    let data;
    try {
      data = await request(`/posts/${intent.post_id}`);
    } catch (err) {
      return { state: 'unknown', reason: `post_fetch_failed:${err.message}` };
    }
    if (!data || data.success === false || !data.post?.id) {
      return { state: 'unknown', reason: `post_fetch_failed:${data?.error || 'missing_post'}` };
    }
    return { ...classifyPostPublication(data.post), post: data.post };
  }

  async function reconcileAndPersist(intent) {
    const result = await reconcile(intent);
    if (result.state === 'published') {
      publish(intent, result.post, result.reason);
      return makeResult(intent, { already_published: true, post: result.post, reconciled: true });
    }
    if (result.state === 'verification_pending') {
      persist(intent, {
        status: ['abstained', 'verification_rejected', 'verification_succeeded_pending_reconciliation'].includes(intent.status)
          ? intent.status
          : 'verification_pending',
        verification_status: result.post?.verification_status || 'pending',
        last_reconciliation: result,
        last_reconciled_at: new Date(now()).toISOString(),
      });
    } else if (result.state === 'verification_rejected') {
      persist(intent, {
        status: 'verification_rejected',
        verification_status: result.post?.verification_status || null,
        last_reconciliation: result,
        last_reconciled_at: new Date(now()).toISOString(),
      });
    } else {
      persist(intent, {
        last_reconciliation: result,
        last_reconciled_at: new Date(now()).toISOString(),
      });
    }
    return makeResult(intent, { reason: result.reason, post: result.post || null });
  }

  async function submit(input) {
    const normalized = {
      submolt: canonicalText(input.submolt),
      title: canonicalText(input.title),
      content: canonicalText(input.content),
      url: canonicalText(input.url),
      idempotency_key: input.idempotency_key || null,
    };
    const key = postWriteKey(normalized);
    const release = store.acquire(key);
    if (!release) {
      return { success: false, state: 'ambiguous', reason: 'write_in_progress', write_key: key, safe_to_recreate: false };
    }

    try {
      let intent = store.load(key);
      if (intent?.status === 'published') return makeResult(intent, { already_published: true });
      if (intent?.status === 'abstained') return makeResult(intent, { reason: 'verification_abstained' });

      // Once network creation has started, the durable intent owns recovery.
      // Never turn a caller retry into another POST merely because verification
      // or readback is ambiguous.
      if (intent?.create_started_at) {
        const reconciled = await reconcileAndPersist(intent);
        if (reconciled.success) return reconciled;
        return reconciled;
      }

      if (!intent) {
        intent = {
          key,
          kind: 'post',
          submolt: normalized.submolt,
          title: normalized.title,
          content: normalized.content || null,
          url: normalized.url || null,
          idempotency_key: normalized.idempotency_key,
          created_at: new Date(now()).toISOString(),
          status: 'prepared',
          create_attempts: 0,
        };
        store.save(intent);
      }

      persist(intent, {
        status: 'creating',
        create_started_at: new Date(now()).toISOString(),
        create_attempts: (intent.create_attempts || 0) + 1,
      });

      const body = { submolt_name: normalized.submolt, title: normalized.title };
      if (normalized.content) body.content = normalized.content;
      if (normalized.url) body.url = normalized.url;

      let data;
      try {
        data = await request('/posts', { method: 'POST', body: JSON.stringify(body) });
      } catch (err) {
        persist(intent, { status: 'create_ambiguous', last_error: `Create request failed: ${err.message}` });
        return makeResult(intent, { reason: intent.last_error });
      }

      const verification = extractVerification(data);
      const post = data?.post || null;
      const classification = classifyPostPublication(post);
      persist(intent, {
        post_id: post?.id || data?.post_id || data?.content_id || intent.post_id || null,
        verification_code: verification?.verification_code || intent.verification_code || null,
        challenge: verification?.challenge || intent.challenge || null,
        verification_status: post?.verification_status || intent.verification_status || null,
        last_create_success: data?.success ?? null,
      });

      if (classification.state === 'published') {
        publish(intent, post, 'create_response');
        return makeResult(intent, { post });
      }

      if (verification || classification.state === 'verification_pending') {
        persist(intent, { status: 'verification_pending', last_error: null });
        const reconciled = await reconcileAndPersist(intent);
        if (reconciled.success) return reconciled;
        return makeResult(intent, {
          reason: reconciled.reason || 'verification_required',
          post: reconciled.post || post,
        });
      }

      if (classification.state === 'verification_rejected') {
        persist(intent, { status: 'verification_rejected', last_error: data?.error || classification.reason });
        return makeResult(intent, { reason: intent.last_error, post });
      }

      persist(intent, {
        status: data?.success === false ? 'creation_rejected' : 'create_ambiguous',
        last_error: data?.error || 'Creation state could not be established',
      });
      return makeResult(intent, { reason: intent.last_error, post });
    } finally {
      release();
    }
  }

  async function verify({ verification_code, challenge = null, answer = null }) {
    const linked = store.findByVerificationCode(verification_code);
    if (!linked) {
      return { success: false, state: 'unlinked', linked_write: false, verification_code, safe_to_recreate: false };
    }

    const release = store.acquire(linked.key);
    if (!release) {
      return { success: false, state: 'ambiguous', reason: 'write_in_progress', write_key: linked.key, linked_write: true, safe_to_recreate: false };
    }

    try {
      const intent = store.load(linked.key) || linked;
      if (intent.status === 'published') return makeResult(intent, { already_published: true });
      if (intent.status === 'abstained') return makeResult(intent, { reason: 'verification_abstained' });
      if (intent.status === 'verification_rejected') {
        const reconciled = await reconcileAndPersist(intent);
        if (reconciled.success) return reconciled;
        return makeResult(intent, {
          reason: intent.last_error || reconciled.reason || 'verification_rejected',
          post: reconciled.post || null,
        });
      }
      if (intent.status === 'verification_succeeded_pending_reconciliation') {
        const reconciled = await reconcileAndPersist(intent);
        if (reconciled.success) return { ...reconciled, verification_accepted: true };
        return makeResult(intent, {
          reason: reconciled.reason || 'verification_succeeded_pending_reconciliation',
          post: reconciled.post || null,
          verification_accepted: true,
        });
      }

      const effectiveChallenge = challenge || intent.challenge || null;
      if (typeof answer === 'string' && answer.trim().toUpperCase() === 'ABSTAIN') {
        persist(intent, {
          status: 'abstained',
          abstained_at: new Date(now()).toISOString(),
          abstention_reason: 'agent_abstained',
        });
        return makeResult(intent, { reason: 'verification_abstained' });
      }

      let submittedAnswer = answer == null ? null : String(answer).trim();
      let answerSource = 'agent';
      let parsed = null;
      if (!submittedAnswer) {
        parsed = parseVerificationChallenge(effectiveChallenge);
        if (!parsed.success) {
          persist(intent, {
            status: 'verification_pending',
            challenge: effectiveChallenge,
            parser_error: parsed.error,
          });
          const reconciled = await reconcileAndPersist(intent);
          if (reconciled.success) {
            return makeResult(intent, {
              ...reconciled,
              challenge: effectiveChallenge,
              parser: parsed,
            });
          }
          return makeResult(intent, {
            reason: parsed.error,
            challenge: effectiveChallenge,
            parser: parsed,
            post: reconciled.post || null,
            reconciled: Boolean(reconciled.post),
          });
        }
        submittedAnswer = parsed.formatted;
        answerSource = 'compat_parser';
      }

      let verifyData;
      try {
        verifyData = await request('/verify', {
          method: 'POST',
          body: JSON.stringify({ verification_code, answer: submittedAnswer }),
        });
      } catch (err) {
        verifyData = { success: false, error: `Verification request failed: ${err.message}` };
      }

      const attempts = [...(intent.verification_attempts || []), {
        at: new Date(now()).toISOString(),
        answer: submittedAnswer,
        source: answerSource,
        response: verifyData,
      }];
      const terminalFailure = isTerminalVerificationFailure(verifyData);
      persist(intent, {
        challenge: effectiveChallenge,
        verification_attempts: attempts,
        status: verifyData?.success
          ? 'verification_succeeded_pending_reconciliation'
          : terminalFailure ? 'verification_rejected' : 'verification_pending',
        last_error: verifyData?.success ? null : (verifyData?.error || 'Verification did not report success'),
      });

      if (verifyData?.post && classifyPostPublication(verifyData.post).state === 'published') {
        publish(intent, verifyData.post, 'verify_response');
        return makeResult(intent, { post: verifyData.post, _answer: submittedAnswer, _answer_source: answerSource });
      }

      const reconciled = await reconcileAndPersist(intent);
      if (reconciled.success) {
        return { ...reconciled, _answer: submittedAnswer, _answer_source: answerSource };
      }
      return makeResult(intent, {
        reason: intent.last_error || reconciled.reason,
        post: reconciled.post || null,
        verification_error: verifyData?.success ? null : (verifyData?.error || verifyData?.message || null),
        verification_accepted: verifyData?.success === true,
        _answer: submittedAnswer,
        _answer_source: answerSource,
      });
    } finally {
      release();
    }
  }

  return { submit, verify, reconcile, store };
}

let singleton;
export function getPostWriteCoordinator() {
  if (!singleton) singleton = createPostWriteCoordinator();
  return singleton;
}
