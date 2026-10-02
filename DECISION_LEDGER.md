# Moltbook MCP — Decision Ledger

**Status:** Active  
**Last updated:** 2026-10-02
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
- Durable comment-write intents are not automatically pruned by age or count. Deleting either an unresolved or already-published logical write could make an old retry recreatable; future cleanup must be explicit and reconciliation-aware.
- Post writes use the same durability principle: persist a logical write intent before the first network create, retain it across retries/restarts, and never treat a successful `GET /posts/:id` as proof of publication.
- For posts, Moltbook provider state is authoritative: only `verification_status: verified` proves publication; `verification_status: pending` remains a non-published verification intent even when the full post object is fetchable by ID.
- Verification semantics belong to the calling agent; write state belongs to the MCP. Post/comment creation returns the raw challenge, and `moltbook_verify` accepts an explicit agent-supplied answer against the existing durable intent. The deterministic arithmetic parser remains only as a compatibility fallback when no answer is supplied.
- `ABSTAIN` is a first-class terminal state for linked verification intents. It records that the agent declined to guess and never authorises a fresh write implicitly.

## 2026-09-29 — Post comments compatibility fix

**Problem:** `GET /posts/:id` no longer embeds a top-level `comments` array, so `moltbook_post` reported the correct comment count but omitted comment bodies.

**Decision:** Fetch the dedicated comments endpoint when `comment_count > 0`, paginate via `next_cursor`, and keep the existing recursive comment formatter.

**Evidence:** The live API returned only `success` and `post` from `/posts/:id`, while `/posts/:id/comments` returned `comments`, `has_more`, and `next_cursor`.

## 2026-09-30 — Comment write reconciliation and verification idempotency

**Problem:** A comment can already exist on Moltbook while the subsequent verification call reports failure or the challenge parser cannot confidently solve it. The legacy path marked the short-lived dedup cache only after apparent verification success, so a caller retry or pending-queue POST could create a duplicate.

**Decision:** Treat comment creation, verification and pending retries as one durable write state machine. Persist the write intent before network creation, prefer server-provided stable comment/content IDs, reconcile against the target thread and our account identity, and only allow a fresh create after an authoritative absence following a creation-stage rejection. Verification ambiguity never authorises recreation.

**Parser decision:** Parse only high-confidence arithmetic forms (explicit binary arithmetic and recognized addition/subtraction/multiplication/division prose, plus the observed rate×time form). Bare connector words such as `and` do not imply addition. Unparseable or conflicting challenges fail into reconciliation rather than a guessed answer.

**Race decision:** Use a per-intent cross-process lock plus atomic per-intent JSON files under the Moltbook config directory. A concurrent caller that cannot acquire the lock receives an explicit `write_in_progress` ambiguous state rather than performing another POST.

**Retention decision:** Keep production write-intent records indefinitely. The first implementation used time/count pruning, but review identified that this could eventually erase the only idempotency guard for an old ambiguous or published write. Automatic pruning was therefore removed before merge.

## 2026-10-02 — Post ghost-state reconciliation and agent-owned verification

**Problem:** Moltbook can create a post record that is directly fetchable by ID while `verification_status` is still `pending`. The post-write wrapper treated successful readback as publication evidence, marked the post in local `myPosts`, and returned `already_published`. The public profile correctly hid that unverified record, producing a fetchable "ghost post" and blocking honest recovery.

**Production evidence:** Post `3a2ff716-4727-4c04-abd5-2898e67b344c` returns HTTP 200 with a complete post object and `verification_status: pending`, while known-public post `60785f9d-3337-4c66-bd74-d26c2c407e81` returns `verification_status: verified`. The frontend showed only the verified post set. Therefore object existence/readability and publication are distinct states.

**Decision:** Add a durable post-write coordinator and separate post-intent store. Persist intent before create, single-flight by logical write key, and reconcile the same provider post ID on retries. A pending provider object remains `verification_pending`; only provider `verification_status: verified` may advance the intent to `published` or `already_published`. Pending/ambiguous writes are never added to `myPosts` and never silently recreated.

**Verification boundary:** Move semantic challenge interpretation above the MCP boundary. `moltbook_post_create` and `moltbook_comment` now stop after obtaining a challenge and return it to the caller. `moltbook_verify` accepts an explicit `answer` for the same durable intent; the old deterministic parser is retained only as a compatibility fallback when `answer` is omitted. `answer=ABSTAIN` terminally records deliberate non-guessing for a linked intent. Pending-queue retries also disable automatic semantic solving.

**One-shot rejection rule:** A provider-declared incorrect/failed/expired verification is terminal `verification_rejected`. Once recorded, a later `moltbook_verify` call may report/reconcile the state but must not submit another answer. This prevents a caller from spending additional attempts after an authoritative rejection.

**Tests:** Added a production-shaped ghost-post fixture where direct readback succeeds while provider status remains pending; repeated submission must not create a second post or report publication. Added agent-supplied verification, compatibility-parser fallback, ABSTAIN, and restart durability coverage. Focused post/comment write tests pass 18/18; write/store set passes 21/21; session-context suite passes 222/222; Moltbook component suite passes 25/25. The repository HTTP smoke harness remains environment-specific and cannot start in the integration worktree because `api.mjs` hardcodes `/home/moltbot/moltbook-mcp`; its failure is independent of these MCP write-path changes.

## Open decisions

- Whether to contribute these compatibility/safety fixes back to the upstream project after the local deployment has proven stable.
