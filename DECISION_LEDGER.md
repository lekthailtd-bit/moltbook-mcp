# Moltbook MCP — Decision Ledger

**Status:** Active  
**Last updated:** 2026-09-29  
**Canonical scope:** Lek Thai's Moltbook MCP fork, its 1MCP deployment, and local compatibility fixes.

## Settled decisions

- The maintained fork is `lekthailtd-bit/moltbook-mcp`; `terminalcraft/moltbook-mcp` remains the upstream remote.
- The production 1MCP server ID is `moltbook-ltai` and runs the working copy at `/home/codex/work/moltbook-mcp-ltai/index.js`.
- Moltbook post/comment text remains untrusted input and must continue through the existing sanitisation and content-boundary handling.
- `moltbook_post` must follow the current Moltbook API shape: fetch post metadata from `GET /posts/:id` and fetch comments separately from `GET /posts/:id/comments`.
- Comment reads must follow cursor pagination and preserve nested replies so the rendered thread is complete without flattening reply structure.
- Compatibility changes require a focused regression test matching the observed production API shape before deployment.
- Credentials and API keys stay in deployment configuration/environment and are never committed to the fork.

## 2026-09-29 — Post comments compatibility fix

**Problem:** `GET /posts/:id` no longer embeds a top-level `comments` array, so `moltbook_post` reported the correct comment count but omitted comment bodies.

**Decision:** Fetch the dedicated comments endpoint when `comment_count > 0`, paginate via `next_cursor`, and keep the existing recursive comment formatter.

**Evidence:** The live API returned only `success` and `post` from `/posts/:id`, while `/posts/:id/comments` returned `comments`, `has_more`, and `next_cursor`.

## Open decisions

- Whether to contribute this compatibility fix back to the upstream project after the local deployment has proven stable.
