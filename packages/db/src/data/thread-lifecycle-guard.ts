import { createHash, verify, type KeyObject } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  decideThreadLifecycle,
  type ThreadCreationProvenance,
  type ThreadLifecycleAction,
  type ThreadLifecycleActor,
  type ThreadLifecycleDenialReason,
} from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import { threadLifecycleApprovals, threads } from "../schema.js";

type ThreadWriteConnection = DbConnection | DbTransaction;

export class ThreadLifecycleProtectedError extends Error {
  readonly action: ThreadLifecycleAction;
  readonly reason: ThreadLifecycleDenialReason;
  readonly threadId: string;

  constructor(args: {
    action: ThreadLifecycleAction;
    reason: ThreadLifecycleDenialReason;
    threadId: string;
  }) {
    super(
      args.reason === "approval-rejected"
        ? `Thread lifecycle approval was rejected for ${args.action}`
        : `Automatic ${args.action} is not allowed for this thread`,
    );
    this.name = "ThreadLifecycleProtectedError";
    this.action = args.action;
    this.reason = args.reason;
    this.threadId = args.threadId;
  }
}

export interface IssueThreadLifecycleApprovalArgs {
  action: ThreadLifecycleAction;
  expiresAt: number;
  source: { kind: string; ref: string };
  threadId: string;
  payload?: unknown;
  expectedRevision?: number;
  requesterId?: string;
  audience?: string;
  signature?: string;
}

