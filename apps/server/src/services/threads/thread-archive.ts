import {
  listLiveThreadsInEnvironment,
  listUnarchivedAssignedChildThreads,
  listUnarchivedHiddenSourceThreads,
  ThreadLifecycleProtectedError,
} from "@bb/db";
import type { Environment, Thread, ThreadLifecycleActor } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import {
  threadEnvironmentUnavailableDetails,
  throwThreadEnvironmentUnavailable,
} from "../lib/lifecycle-api-errors.js";
import {
  requestEnvironmentCleanup,
  requestEnvironmentCleanupAdvance,
  wouldCleanupEnvironment,
} from "../environments/environment-cleanup-internal.js";
import {
  pruneThreadEventHistoryBestEffort,
  resetActiveThreadEventPruningState,
} from "../system/event-pruning.js";
import { emitPluginThreadArchived } from "../plugins/plugin-thread-events.js";
import {
  dispatchSettledArchivedThreadProviderArchiveCommand,
  requestActiveRuntimeThreadStopIfNeeded,
} from "./thread-lifecycle.js";
import {
  archiveThreadAndReleaseChildren,
  releaseUnarchivedChildrenFromArchivedThread,
} from "./thread-ownership.js";
import {
  assertBatchThreadMutationAllowed,
  actorForRelatedThreads,
  asThreadLifecycleApiError,
} from "./thread-lifecycle-actor.js";
import { requireThreadHostCommandEnvironment } from "./thread-command-environment.js";
import { getActiveThreadProvisionContext } from "./thread-provisioning-active-context.js";
import { isPreStartThreadStatus } from "./thread-status.js";

interface ArchiveThreadEnvironment {
  hostId: string;
  id: string;
}

interface ArchiveThreadWithLifecycleEffectsArgs {
  actor: ThreadLifecycleActor;
  environment: ArchiveThreadEnvironment | null;
  releaseChildren?: boolean;
  skipProtected?: boolean;
  thread: Pick<Thread, "environmentId" | "id" | "status">;
}

interface ResolveArchiveThreadEnvironmentArgs {
  thread: ArchiveThreadWithLifecycleEffectsArgs["thread"];
}

interface ArchiveEnvironmentThreadsArgs {
  actor: ThreadLifecycleActor;
  environment: Environment;
}

interface ArchiveThreadAndChildrenArgs {
  actor: ThreadLifecycleActor;
  parentThread: Thread;
}

type ArchiveThreadAndHiddenSourceForksArgs =
  ArchiveThreadWithLifecycleEffectsArgs;

export function resolveArchiveThreadEnvironment(
  deps: Pick<AppDeps, "db">,
  args: ResolveArchiveThreadEnvironmentArgs,
): ArchiveThreadEnvironment | null {
  if (args.thread.environmentId !== null) {
    return requireThreadHostCommandEnvironment({
      db: deps.db,
      thread: args.thread,
    });
  }
  if (
    isPreStartThreadStatus(args.thread.status) ||
    args.thread.status === "stopping" ||
    getActiveThreadProvisionContext(args.thread.id) !== null
  ) {
    throwThreadEnvironmentUnavailable(
      threadEnvironmentUnavailableDetails("never_attached", null),
    );
  }
  return null;
}

function archiveThreadWithLifecycleEffects(
  deps: AppDeps,
  args: ArchiveThreadWithLifecycleEffectsArgs,
): Thread | null {
  let archivedThread: Thread | null;
  try {
    archivedThread = archiveThreadAndReleaseChildren(deps, {
      actor: args.actor,
      releaseChildren: args.releaseChildren,
      threadId: args.thread.id,
    });
  } catch (error) {
    if (args.skipProtected && error instanceof ThreadLifecycleProtectedError) {
      return null;
    }
    throw error;
  }
  if (!archivedThread) {
    return null;
  }

  deps.terminalSessions.closeArchivedThreadTerminals({
    threadId: archivedThread.id,
  });
  if (args.environment !== null) {
    requestActiveRuntimeThreadStopIfNeeded(
      deps,
      archivedThread,
      args.environment,
    );
  }
  dispatchSettledArchivedThreadProviderArchiveCommand(deps, {
    threadId: archivedThread.id,
  });
  resetActiveThreadEventPruningState(archivedThread.id);
  pruneThreadEventHistoryBestEffort(deps, {
    mode: "archived",
    threadId: archivedThread.id,
  });
  emitPluginThreadArchived(archivedThread);

  return archivedThread;
}

