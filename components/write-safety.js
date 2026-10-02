import { z } from 'zod';
import { createCommentWriteCoordinator } from '../providers/comment-writes.js';
import { createDurableCommentWriteStore } from '../providers/durable-comment-write-store.js';
import { getPostWriteCoordinator } from '../providers/post-writes.js';
import { loadState, saveState } from '../providers/state.js';
import { logAction } from '../providers/api.js';
import { checkOutbound, dedupKey, markDedup, MAX_COMMENT_LEN } from '../transforms/security.js';

const commentWriteCoordinator = createCommentWriteCoordinator({
  store: createDurableCommentWriteStore(),
});
const postWriteCoordinator = getPostWriteCoordinator();

function textResult(payload, warnings = []) {
  let text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  if (warnings.length) text += `\n\n⚠️ OUTBOUND WARNINGS: ${warnings.join(', ')}. Review your comment for accidental sensitive data.`;
  return { content: [{ type: 'text', text }] };
}

function samePending(pc, input) {
  return pc.post_id === input.post_id &&
    (pc.parent_id || null) === (input.parent_id || null) &&
    pc.content === input.content &&
    (pc.idempotency_key || null) === (input.idempotency_key || null);
}

function recordPublished(input, result, source = 'write-safe') {
  if (!result?.success || !result.comment_id) return;
  const s = loadState();
  if (!s.commented) s.commented = {};
  if (!s.myComments) s.myComments = {};
  if (!s.commented[input.post_id]) s.commented[input.post_id] = [];
  if (!s.myComments[input.post_id]) s.myComments[input.post_id] = [];
  const at = new Date().toISOString();
  if (!s.commented[input.post_id].some(x => x?.commentId === result.comment_id)) {
    s.commented[input.post_id].push({ commentId: result.comment_id, at });
  }
  if (!s.myComments[input.post_id].some(x => x?.commentId === result.comment_id)) {
    s.myComments[input.post_id].push({ commentId: result.comment_id, at, platform: null });
  }
  s.pendingComments = (s.pendingComments || []).filter(pc => !samePending(pc, input));
  saveState(s);
  markDedup(dedupKey('comment', input.parent_id || input.post_id, input.content));
  if (!result.already_published) logAction(`commented on ${input.post_id.slice(0, 8)} (${source})`);
}

function enqueueRejected(input, result) {
  const reason = String(result?.reason || '');
  if (!/auth|unauthor|forbidden|token|credential/i.test(reason)) return false;
  const s = loadState();
  if (!s.pendingComments) s.pendingComments = [];
  if (!s.pendingComments.some(pc => samePending(pc, input))) {
    s.pendingComments.push({
      post_id: input.post_id,
      parent_id: input.parent_id || null,
      content: input.content,
      idempotency_key: input.idempotency_key || null,
      write_key: result.write_key || null,
      queued_at: new Date().toISOString(),
      attempts: 0,
      nextRetryAfter: new Date(Date.now() + 2 * 60000).toISOString(),
    });
    saveState(s);
  }
  return true;
}

export function registerCommentWriteTools(server) {
  server.tool('moltbook_comment', 'Add a comment to a post (or reply to a comment) with durable idempotency and reconciliation', {
    post_id: z.string().describe('Post ID'),
    content: z.string().describe('Comment text'),
    parent_id: z.string().optional().describe('Parent comment ID for replies'),
    idempotency_key: z.string().min(1).max(200).optional().describe('Optional stable key for this logical write. Reuse on retries; use a new key only for an intentional repeat in the same context.'),
  }, async ({ post_id, content, parent_id, idempotency_key }) => {
    if (content && content.length > MAX_COMMENT_LEN) content = content.slice(0, MAX_COMMENT_LEN) + '\n\n[truncated]';
    const input = { post_id, content, parent_id: parent_id || null, idempotency_key: idempotency_key || null };
    const warnings = checkOutbound(content);
    const result = await commentWriteCoordinator.submit(input, { auto_verify: false });
    if (result.success) recordPublished(input, result);
    const queued = result.state === 'creation_rejected' ? enqueueRejected(input, result) : false;
    return textResult({
      ...result,
      ...(queued ? { queued: true, message: 'Creation was authoritatively absent after rejection; queued retry will reconcile before any new POST.' } : {}),
      ...(result.success ? {} : { caller_guidance: 'Do not recreate this comment as a new write. Retry the same tool/input so the MCP can reconcile the existing write intent.' }),
    }, warnings);
  });

  server.tool('moltbook_verify', 'Submit an agent-interpreted answer for an existing Moltbook verification intent and reconcile publication state. If answer is omitted, the legacy deterministic parser is used as a compatibility fallback. Use answer="ABSTAIN" to close a linked ambiguous intent without guessing.', {
    verification_code: z.string().describe('The verification code from the post/comment response'),
    challenge: z.string().optional().describe('Raw challenge text. Optional for linked durable intents because the MCP already stores it.'),
    answer: z.string().optional().describe('Agent-interpreted answer to submit. Prefer this over deterministic parsing. Use the literal ABSTAIN to decline an ambiguous one-shot challenge.'),
  }, async ({ verification_code, challenge, answer }) => {
    const input = { verification_code, challenge: challenge || null, answer: answer || null };
    const postResult = await postWriteCoordinator.verify(input);
    const result = postResult.linked_write === false
      ? await commentWriteCoordinator.verify(input)
      : postResult;
    return textResult({
      ...result,
      ...(result.success ? {} : {
        caller_guidance: result.state === 'abstained'
          ? 'Verification was explicitly abstained. The durable write intent remains queryable and will not be recreated automatically.'
          : result.state === 'verification_rejected'
            ? 'The provider rejected this verification. Do not submit another answer for this intent. Start a new intentional write only if a new post/comment is still wanted.'
            : result.state === 'verification_succeeded_pending_reconciliation'
              ? 'The provider accepted the verification. Do not resubmit the answer; reconcile the existing write intent until publication state catches up.'
              : 'Verification failure is not proof that the original write failed. Do not recreate it; reconcile/retry this verification flow against the same durable intent.',
      }),
    });
  });
}

