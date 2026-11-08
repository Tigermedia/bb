import { and, eq, gt, isNull } from "drizzle-orm";
import {
  decideThreadLifecycle,
  type ThreadCreationProvenance,
  type ThreadLifecycleAction,
  type ThreadLifecycleActor,
  type ThreadLifecycleDenialReason,
} from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import { createThreadLifecycleApprovalId } from "../ids.js";
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
}

export function issueThreadLifecycleApproval(
  db: DbConnection,
  args: IssueThreadLifecycleApprovalArgs,
): { approvalId: string } {
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
  const id = createThreadLifecycleApprovalId();
  db.insert(threadLifecycleApprovals)
    .values({
      action: args.action,
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
  },
): boolean {
  const updated = db
    .update(threadLifecycleApprovals)
    .set({ consumedAt: args.now })
    .where(
      and(
        eq(threadLifecycleApprovals.id, args.approvalId),
        eq(threadLifecycleApprovals.threadId, args.threadId),
        eq(threadLifecycleApprovals.action, args.action),
        isNull(threadLifecycleApprovals.consumedAt),
        gt(threadLifecycleApprovals.expiresAt, args.now),
      ),
    )
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
    thread: {
      creationProvenance: ThreadCreationProvenance | null;
      id: string;
    };
  },
): void {
  const decision = decideThreadLifecycle({
    action: args.action,
    actor: args.actor,
    creationProvenance: args.thread.creationProvenance,
  });
  if (!decision.allow || decision.reason !== null) {
    throw new ThreadLifecycleProtectedError({
      action: args.action,
      reason: decision.reason ?? "automatic-lifecycle-denied",
      threadId: args.thread.id,
    });
  }
  if (decision.consumeApprovalId === null) {
    return;
  }
  const consumed = consumeThreadLifecycleApproval(db, {
    action: args.action,
    approvalId: decision.consumeApprovalId,
    now: args.now,
    threadId: args.thread.id,
  });
  if (!consumed) {
    throw new ThreadLifecycleProtectedError({
      action: args.action,
      reason: "approval-rejected",
      threadId: args.thread.id,
    });
  }
}
