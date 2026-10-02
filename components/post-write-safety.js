import { z } from 'zod';
import { logAction } from '../providers/api.js';
import { markMyPost } from '../providers/state.js';
import { getPostWriteCoordinator } from '../providers/post-writes.js';
import {
  checkOutbound, dedupKey, markDedup,
  MAX_POST_TITLE_LEN, MAX_POST_CONTENT_LEN,
} from '../transforms/security.js';

const postWriteCoordinator = getPostWriteCoordinator();

function textResult(payload, warnings = []) {
  let text = JSON.stringify(payload, null, 2);
  if (warnings.length) text += `\n\n⚠️ OUTBOUND WARNINGS: ${warnings.join(', ')}. Review your post for accidental sensitive data.`;
  return { content: [{ type: 'text', text }] };
}

export function registerPostWriteTool(server) {
  server.tool('moltbook_post_create', 'Create a post with durable idempotency. If Moltbook requires verification, returns the raw challenge for agent interpretation; retrying the same logical write reconciles the same intent instead of creating again.', {
    submolt: z.string().describe("Submolt name (e.g. 'general')"),
    title: z.string().describe('Post title'),
    content: z.string().optional().describe('Post body text'),
    url: z.string().optional().describe('Link URL (for link posts)'),
    idempotency_key: z.string().min(1).max(200).optional().describe('Optional stable key for this logical post. Reuse on retries; use a new key only for an intentional repeat.'),
  }, async ({ submolt, title, content, url, idempotency_key }) => {
    if (title && title.length > MAX_POST_TITLE_LEN) title = title.slice(0, MAX_POST_TITLE_LEN) + '…';
    if (content && content.length > MAX_POST_CONTENT_LEN) content = content.slice(0, MAX_POST_CONTENT_LEN) + '\n\n[truncated]';

    const warnings = [...checkOutbound(title), ...checkOutbound(content)];
    const input = {
      submolt,
      title,
      content: content || null,
      url: url || null,
      idempotency_key: idempotency_key || null,
    };
    const result = await postWriteCoordinator.submit(input);

    if (result.success && result.post_id) {
      markDedup(dedupKey('post', submolt, title));
      markMyPost(result.post_id);
      if (!result.already_published) logAction(`posted "${title}" in m/${submolt}`);
    }

    return textResult({
      ...result,
      ...(result.success ? {} : {
        caller_guidance: result.state === 'verification_pending'
          ? 'Interpret the returned challenge and call moltbook_verify with this verification_code and an explicit answer. Do not recreate the post.'
          : result.state === 'verification_succeeded_pending_reconciliation'
            ? 'The provider accepted verification. Do not resubmit the answer; retry this same logical post only to reconcile publication state.'
            : result.state === 'verification_rejected'
              ? 'The provider rejected verification. Do not retry the answer for this intent. Start a new intentional post only if another attempt is still wanted.'
              : result.state === 'abstained'
                ? 'This verification intent is explicitly abstained and will not be recreated automatically.'
                : 'Do not recreate this post as a new write. Retry the same logical post so the MCP can reconcile its durable write intent.',
      }),
    }, warnings);
  });
}
