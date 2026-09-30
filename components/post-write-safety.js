import { z } from 'zod';
import { moltFetch, logAction } from '../providers/api.js';
import { markMyPost } from '../providers/state.js';
import {
  checkOutbound, dedupKey, isDuplicate, markDedup,
  MAX_POST_TITLE_LEN, MAX_POST_CONTENT_LEN,
} from '../transforms/security.js';
import { extractVerification, parseVerificationChallenge } from '../providers/comment-writes.js';

function textResult(payload, warnings = []) {
  let text = JSON.stringify(payload, null, 2);
  if (warnings.length) text += `\n\n⚠️ OUTBOUND WARNINGS: ${warnings.join(', ')}. Review your post for accidental sensitive data.`;
  return { content: [{ type: 'text', text }] };
}

async function reconcileKnownPost(data) {
  const postId = data?.post?.id || data?.post_id || data?.content_id || null;
  if (!postId) return null;
  const existing = await moltFetch(`/posts/${postId}`);
  if (!existing?.success || !existing?.post?.id) return null;
  return existing.post;
}

export function registerPostWriteTool(server) {
  server.tool('moltbook_post_create', 'Create a new post in a submolt using strict verification parsing', {
    submolt: z.string().describe("Submolt name (e.g. 'general')"),
    title: z.string().describe('Post title'),
    content: z.string().optional().describe('Post body text'),
    url: z.string().optional().describe('Link URL (for link posts)'),
  }, async ({ submolt, title, content, url }) => {
    if (title && title.length > MAX_POST_TITLE_LEN) title = title.slice(0, MAX_POST_TITLE_LEN) + '…';
    if (content && content.length > MAX_POST_CONTENT_LEN) content = content.slice(0, MAX_POST_CONTENT_LEN) + '\n\n[truncated]';

    const dk = dedupKey('post', submolt, title);
    if (isDuplicate(dk)) {
      return textResult({ success: false, error: 'Duplicate post blocked (same title within 2 minutes)' });
    }

    const warnings = [...checkOutbound(title), ...checkOutbound(content)];
    const body = { submolt_name: submolt, title };
    if (content) body.content = content;
    if (url) body.url = url;

    const data = await moltFetch('/posts', { method: 'POST', body: JSON.stringify(body) });
    const verification = extractVerification(data);
    if (verification) {
      const solved = parseVerificationChallenge(verification.challenge);
      if (!solved.success) {
        const existingPost = await reconcileKnownPost(data);
        if (existingPost) {
          markDedup(dk);
          markMyPost(existingPost.id);
          logAction(`posted "${title}" in m/${submolt} (reconciled after unparseable verification)`);
          return textResult({ success: true, state: 'already_published', reconciled: true, post: existingPost }, warnings);
        }
        return textResult({
          ...solved,
          success: false,
          state: 'verification_unparseable',
          verification_code: verification.verification_code,
          safe_to_recreate: false,
          caller_guidance: 'Verification parsing failed; this is not proof that the post failed. Do not recreate it as a new write.',
        }, warnings);
      }

      const verifyData = await moltFetch('/verify', {
        method: 'POST',
        body: JSON.stringify({ verification_code: verification.verification_code, answer: solved.formatted }),
      });
      if (verifyData?.success) {
        markDedup(dk);
        const postId = verifyData.post?.id || data.post?.id;
        if (postId) markMyPost(postId);
        logAction(`posted "${title}" in m/${submolt} (verified)`);
        return textResult({
          ...verifyData,
          state: 'verification_succeeded',
          _challenge: verification.challenge,
          _answer: solved.formatted,
          _expression: solved.expression,
        }, warnings);
      }

      const existingPost = await reconcileKnownPost(data);
      if (existingPost) {
        markDedup(dk);
        markMyPost(existingPost.id);
        logAction(`posted "${title}" in m/${submolt} (reconciled after verification ambiguity)`);
        return textResult({
          success: true,
          state: 'already_published',
          reconciled: true,
          post: existingPost,
          verification_error: verifyData?.error || verifyData?.message || null,
        }, warnings);
      }

      return textResult({
        ...verifyData,
        success: false,
        state: 'verification_ambiguous',
        verification_code: verification.verification_code,
        _challenge: verification.challenge,
        _answer: solved.formatted,
        _expression: solved.expression,
        safe_to_recreate: false,
        caller_guidance: 'Verification did not report success and publication could not be established. Do not recreate the post as a new write.',
      }, warnings);
    }

    if (data?.success && data?.post) {
      markDedup(dk);
      markMyPost(data.post.id);
      logAction(`posted "${title}" in m/${submolt}`);
    }
    return textResult(data, warnings);
  });
}