export function archiveThreadAndHiddenSourceForks(
  deps: AppDeps,
  args: ArchiveThreadAndHiddenSourceForksArgs,
): Thread | null {
  try {
    assertBatchThreadMutationAllowed(
      deps.db,
      [
        args.thread.id,
        ...listUnarchivedHiddenSourceThreads(deps.db, {
          sourceThreadId: args.thread.id,
        }).map((thread) => thread.id),
      ],
      args.actor,
      "archive",
    );
    const archivedThread = archiveThreadWithLifecycleEffects(deps, args);
    if (!archivedThread) {
      return null;
    }
    const relatedActor = actorForRelatedThreads(args.actor);
    for (const fork of listUnarchivedHiddenSourceThreads(deps.db, {
      sourceThreadId: archivedThread.id,
    })) {
      archiveThreadWithLifecycleEffects(deps, {
        actor: relatedActor,
        environment: resolveArchiveThreadEnvironment(deps, { thread: fork }),
        skipProtected: true,
        thread: fork,
      });
    }
    return archivedThread;
  } catch (error) {
    asThreadLifecycleApiError(error);
  }
}

export function archiveEnvironmentThreads(
  deps: AppDeps,
  args: ArchiveEnvironmentThreadsArgs,
): string[] {
  const threads = listLiveThreadsInEnvironment(deps.db, {
    environmentId: args.environment.id,
  });
  assertBatchThreadMutationAllowed(
    deps.db,
    threads.map((thread) => thread.id),
    args.actor,
    "archive",
  );
  const archivedThreadIds: string[] = [];

  for (const thread of threads) {
    const result = archiveThreadWithLifecycleEffects(deps, {
      actor: args.actor,
      environment: args.environment,
      skipProtected: true,
      thread,
    });
    if (!result) {
      continue;
    }
    archivedThreadIds.push(result.id);
  }

  if (
    archivedThreadIds.length > 0 &&
    wouldCleanupEnvironment(deps, {
      environmentId: args.environment.id,
    })
  ) {
    requestEnvironmentCleanup(deps, {
      environmentId: args.environment.id,
    });
    requestEnvironmentCleanupAdvance(deps, {
      environmentId: args.environment.id,
    });
  }

  return archivedThreadIds;
}

export function archiveThreadAndChildren(
  deps: AppDeps,
  args: ArchiveThreadAndChildrenArgs,
): string[] {
  try {
    return archiveThreadAndChildrenUnchecked(deps, args);
  } catch (error) {
    asThreadLifecycleApiError(error);
  }
}

function archiveThreadAndChildrenUnchecked(
  deps: AppDeps,
  args: ArchiveThreadAndChildrenArgs,
): string[] {
  const archivedThreadIds: string[] = [];
  const affectedEnvironmentIds = new Set<string>();
  const relatedThreads = [
    ...listUnarchivedAssignedChildThreads(deps.db, {
      parentThreadId: args.parentThread.id,
    }),
    ...listUnarchivedHiddenSourceThreads(deps.db, {
      sourceThreadId: args.parentThread.id,
    }),
  ].filter((thread) => thread.id !== args.parentThread.id);
  assertBatchThreadMutationAllowed(
    deps.db,
    [args.parentThread.id, ...relatedThreads.map((thread) => thread.id)],
    args.actor,
    "archive",
  );
  const parentAlreadyArchived = args.parentThread.archivedAt !== null;
  if (!parentAlreadyArchived) {
    const environment = resolveArchiveThreadEnvironment(deps, {
      thread: args.parentThread,
    });
    const result = archiveThreadWithLifecycleEffects(deps, {
      actor: args.actor,
      environment,
      releaseChildren: false,
      thread: args.parentThread,
    });
    if (!result) {
      return [];
    }
    if (environment !== null) {
      affectedEnvironmentIds.add(environment.id);
    }
  }

  const relatedActor = actorForRelatedThreads(args.actor);
  for (const thread of relatedThreads) {
    const environment = resolveArchiveThreadEnvironment(deps, { thread });
    const result = archiveThreadWithLifecycleEffects(deps, {
      actor: relatedActor,
      environment,
      skipProtected: true,
      thread,
    });
    if (!result) {
      continue;
    }
    archivedThreadIds.push(result.id);
    if (environment !== null) {
      affectedEnvironmentIds.add(environment.id);
    }
  }
  if (!parentAlreadyArchived) {
    archivedThreadIds.push(args.parentThread.id);
  }
  releaseUnarchivedChildrenFromArchivedThread(deps, args.parentThread.id);

  for (const environmentId of affectedEnvironmentIds) {
    if (
      wouldCleanupEnvironment(deps, {
        environmentId,
      })
    ) {
      requestEnvironmentCleanup(deps, { environmentId });
      requestEnvironmentCleanupAdvance(deps, { environmentId });
    }
  }

  return archivedThreadIds;
}
