import { z } from "zod";

export const threadCreationProvenanceValues = ["manual", "bot"] as const;
export const threadCreationProvenanceSchema = z.enum(
  threadCreationProvenanceValues,
);
export type ThreadCreationProvenance = z.infer<
  typeof threadCreationProvenanceSchema
>;

export const threadCreateOriginValues = ["app", "cli", "sdk", "plugin"] as const;
export type ThreadCreateOrigin = (typeof threadCreateOriginValues)[number];

export function creationProvenanceForCreateOrigin(
  origin: ThreadCreateOrigin | null,
): ThreadCreationProvenance | null {
  if (origin === "app") return "manual";
  if (origin === "cli" || origin === "plugin") return "bot";
  return null;
}

export const threadLifecycleActionValues = ["archive", "close"] as const;
export const threadLifecycleActionSchema = z.enum(threadLifecycleActionValues);
export type ThreadLifecycleAction = z.infer<typeof threadLifecycleActionSchema>;

export const ownerManualThreadLifecycleActor = {
  kind: "owner-manual",
} as const;

export type ThreadLifecycleActor =
  | typeof ownerManualThreadLifecycleActor
  | { kind: "automation"; approvalId: string | null };

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
}): ThreadLifecycleDecision {
  if (args.actor.kind === "owner-manual") {
    return { allow: true, consumeApprovalId: null, reason: null };
  }
  if (args.creationProvenance === "bot") {
    return { allow: true, consumeApprovalId: null, reason: null };
  }
  const approvalId = args.actor.approvalId;
  if (approvalId !== null && approvalId.length > 0) {
    return { allow: true, consumeApprovalId: approvalId, reason: null };
  }
  return {
    allow: false,
    consumeApprovalId: null,
    reason: "automatic-lifecycle-denied",
  };
}
