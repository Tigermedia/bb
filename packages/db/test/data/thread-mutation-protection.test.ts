import { generateKeyPairSync, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  ownerManualThreadLifecycleActor,
  threadLifecycleActionValues,
} from "@bb/domain";
import { createMigratedConnection } from "../helpers/migrated-connection.js";
import { noopNotifier } from "../../src/notifier.js";
import { threads, threadLifecycleApprovals } from "../../src/schema.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import {
  archiveThread,
  createThread,
  getThread,
  pinThread,
  reorderPinnedThread,
  unpinThread,
  updateThread,
  deleteThread,
  unarchiveThread,
} from "../../src/data/threads.js";
import {
  approvalSigningPayload,
  authorizeThreadLifecycleMutation,
  issueThreadLifecycleApproval,
  configureThreadApprovalAuthority,
  mutationPayloadHash,
  type IssueThreadLifecycleApprovalArgs,
} from "../../src/data/thread-lifecycle-guard.js";

const automation = { kind: "automation", approvalId: null } as const;
const owner = ownerManualThreadLifecycleActor;
function setup(provenance: "manual" | "bot" | null = "manual") {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, {
    name: "isolated",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "isolated",
    source: {
      type: "local_path",
      hostId: host.id,
      path: "/tmp/protection-fixture",
    },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
    creationProvenance: provenance,
    title: "CLNT fixture",
  });
  return { db, thread };
}
function grant(
  db: ReturnType<typeof setup>["db"],
  threadId: string,
  overrides: Partial<IssueThreadLifecycleApprovalArgs> = {},
) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  configureThreadApprovalAuthority(db, publicKey);
  const args: IssueThreadLifecycleApprovalArgs = {
    threadId,
    action: "rename",
    payload: { title: "approved" },
    expectedRevision: getThread(db, threadId)!.mutationRevision,
    requesterId: "agent-A",
    audience: "bb-thread-mutation",
    expiresAt: Date.now() + 60_000,
    source: { kind: "owner-action", ref: "fixture-request-1" },
    ...overrides,
  };
  args.signature = sign(
    null,
    Buffer.from(approvalSigningPayload(args)),
    privateKey,
  ).toString("base64url");
  const { approvalId } = issueThreadLifecycleApproval(db, args);
  return {
    args,
    actor: {
      kind: "automation" as const,
      approvalId,
      requesterId: "agent-A",
      audience: "bb-thread-mutation",
    },
  };
}

