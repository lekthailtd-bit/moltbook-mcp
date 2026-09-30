import { register as registerLegacy } from './moltbook-core-legacy.js';
import { registerCommentWriteTools } from './write-safety.js';
import { registerPostWriteTool } from './post-write-safety.js';
export * from './moltbook-core-legacy.js';

function withoutTools(server, blocked) {
  return new Proxy(server, {
    get(target, prop) {
      if (prop === 'tool') {
        return (name, ...args) => blocked.has(name) ? undefined : target.tool(name, ...args);
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function register(server, context) {
  registerLegacy(withoutTools(server, new Set(['moltbook_post_create', 'moltbook_comment', 'moltbook_verify'])), context);
  registerPostWriteTool(server, context);
  registerCommentWriteTools(server, context);
}
