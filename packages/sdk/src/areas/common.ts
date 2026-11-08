import type { BbSdkTransport } from "../transport.js";

export interface CreateSdkAreaArgs {
  transport: BbSdkTransport;
}

type SignalRequestOptions = { init: { signal: AbortSignal } };

export function signalRequestArgs(
  signal: AbortSignal | undefined,
): [] | [SignalRequestOptions] {
  return signal === undefined ? [] : [{ init: { signal } }];
}

export const THREAD_LIFECYCLE_APPROVAL_HEADER_NAME =
  "x-bb-lifecycle-approval";

type LifecycleApprovalRequestOptions = {
  init: { headers: { "x-bb-lifecycle-approval": string } };
};

export function lifecycleApprovalRequestArgs(
  approvalId: string | undefined,
): [] | [LifecycleApprovalRequestOptions] {
  if (approvalId === undefined || approvalId.length === 0) return [];
  return [
    {
      init: {
        headers: {
          "x-bb-lifecycle-approval": approvalId,
        },
      },
    },
  ];
}