describe("durable thread mutation protection", () => {
  it.each(threadLifecycleActionValues)(
    "denies unapproved %s on a manual thread",
    (action) => {
      const { db, thread } = setup();
      expect(() =>
        db.transaction((tx) =>
          authorizeThreadLifecycleMutation(tx, {
            action,
            actor: automation,
            now: Date.now(),
            thread,
          }),
        ),
      ).toThrow();
      expect(getThread(db, thread.id)?.mutationRevision).toBe(0);
      db.$client.close();
    },
  );
  it.each([null, "manual"] as const)(
    "guards rename, pin, unpin, hard delete and restore for %s origin",
    (provenance) => {
      const { db, thread } = setup(provenance);
      const before = getThread(db, thread.id);
      for (const mutate of [
        () => updateThread(db, noopNotifier, thread.id, { title: "unsafe" }),
        () => pinThread(db, noopNotifier, { threadId: thread.id }),
        () => unpinThread(db, noopNotifier, { threadId: thread.id }),
        () => deleteThread(db, noopNotifier, thread.id),
        () => unarchiveThread(db, noopNotifier, thread.id),
      ])
        expect(mutate).toThrow();
      expect(getThread(db, thread.id)).toEqual(before);
      db.$client.close();
    },
  );
  it("preserves eligible bot policy and makes a human pin durable after unpin", () => {
    const { db, thread } = setup("bot");
    pinThread(db, noopNotifier, { threadId: thread.id });
    unpinThread(db, noopNotifier, { threadId: thread.id });
    pinThread(db, noopNotifier, { threadId: thread.id, actor: owner });
    expect(getThread(db, thread.id)?.humanPinProtected).toBe(true);
    unpinThread(db, noopNotifier, { threadId: thread.id, actor: owner });
    expect(getThread(db, thread.id)?.manualUnpin).toBe(true);
    expect(() =>
      pinThread(db, noopNotifier, { threadId: thread.id }),
    ).toThrow();
    expect(() =>
      archiveThread(db, noopNotifier, thread.id, automation),
    ).toThrow();
    db.$client.close();
  });
  it("pins manual creation once and leaves later owner unpin intact through rename", () => {
    const { db, thread } = setup();
    expect(thread.pinnedAt).not.toBeNull();
    unpinThread(db, noopNotifier, { threadId: thread.id, actor: owner });
    updateThread(db, noopNotifier, thread.id, { title: "renamed" }, owner);
    expect(getThread(db, thread.id)?.pinnedAt).toBeNull();
    expect(getThread(db, thread.id)?.pinSource).toBe("creation-default");
    db.$client.close();
  });
  it("unknown historical pin source protects even a bot row", () => {
    const { db, thread } = setup("bot");
    db.update(threads)
      .set({ pinSource: null })
      .where(eq(threads.id, thread.id))
      .run();
    expect(() =>
      unpinThread(db, noopNotifier, { threadId: thread.id }),
    ).toThrow();
    db.$client.close();
  });
  it("accepts a signed exact grant once and rejects issuer replay", () => {
    const { db, thread } = setup();
    const { actor, args } = grant(db, thread.id);
    expect(
      updateThread(db, noopNotifier, thread.id, { title: "approved" }, actor)
        ?.title,
    ).toBe("approved");
    expect(() =>
      updateThread(db, noopNotifier, thread.id, { title: "approved" }, actor),
    ).toThrow();
    expect(() => issueThreadLifecycleApproval(db, args)).toThrow();
    expect(
      db.select().from(threadLifecycleApprovals).get()?.consumedAt,
    ).not.toBeNull();
    db.$client.close();
  });
  it.each([
    "payload",
    "requester",
    "audience",
    "revision",
    "action",
    "thread",
    "expiry",
    "revocation",
  ])("rejects wrong %s without consuming the grant", (mismatch) => {
    const { db, thread } = setup();
    const { actor } = grant(db, thread.id);
    if (mismatch === "expiry")
      db.update(threadLifecycleApprovals).set({ expiresAt: 1 }).run();
    if (mismatch === "revocation")
      db.update(threadLifecycleApprovals).set({ revokedAt: Date.now() }).run();
    if (mismatch === "revision")
      db.update(threads)
        .set({ mutationRevision: 1 })
        .where(eq(threads.id, thread.id))
        .run();
    const target =
      mismatch === "thread"
        ? createThread(db, noopNotifier, {
            projectId: thread.projectId,
            providerId: "codex",
            creationProvenance: "manual",
          })
        : thread;
    expect(() =>
      db.transaction((tx) =>
        authorizeThreadLifecycleMutation(tx, {
          thread: getThread(tx, target.id)!,
          action: mismatch === "action" ? "archive" : "rename",
          now: Date.now(),
          payload: { title: mismatch === "payload" ? "wrong" : "approved" },
          actor: {
            ...actor,
            requesterId:
              mismatch === "requester" ? "agent-B" : actor.requesterId,
            audience: mismatch === "audience" ? "elsewhere" : actor.audience,
          },
        }),
      ),
    ).toThrow();
    expect(
      db.select().from(threadLifecycleApprovals).get()?.consumedAt,
    ).toBeNull();
    db.$client.close();
  });
  it("rolls back approval consumption and revision when the mutation fails", () => {
    const { db, thread } = setup();
    const { actor } = grant(db, thread.id);
    db.$client.exec(
      "CREATE TRIGGER fail_title BEFORE UPDATE OF title ON threads BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
    );
    expect(() =>
      updateThread(db, noopNotifier, thread.id, { title: "approved" }, actor),
    ).toThrow();
    expect(getThread(db, thread.id)?.mutationRevision).toBe(0);
    expect(
      db.select().from(threadLifecycleApprovals).get()?.consumedAt,
    ).toBeNull();
    db.$client.exec("DROP TRIGGER fail_title");
    expect(
      updateThread(db, noopNotifier, thread.id, { title: "approved" }, actor)
        ?.title,
    ).toBe("approved");
    db.$client.close();
  });
  it("rejects unsigned issuance and changed signed claims", () => {
    const { db, thread } = setup();
    const { args } = grant(db, thread.id);
    expect(() =>
      issueThreadLifecycleApproval(db, { ...args, signature: undefined }),
    ).toThrow();
    expect(() =>
      issueThreadLifecycleApproval(db, {
        ...args,
        payload: { title: "forged" },
      }),
    ).toThrow();
    expect(() =>
      issueThreadLifecycleApproval(db, { ...args, expectedRevision: 44 }),
    ).toThrow();
    db.$client.close();
  });
  it("allows scoped runtime read state but denies runtime title or policy changes", () => {
    const { db, thread } = setup();
    expect(
      updateThread(
        db,
        noopNotifier,
        thread.id,
        { lastReadAt: 42 },
        { kind: "runtime" },
      )?.lastReadAt,
    ).toBe(42);
    expect(() =>
      updateThread(
        db,
        noopNotifier,
        thread.id,
        { title: "forged" },
        { kind: "runtime" },
      ),
    ).toThrow();
    expect(() =>
      unpinThread(db, noopNotifier, {
        threadId: thread.id,
        actor: { kind: "runtime" },
      }),
    ).toThrow();
    db.$client.close();
  });
  it("pins the issuer key at trusted bootstrap and rejects a caller-supplied replacement", () => {
    const { db, thread } = setup();
    const { args } = grant(db, thread.id);
    const attacker = generateKeyPairSync("ed25519");
    expect(() =>
      configureThreadApprovalAuthority(db, attacker.publicKey),
    ).toThrow();
    const forged = {
      ...args,
      trustedOwnerPublicKey: attacker.publicKey,
      signature: sign(
        null,
        Buffer.from(approvalSigningPayload(args)),
        attacker.privateKey,
      ).toString("base64url"),
    };
    expect(() => issueThreadLifecycleApproval(db, forged)).toThrow();
    db.$client.close();
  });
  it("does not consume an approval for an invalid reorder", () => {
    const { db, thread } = setup("bot");
    pinThread(db, noopNotifier, { threadId: thread.id, actor: owner });
    const { actor } = grant(db, thread.id, {
      action: "reorder",
      payload: { nextThreadId: "thr_missing", previousThreadId: null },
    });
    expect(
      reorderPinnedThread({
        db,
        notifier: noopNotifier,
        threadId: thread.id,
        nextThreadId: "thr_missing",
        previousThreadId: null,
        actor,
      }),
    ).toEqual({ kind: "stale_neighbor" });
    expect(
      db.select().from(threadLifecycleApprovals).get()?.consumedAt,
    ).toBeNull();
    db.$client.close();
  });
  it("canonicalizes object ordering but preserves action payload content", () => {
    expect(mutationPayloadHash({ a: 1, b: 2 })).toBe(
      mutationPayloadHash({ b: 2, a: 1 }),
    );
    expect(mutationPayloadHash({ a: 1 })).not.toBe(
      mutationPayloadHash({ a: 2 }),
    );
    expect(() => mutationPayloadHash({ a: undefined })).toThrow();
  });
});