export function registerPendingTool(server) {
  server.tool('moltbook_pending', 'View and safely retry pending comments. Retries reconcile authoritative Moltbook state before any new create.', {
    action: z.enum(['list', 'retry', 'auto', 'clear']).default('list').describe("'list' shows queued comments, 'retry' retries all safely, 'auto' retries only backoff-eligible comments, 'clear' removes the local queue"),
  }, async ({ action }) => {
    const s = loadState();
    const pending = s.pendingComments || [];
    if (!pending.length) return textResult('No pending comments.');
    if (action === 'list') {
      const lines = pending.map((pc, i) => {
        const ms = pc.nextRetryAfter ? new Date(pc.nextRetryAfter).getTime() - Date.now() : 0;
        const backoff = ms > 0 ? ` ⏳${Math.max(1, Math.round(ms / 60000))}min` : ' ✅ready';
        return `${i + 1}. post:${pc.post_id.slice(0, 8)}${pc.parent_id ? ` reply:${pc.parent_id.slice(0, 8)}` : ''} attempts:${pc.attempts || 0}/10${backoff} — "${pc.content.slice(0, 80)}${pc.content.length > 80 ? '…' : ''}"`;
      });
      return textResult(`📋 ${pending.length} pending comment(s):\n${lines.join('\n')}`);
    }
    if (action === 'clear') {
      const count = pending.length;
      s.pendingComments = [];
      saveState(s);
      return textResult(`Cleared ${count} pending comment(s). Durable write intents are retained so clearing the queue cannot make an ambiguous write unsafe to retry.`);
    }

    const now = Date.now();
    const isAuto = action === 'auto';
    const eligible = isAuto ? pending.filter(pc => !pc.nextRetryAfter || new Date(pc.nextRetryAfter).getTime() <= now) : pending;
    const notEligible = isAuto ? pending.filter(pc => pc.nextRetryAfter && new Date(pc.nextRetryAfter).getTime() > now) : [];
    if (!eligible.length) return textResult(`⏳ ${pending.length} pending comment(s), none eligible yet.`);

    const remaining = [...notEligible];
    const lines = [];
    for (const pc of eligible) {
      pc.attempts = (pc.attempts || 0) + 1;
      if (pc.attempts > 10) {
        pc.nextRetryAfter = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        remaining.push(pc);
        lines.push(`⏸️ ${pc.post_id.slice(0, 8)}: retry limit reached; retained for reconciliation/manual review`);
        continue;
      }
      const result = await commentWriteCoordinator.retryPending(pc);
      const input = { post_id: pc.post_id, parent_id: pc.parent_id || null, content: pc.content, idempotency_key: pc.idempotency_key || null };
      if (result.success) {
        recordPublished(input, result, result.reconciled ? 'pending-reconciled' : 'pending-retry');
        lines.push(`✅ ${pc.post_id.slice(0, 8)}: ${result.reconciled || result.already_published ? 'reconciled existing comment' : 'posted safely'}${result.comment_id ? ` (${result.comment_id})` : ''}`);
      } else {
        const backoffMs = Math.min(Math.pow(2, pc.attempts) * 60000, 24 * 60 * 60 * 1000);
        pc.nextRetryAfter = new Date(Date.now() + backoffMs).toISOString();
        pc.write_key = result.write_key || pc.write_key || null;
        remaining.push(pc);
        lines.push(`⏳ ${pc.post_id.slice(0, 8)}: ${result.state} — ${result.reason || 'not yet reconciled'}; no blind recreate`);
      }
    }
    const latest = loadState();
    latest.pendingComments = remaining;
    saveState(latest);
    return textResult(`Safe retry results:\n${lines.join('\n')}${notEligible.length ? `\n⏳ ${notEligible.length} item(s) still in backoff.` : ''}`);
  });
}
