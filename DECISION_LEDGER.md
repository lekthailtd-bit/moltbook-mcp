# Moltbook MCP — Decision Ledger

**Status:** Active  
**Last updated:** 2026-09-30  
**Canonical scope:** Lek Thai's Moltbook MCP fork, its 1MCP deployment, and local compatibility fixes.

## Settled decisions

- The maintained fork is `lekthailtd-bit/moltbook-mcp`; `terminalcraft/moltbook-mcp` remains the upstream remote.
- The production 1MCP server ID is `moltbook-ltai` and runs the working copy at `/home/codex/work/moltbook-mcp-ltai/index.js`.
- Moltbook post/comment text remains untrusted input and must continue through the existing sanitisation and content-boundary handling.
- `moltbook_post` must follow the current Moltbook API shape: fetch post metadata from `GET /posts/:id` and fetch comments separately from `GET /posts/:id/comments`.
- Comment reads must follow cursor pagination and preserve nested replies so the rendered thread is complete without flattening reply structure.
- Compatibility changes require a focused regression test matching the observed production API shape before deployment.
- Credentials and API keys stay in deployment configuration/environment and are never committed to the fork.
- Comment write safety must not depend on the in-process 120-second dedup cache. Every logical comment write gets a durable intent before the first POST; ambiguous create/verification outcomes reconcile authoritative thread state before any later create is permitted.
- Verification failure is not evidence that the original comment failed to publish. Verification retries operate on the existing verification/content intent and an unresolved state is returned as non-recreatable.
- Pending-comment retries must use the same write coordinator; endpoint probes must not create a fresh copy of an unresolved comment.

## 2026-09-29 — Post comments compatibility fix

**Problem:** `GET /posts/:id` no longer embeds a top-level `comments` array, so `moltbook_post` reported the correct comment count but omitted comment bodies.

**Decision:** Fetch the dedicated comments endpoint when `comment_count > 0`, paginate via `next_cursor`, and keep the existing recursive comment formatter.

**Evidence:** The live API returned only `success` and `post` from `/posts/:id`, while `/posts/:id/comments` returned `comments`, `has_more`, and `next_cursor`.

## 2026-09-30 — Comment write reconciliation and verification idempotency

**Problem:** A comment can already exist on Moltbook while the subsequent verification call reports failure or the challenge parser cannot confidently solve it. The legacy path marked the short-lived dedup cache only after apparent verification success, so a caller retry or pending-queue POST could create a duplicate.

**Decision:** Treat comment creation, verification and pending retries as one durable write state machine. Persist the write intent before network creation, prefer server-provided stable comment/content IDs, reconcile against the target thread and our account identity, and only allow a fresh create after an authoritative absence following a creation-stage rejection. Verification ambiguity never authorises recreation.

**Parser decision:** Parse only high-confidence arithmetic forms (explicit binary arithmetic and recognized addition/subtraction/multiplication/division prose, plus the observed rate×time form). Bare connector words such as `and` do not imply addition. Unparseable or conflicting challenges fail into reconciliation rather than a guessed answer.

**Race decision:** Use a per-intent cross-process lock plus atomic per-intent JSON files under the Moltbook config directory. A concurrent caller that cannot acquire the lock receives an explicit `write_in_progress` ambiguous state rather than performing another POST.

## Open decisions

- Whether to contribute these compatibility/safety fixes back to the upstream project after the local deployment has proven stable.
