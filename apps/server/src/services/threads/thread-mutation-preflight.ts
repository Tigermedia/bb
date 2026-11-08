import { getThread } from "@bb/db";
import { decideThreadLifecycle } from "@bb/domain";
import type { Hono } from "hono";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";

export function registerThreadMutationPreflight(
  app: Hono,
  deps: Pick<AppDeps, "db">,
): void {
  app.use("/threads/*", async (context, next) => {
    if (
      context.req.method === "GET" ||
      context.req.method === "HEAD" ||
      context.req.method === "OPTIONS"
    )
      return next();
    const match = context.req.path.match(/\/threads\/([^/]+)(?:\/|$)/u);
    if (!match)
      throw new ApiError(
        403,
        "thread_lifecycle_protected",
        "Unresolved mutation target",
      );
    const thread = getThread(deps.db, decodeURIComponent(match[1]));
    if (!thread) return next();
    const decision = decideThreadLifecycle({
      action: "metadata",
      actor: { kind: "automation", approvalId: null },
      creationProvenance: thread.creationProvenance,
      pinSource: thread.pinSource,
      humanPinProtected: thread.humanPinProtected,
      manualUnpin: thread.manualUnpin,
    });
    if (!decision.allow)
      throw new ApiError(
        403,
        "thread_lifecycle_protected",
        "Protected thread requires a trusted owner action adapter",
      );
    return next();
  });
}
