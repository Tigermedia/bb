import { z } from "zod";

export const threadCreationProvenanceValues = ["manual", "bot"] as const;
export const threadCreationProvenanceSchema = z.enum(
  threadCreationProvenanceValues,
);
export type ThreadCreationProvenance = z.infer<
  typeof threadCreationProvenanceSchema
>;

export const threadCreateOriginValues = [
  "app",
  "cli",
  "sdk",
  "plugin",
] as const;
export type ThreadCreateOrigin = (typeof threadCreateOriginValues)[number];

export function creationProvenanceForCreateOrigin(
  origin: ThreadCreateOrigin | null,
): ThreadCreationProvenance | null {
  void origin;
  return null;
}

export const threadLifecycleActionValues = [
  "archive",
  "close",
  "delete",
  "rename",
  "pin",
  "unpin",
  "reorder",
  "restore",
  "stop",
  "clear",
  "compact",
  "retry",
  "send",
  "queue",
  "metadata",
  "interaction",
  "fork",
  "read-state",
  "runtime-attach",
] as const;
export const threadLifecycleActionSchema = z.enum(threadLifecycleActionValues);
export type ThreadLifecycleAction = z.infer<typeof threadLifecycleActionSchema>;

export const ownerManualThreadLifecycleActor = {
  kind: "owner-manual",
} as const;

export type ThreadLifecycleActor =
  | { kind: "runtime" }
  | typeof ownerManualThreadLifecycleActor
  | {
      kind: "automation";
      approvalId: string | null;
      requesterId?: string;
      audience?: string;
    };

export const threadLifecycleDenialReasonValues = [
  "automatic-lifecycle-denied",
  "approval-rejected",
] as const;
export type ThreadLifecycleDenialReason =
  (typeof threadLifecycleDenialReasonValues)[number];

export interface ThreadLifecycleDecision {
  allow: boolean;
  consumeApprovalId: string | null;
  reason: ThreadLifecycleDenialReason | null;
}

export function decideThreadLifecycle(args: {
  action: ThreadLifecycleAction;
  actor: ThreadLifecycleActor;
  creationProvenance: ThreadCreationProvenance | null;
  pinSource?: "creation-default" | "human" | "bot-policy" | null;
  humanPinProtected?: boolean;
  manualUnpin?: boolean;
}): ThreadLifecycleDecision {
  if (args.actor.kind === "owner-manual") {
    return { allow: true, consumeApprovalId: null, reason: null };
  }
  if (args.actor.kind === "runtime") {
    return args.action === "read-state" || args.action === "runtime-attach"
      ? { allow: true, consumeApprovalId: null, reason: null }
      : {
          allow: false,
          consumeApprovalId: null,
          reason: "automatic-lifecycle-denied",
        };
  }
  const approvalId = args.actor.approvalId;
  if (approvalId !== null && approvalId.length > 0) {
    return { allow: true, consumeApprovalId: approvalId, reason: null };
  }
  if (
    args.creationProvenance === "bot" &&
    args.pinSource === "bot-policy" &&
    args.humanPinProtected === false &&
    args.manualUnpin === false
  ) {
    return { allow: true, consumeApprovalId: null, reason: null };
  }
  return {
    allow: false,
    consumeApprovalId: null,
    reason: "automatic-lifecycle-denied",
  };
}
