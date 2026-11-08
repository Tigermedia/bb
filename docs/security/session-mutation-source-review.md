# My session mutation containment patch

I continue PR 1 from 03c9270326d2ba877ae7272d2417c276c988d4b1. I prepare source and isolated tests only. I do not merge, activate packages, restart services, modify jobs, enroll credentials or change any existing session.

## Implemented source boundary

I deny every explicit write under the public `/threads/:id` routes when the row is manual, human-pinned, manually unpinned, or missing positive bot and pin evidence. Reads continue. SDK, CLI and plugin requests routed through this HTTP surface meet the same middleware before handler validation or effects. I also guard metadata, rename, pin, unpin, reorder, archive, close, hard delete and restore in the database mutation functions. I preflight affected direct children and hidden source forks for archive batches, and stop environment batches before partial application when any member is protected. I remove unconditional owner authority from project-deletion recovery.

I persist pin source, durable human-pin protection, manual-unpin state and mutation revision. I keep legacy provenance and pin source unknown. I preserve positive bot policy when all protection flags are explicitly clear. A trusted in-process manual creation still pins once; an owner unpin prevents subsequent automation. I expose the protection fields as optional supported metadata, so old clients remain readable and missing fields stay conservative.

I remove app-header cookie issuance and ignore the old owner cookie as authority. Caller-declared app, CLI, SDK or plugin origin cannot establish creation provenance. I verify Ed25519 approval signatures against a public key pinned at trusted server bootstrap, never a key in an approval request. An authority cannot be replaced in a running server. I bind approvals to thread, action, canonical payload hash, revision, requester, audience, short expiry and source receipt. I derive a stable approval ID from the signed claims, reject reissuance and atomically consume a grant with the guarded database mutation. Failed writes roll consumption back. Invalid reorders do not consume grants.

I permit a separate in-process runtime principal to record numeric read-state telemetry and perform an initial environment attachment while a thread is pending or starting. This principal cannot rename, pin, archive, detach, reparent or change general metadata. HTTP callers cannot select it.

## Explicit implementation gaps and release rejection

I do not certify the whole requested feature or approve deployment. These gaps remain:

1. I have no authenticated human-action adapter or externally trusted signer/enrollment contract for the app, mobile or human CLI. The machine-auth service authenticates daemons, not human intent. The new bootstrap authority is an interface, not a deployed identity integration. Protected HTTP writes therefore remain denied even to the owner. I have not read credentials or enrolled a key.
2. I do not yet persist authenticated creation principal, immutable creation event receipt, pin actor/event identity or append-only mutation audit history. The new pin source and flags are durable policy state, not a complete provenance/audit record. Public callers create unknown-origin rows until a trusted creation adapter is implemented. Such rows are not automatically pinned.
3. I do not wire approval cards, trusted card response, CSRF/origin validation, human owner UI/CLI execution, SDK grant transport or asynchronous command outbox. A pure signed issuer/transaction test does not prove these missing surfaces. General protected HTTP approval execution stays closed.
4. I do not yet cover every direct-store mutation, plugin server callback, section rename/delete, global queue operation, internal host command or WebSocket message. The public thread middleware is one verified boundary, not universal persistence enforcement.
5. I preflight direct archive batch members, but I have not proven recursive indirect lifecycle/environment cleanup closure or races with a newly attached protected descendant. I do not claim distributed or cross-process serializability from synchronous fixture tests.
6. The companion workspace patch guards the owner-prefix sweep, auto-answer function, BB naming/archive helper and the watchdog title-prefix path. It does not yet guard every watchdog process termination, DLG driver/reaper kill, session-channel sweeper, native Codex cleanup, RC proxy/provider mirror, chats-api kill/archive path or vps-mcp Jawing tool. Caller-side supported metadata preflight does not eliminate a check/use race before external process effects.
7. I have not run the entire server, CLI and integration suites. The targeted HTTP suites and full database/domain suites are the executed tests. Repository lint has existing findings; I compare those against the exact starting source rather than calling lint green.

I require the owning session to supply or select the trusted human-action/signer integration before I can finish the human creation and approval path. I must then implement the remaining source gaps and repeat exact-head review. No production approval is needed to continue source-only work once that contract is available. Existing-session restoration remains separately held.

## Reproducible isolated checks

I use Node 22.22.3 and the repository-pinned pnpm 9.15.0. I install the frozen lockfile with dependency scripts disabled in a new isolated checkout because no BB dependency tree was available to link. I inspect and fetch only the better-sqlite3 native binary needed for isolated fixtures. I add no dependency or lockfile changes.

I run these through the box-wide heavy-job lock, with the pnpm shim and repository bin directory on PATH:

```
pnpm exec turbo run test --filter=@bb/db --filter=@bb/domain
pnpm exec turbo run test --filter=@bb/server -- test/threads/thread-origin-lifecycle.test.ts test/threads/thread-mutation-security.test.ts
pnpm exec turbo run build typecheck --filter=@bb/db --filter=@bb/domain --filter=@bb/server --filter=@bb/cli --concurrency=2
```

I run the incident test against an isolated copy of the original `threads.ts`: manual unpin and rename both fail the required denial assertions. I run the same test against the patch and both pass. I never substitute a live target or import a production operational writer to obtain that result.

I generate the additive migration with `pnpm exec drizzle-kit generate --config drizzle.preview.config.ts` from `packages/db`. That config has no database URL. Migration regression fixtures use memory databases. I never run migration against an application store.

## Preview and rollback

I classify only a supported `bb thread list --include-archived --include-hidden --json` export. Missing protection fields mean unknown, never bot ownership. I propose zero existing-row writes and zero retroactive pins. Deleted threads are not included in that CLI export, so the count is not a database-wide census.

For source-only rollback I leave both preview branches unmerged or revert their commits. No runtime rollback is needed because nothing is activated. Before any future activation I require a separately reviewed rollback artifact and a fail-closed operating plan. I retain added provenance, pin overrides, consumed grants and future audit history. I do not drop columns or revert to the original unsafe writers as a purported safe production rollback. Any temporary job hold or security configuration change needs its own authorization.
