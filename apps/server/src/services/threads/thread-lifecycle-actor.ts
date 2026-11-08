import { randomBytes, timingSafeEqual } from "node:crypto";
import { ThreadLifecycleProtectedError } from "@bb/db";
import {
  ownerManualThreadLifecycleActor,
  type ThreadLifecycleActor,
} from "@bb/domain";
import { ApiError } from "../../errors.js";

export const OWNER_LIFECYCLE_COOKIE_NAME = "bb_owner_lifecycle";
export const THREAD_LIFECYCLE_APPROVAL_HEADER_NAME =
  "x-bb-lifecycle-approval";

export function ownerLifecycleSecretFor(deps: {
  ownerLifecycleSecret?: string;
}): string {
  if (
    deps.ownerLifecycleSecret === undefined ||
    deps.ownerLifecycleSecret.length === 0
  ) {
    deps.ownerLifecycleSecret = randomBytes(32).toString("base64url");
  }
  return deps.ownerLifecycleSecret;
}

export function ownerLifecycleCookieHeader(secret: string): string {
  return `${OWNER_LIFECYCLE_COOKIE_NAME}=${encodeURIComponent(secret)}`;
}

export function ownerLifecycleSetCookieHeader(secret: string): string {
  return `${ownerLifecycleCookieHeader(secret)}; Path=/; HttpOnly; SameSite=Lax`;
}

export function readRequestCookie(
  header: string | undefined,
  name: string,
): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function ownerLifecycleCookieMatches(
  cookieHeader: string | undefined,
  secret: string,
): boolean {
  const value = readRequestCookie(cookieHeader, OWNER_LIFECYCLE_COOKIE_NAME);
  if (value === null) return false;
  const actual = Buffer.from(value);
  const expected = Buffer.from(secret);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function resolveThreadLifecycleActor(
  context: { req: { header(name: string): string | undefined } },
  secret: string | undefined,
): ThreadLifecycleActor {
  if (
    secret !== undefined &&
    secret.length > 0 &&
    ownerLifecycleCookieMatches(context.req.header("cookie"), secret)
  ) {
    return ownerManualThreadLifecycleActor;
  }
  const approvalId =
    context.req.header(THREAD_LIFECYCLE_APPROVAL_HEADER_NAME)?.trim() ?? "";
  return {
    kind: "automation",
    approvalId: approvalId.length > 0 ? approvalId : null,
  };
}

export function actorForRelatedThreads(
  actor: ThreadLifecycleActor,
): ThreadLifecycleActor {
  if (actor.kind === "owner-manual") return ownerManualThreadLifecycleActor;
  return { kind: "automation", approvalId: null };
}

export function asThreadLifecycleApiError(error: unknown): never {
  if (error instanceof ThreadLifecycleProtectedError) {
    throw new ApiError(403, "thread_lifecycle_protected", error.message, {
      details: {
        action: error.action,
        reason: error.reason,
        threadId: error.threadId,
      },
    });
  }
  throw error;
}