export function canonicalMutationPayload(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalMutationPayload).join(",")}]`;
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalMutationPayload(Reflect.get(value, key))}`,
      )
      .join(",")}}`;
  }
  throw new Error("Mutation payload must be JSON");
}

export function mutationPayloadHash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalMutationPayload(value))
    .digest("hex");
}

export function approvalSigningPayload(
  args: IssueThreadLifecycleApprovalArgs,
): string {
  return canonicalMutationPayload({
    action: args.action,
    threadId: args.threadId,
    payloadHash: mutationPayloadHash(args.payload ?? null),
    expectedRevision: args.expectedRevision ?? null,
    requesterId: args.requesterId ?? null,
    audience: args.audience ?? null,
    expiresAt: args.expiresAt,
    source: args.source,
  });
}

const approvalAuthorities = new WeakMap<DbConnection, KeyObject>();

export function configureThreadApprovalAuthority(
  db: DbConnection,
  publicKey: KeyObject,
): void {
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519")
    throw new Error("Owner approval authority requires an Ed25519 public key");
  const current = approvalAuthorities.get(db);
  if (
    current &&
    !current
      .export({ format: "der", type: "spki" })
      .equals(publicKey.export({ format: "der", type: "spki" }))
  )
    throw new Error(
      "Owner approval authority cannot be replaced in a running server",
    );
  approvalAuthorities.set(db, publicKey);
}

export function issueThreadLifecycleApproval(
  db: DbConnection,
  args: IssueThreadLifecycleApprovalArgs,
): { approvalId: string } {
  const trustedOwnerPublicKey = approvalAuthorities.get(db);
  if (
    !trustedOwnerPublicKey ||
    !args.signature ||
    !Number.isSafeInteger(args.expectedRevision) ||
    !args.requesterId ||
    !args.audience ||
    args.expiresAt <= Date.now() ||
    args.expiresAt > Date.now() + 300_000 ||
    !verify(
      null,
      Buffer.from(approvalSigningPayload(args)),
      trustedOwnerPublicKey,
      Buffer.from(args.signature, "base64url"),
    )
  ) {
    throw new Error("Trusted signed owner approval is required");
  }
  const sourceKind = args.source.kind.trim();
  const sourceRef = args.source.ref.trim();
  if (sourceKind.length === 0 || sourceRef.length === 0) {
    throw new Error("Thread lifecycle approval requires a source");
  }
  if (!Number.isFinite(args.expiresAt)) {
    throw new Error("Thread lifecycle approval requires an expiry");
  }
  const thread = db
    .select({ deletedAt: threads.deletedAt, id: threads.id })
    .from(threads)
    .where(eq(threads.id, args.threadId))
    .get();
  if (!thread || thread.deletedAt !== null) {
    throw new Error("Thread lifecycle approval requires a live thread");
  }
  const id = `tlap_${createHash("sha256").update(approvalSigningPayload(args)).digest("hex")}`;
  db.insert(threadLifecycleApprovals)
    .values({
      action: args.action,
      payloadHash: mutationPayloadHash(args.payload ?? null),
      expectedRevision: args.expectedRevision,
      requesterId: args.requesterId,
      audience: args.audience,
      consumedAt: null,
      expiresAt: args.expiresAt,
      id,
      issuedAt: Date.now(),
      sourceKind,
      sourceRef,
      threadId: args.threadId,
    })
    .run();
  return { approvalId: id };
}

function consumeThreadLifecycleApproval(
  db: ThreadWriteConnection,
  args: {
    action: ThreadLifecycleAction;
    approvalId: string;
    now: number;
    threadId: string;
    payload: unknown;
    revision: number;
    requesterId: string;
    audience: string;
    validateOnly?: boolean;
  },
): boolean {
  const where = and(
    eq(threadLifecycleApprovals.id, args.approvalId),
    eq(threadLifecycleApprovals.threadId, args.threadId),
    eq(threadLifecycleApprovals.action, args.action),
    isNull(threadLifecycleApprovals.consumedAt),
    isNull(threadLifecycleApprovals.revokedAt),
    eq(threadLifecycleApprovals.payloadHash, mutationPayloadHash(args.payload)),
    eq(threadLifecycleApprovals.expectedRevision, args.revision),
    eq(threadLifecycleApprovals.requesterId, args.requesterId),
    eq(threadLifecycleApprovals.audience, args.audience),
    gt(threadLifecycleApprovals.expiresAt, args.now),
  );
  if (args.validateOnly)
    return (
      db
        .select({ id: threadLifecycleApprovals.id })
        .from(threadLifecycleApprovals)
        .where(where)
        .get() !== undefined
    );
  const updated = db
    .update(threadLifecycleApprovals)
    .set({ consumedAt: args.now })
    .where(where)
    .returning({ id: threadLifecycleApprovals.id })
    .get();
  return updated !== undefined;
}

export function authorizeThreadLifecycleMutation(
  db: ThreadWriteConnection,
  args: {
    action: ThreadLifecycleAction;
    actor: ThreadLifecycleActor;
    now: number;
    payload?: unknown;
    validateOnly?: boolean;
    thread: {
      creationProvenance: ThreadCreationProvenance | null;
      id: string;
      pinSource?: "creation-default" | "human" | "bot-policy" | null;
      humanPinProtected?: boolean;
      manualUnpin?: boolean;
      mutationRevision?: number;
    };
  },
): void {
  const current = db
    .select()
    .from(threads)
    .where(eq(threads.id, args.thread.id))
    .get();
  if (!current)
    throw new ThreadLifecycleProtectedError({
      action: args.action,
      reason: "automatic-lifecycle-denied",
      threadId: args.thread.id,
    });
  if (args.actor.kind === "runtime") {
    const payload = args.payload;
    const allowed =
      typeof payload === "object" &&
      payload !== null &&
      Object.keys(payload).length === 1 &&
      ((args.action === "read-state" &&
        "lastReadAt" in payload &&
        typeof payload.lastReadAt === "number" &&
        Number.isFinite(payload.lastReadAt)) ||
        (args.action === "runtime-attach" &&
          "environmentId" in payload &&
          typeof payload.environmentId === "string" &&
          current.environmentId === null &&
          (current.status === "pending" || current.status === "starting")));
    if (!allowed)
      throw new ThreadLifecycleProtectedError({
        threadId: current.id,
        action: args.action,
        reason: "automatic-lifecycle-denied",
      });
  }
  const decision = decideThreadLifecycle({
    action: args.action,
    actor: args.actor,
    creationProvenance: current.creationProvenance,
    pinSource: current.pinSource,
    humanPinProtected: current.humanPinProtected,
    manualUnpin: current.manualUnpin,
  });
  if (!decision.allow || decision.reason !== null) {
    throw new ThreadLifecycleProtectedError({
      action: args.action,
      reason: decision.reason ?? "automatic-lifecycle-denied",
      threadId: args.thread.id,
    });
  }
  if (decision.consumeApprovalId === null) {
    if (args.validateOnly) return;
    db.update(threads)
      .set({ mutationRevision: current.mutationRevision + 1 })
      .where(eq(threads.id, args.thread.id))
      .run();
    return;
  }
  const consumed = consumeThreadLifecycleApproval(db, {
    action: args.action,
    approvalId: decision.consumeApprovalId,
    validateOnly: args.validateOnly,
    now: args.now,
    threadId: args.thread.id,
    payload: args.payload ?? null,
    revision: current.mutationRevision,
    requesterId:
      args.actor.kind === "automation" ? (args.actor.requesterId ?? "") : "",
    audience:
      args.actor.kind === "automation" ? (args.actor.audience ?? "") : "",
  });
  if (!consumed) {
    throw new ThreadLifecycleProtectedError({
      action: args.action,
      reason: "approval-rejected",
      threadId: args.thread.id,
    });
  }
  if (args.validateOnly) return;
  db.update(threads)
    .set({ mutationRevision: current.mutationRevision + 1 })
    .where(eq(threads.id, args.thread.id))
    .run();
}
