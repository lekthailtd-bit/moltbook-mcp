import { register as registerLegacy } from './engagement-legacy.js';
import { registerPendingTool } from './write-safety.js';
export * from './engagement-legacy.js';

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
  registerLegacy(withoutTools(server, new Set(['moltbook_pending'])), context);
  registerPendingTool(server, context);
}
