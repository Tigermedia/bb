import {
  getProject,
  getThread,
  issueThreadLifecycleApproval,
  unarchiveThread,
} from "@bb/db";
import { createThreadRequestSchema } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import { textInput } from "../helpers/prompt-input.js";
import { createThreadFromRequest } from "../../src/services/threads/thread-create.js";
import { THREAD_LIFECYCLE_APPROVAL_HEADER_NAME } from "../../src/services/threads/thread-lifecycle-actor.js";

const automationHeaders = {
  "x-bb-lifecycle-test-actor": "automation",
};

function automationPost(extraHeaders?: Record<string, string>) {
  return {
    method: "POST" as const,
    headers: { ...automationHeaders, ...extraHeaders },
  };
}

function automationJson(body: unknown, extraHeaders?: Record<string, string>) {
  return {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-bb-lifecycle-test-actor": "automation",
      ...extraHeaders,
    },
  };
}

describe("thread origin lifecycle", () => {
  it("derives provenance and the create-time pin from origin, not from the client", async () => {
    const parsed = createThreadRequestSchema.parse({
      approved: true,
      creationProvenance: "bot",
      environment: {
        type: "host",
        hostId: "host-origin-lifecycle",
        workspace: { type: "unmanaged", path: "/tmp/origin-lifecycle" },
      },
      input: [{ type: "text", text: "hello" }],
      origin: "app",
      projectId: "proj",
      providerId: "codex",
    });
    expect(parsed).not.toHaveProperty("creationProvenance");
    expect(parsed).not.toHaveProperty("approved");

    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-origin-lifecycle",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/origin-lifecycle",
      });
      seedEnvironment(harness.deps, {
        hostId: host.id,
        path: "/tmp/origin-lifecycle",
        projectId: project.id,
      });
      const environment = {
        type: "host" as const,
        hostId: host.id,
        workspace: {
          type: "unmanaged" as const,
          path: "/tmp/origin-lifecycle",
        },
      };
      const manual = await createThreadFromRequest(harness.deps, {
        environment,
        input: textInput("Open manually"),
        origin: "app",
        projectId: project.id,
        providerId: "codex",
        startedOnBehalfOf: null,
        title: "[GB] TODO",
      });
      const hidden = await createThreadFromRequest(harness.deps, {
        environment,
        input: textInput("Hidden manual"),
        origin: "app",
        projectId: project.id,
        providerId: "codex",
        startedOnBehalfOf: null,
        visibility: "hidden",
      });
      const cli = await createThreadFromRequest(harness.deps, {
        environment,
        input: textInput("Spawned by cli"),
        origin: "cli",
        projectId: project.id,
        providerId: "codex",
        startedOnBehalfOf: null,
        title: "[DB] decision",
      });
      const sdk = await createThreadFromRequest(harness.deps, {
        environment,
        input: textInput("Spawned by sdk"),
        origin: "sdk",
        projectId: project.id,
        providerId: "codex",
        startedOnBehalfOf: null,
      });

      expect(manual.creationProvenance).toBe("manual");
      expect(manual.pinnedAt).toEqual(expect.any(Number));
      expect(hidden.creationProvenance).toBe("manual");
      expect(hidden.pinnedAt).toBeNull();
      expect(cli.creationProvenance).toBe("bot");
      expect(cli.pinnedAt).toBeNull();
      expect(sdk.creationProvenance).toBeNull();
      expect(sdk.pinnedAt).toBeNull();
    });
  });

  it("blocks automatic archive and close and honors one exact approval", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-lifecycle-gate",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/lifecycle-gate",
      });
      const manual = seedThread(harness.deps, {
        creationProvenance: "manual",
        projectId: project.id,
        title: "manual",
      });
      const unknown = seedThread(harness.deps, {
        projectId: project.id,
        title: "unknown",
      });
      const bot = seedThread(harness.deps, {
        creationProvenance: "bot",
        projectId: project.id,
        title: "[GB] TODO",
      });
      const botChild = seedThread(harness.deps, {
        creationProvenance: "bot",
        parentThreadId: manual.id,
        projectId: project.id,
      });
      const manualChild = seedThread(harness.deps, {
        creationProvenance: "manual",
        parentThreadId: bot.id,
        projectId: project.id,
      });

      const denied = await harness.app.request(
        `/api/v1/threads/${manual.id}/archive`,
        automationPost(),
      );
      expect(denied.status).toBe(403);
      expect(await readJson(denied)).toMatchObject({
        code: "thread_lifecycle_protected",
      });
      expect(denied.headers.get("set-cookie")).toBeNull();
      expect(getThread(harness.db, manual.id)?.archivedAt).toBeNull();

      const spoofed = await harness.app.request(
        `/api/v1/threads/${unknown.id}/archive`,
        automationJson({ approved: true, approvalId: "not-issued" }),
      );
      expect(spoofed.status).toBe(403);
      expect(getThread(harness.db, unknown.id)?.archivedAt).toBeNull();

      const headerOnly = await harness.app.request(
        `/api/v1/threads/${manual.id}/archive`,
        {
          method: "POST",
          headers: {
            "x-bb-app-surface": "desktop",
            ...automationHeaders,
          },
        },
      );
      expect(headerOnly.status).toBe(403);
      const setCookie = headerOnly.headers.get("set-cookie");
      expect(setCookie).toContain("bb_owner_lifecycle=");
      const ownerArchive = await harness.app.request(
        `/api/v1/threads/${manual.id}/archive`,
        {
          method: "POST",
          headers: { cookie: setCookie?.split(";")[0] ?? "" },
        },
      );
      expect(ownerArchive.status).toBe(200);
      expect(getThread(harness.db, manual.id)?.archivedAt).toEqual(
        expect.any(Number),
      );
      unarchiveThread(harness.db, harness.hub, manual.id);

      const botArchive = await harness.app.request(
        `/api/v1/threads/${bot.id}/archive`,
        automationPost(),
      );
      expect(botArchive.status).toBe(200);
      unarchiveThread(harness.db, harness.hub, bot.id);

      const bulkDenied = await harness.app.request(
        `/api/v1/threads/${manual.id}/archive-all`,
        automationPost(),
      );
      expect(bulkDenied.status).toBe(403);
      expect(getThread(harness.db, manual.id)?.archivedAt).toBeNull();
      expect(getThread(harness.db, botChild.id)?.archivedAt).toBeNull();

      const partial = await harness.app.request(
        `/api/v1/threads/${bot.id}/archive-all`,
        automationPost(),
      );
      expect(partial.status).toBe(200);
      expect(await readJson(partial)).toMatchObject({
        archivedThreadIds: [bot.id],
      });
      expect(getThread(harness.db, manualChild.id)?.archivedAt).toBeNull();
      unarchiveThread(harness.db, harness.hub, bot.id);

      const approval = issueThreadLifecycleApproval(harness.db, {
        action: "archive",
        expiresAt: Date.now() + 60_000,
        source: { kind: "owner-card", ref: "card-1" },
        threadId: manual.id,
      });
      const wrongSession = await harness.app.request(
        `/api/v1/threads/${unknown.id}/archive`,
        {
          method: "POST",
          headers: {
            [THREAD_LIFECYCLE_APPROVAL_HEADER_NAME]: approval.approvalId,
            ...automationHeaders,
          },
        },
      );
      expect(wrongSession.status).toBe(403);
      const wrongAction = await harness.app.request(
        `/api/v1/threads/${manual.id}`,
        {
          method: "DELETE",
          body: JSON.stringify({ childThreadsConfirmed: false }),
          headers: {
            "content-type": "application/json",
            [THREAD_LIFECYCLE_APPROVAL_HEADER_NAME]: approval.approvalId,
            "x-bb-lifecycle-test-actor": "automation",
          },
        },
      );
      expect(wrongAction.status).toBe(403);
      const exact = await harness.app.request(
        `/api/v1/threads/${manual.id}/archive`,
        {
          method: "POST",
          headers: {
            [THREAD_LIFECYCLE_APPROVAL_HEADER_NAME]: approval.approvalId,
            ...automationHeaders,
          },
        },
      );
      expect(exact.status).toBe(200);
      unarchiveThread(harness.db, harness.hub, manual.id);
      const replay = await harness.app.request(
        `/api/v1/threads/${manual.id}/archive`,
        {
          method: "POST",
          headers: {
            [THREAD_LIFECYCLE_APPROVAL_HEADER_NAME]: approval.approvalId,
            ...automationHeaders,
          },
        },
      );
      expect(replay.status).toBe(403);
      expect(getThread(harness.db, manual.id)?.archivedAt).toBeNull();

      const ownerClose = await harness.app.request(
        `/api/v1/threads/${unknown.id}`,
        {
          method: "DELETE",
          body: JSON.stringify({
            approved: true,
            childThreadsConfirmed: false,
          }),
          headers: { "content-type": "application/json" },
        },
      );
      expect(ownerClose.status).toBe(200);
      expect(getThread(harness.db, unknown.id)).toBeNull();
    });
  });

  it("does not let bulk, project, or plugin-shaped calls bypass the gate", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-lifecycle-bulk",
      });
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/lifecycle-bulk",
      });
      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        isWorktree: true,
        path: "/tmp/lifecycle-bulk",
        projectId: project.id,
      });
      const manual = seedThread(harness.deps, {
        creationProvenance: "manual",
        environmentId: environment.id,
        projectId: project.id,
      });
      const bot = seedThread(harness.deps, {
        creationProvenance: "bot",
        environmentId: environment.id,
        projectId: project.id,
        title: "[GB] TODO",
      });
      const approval = issueThreadLifecycleApproval(harness.db, {
        action: "archive",
        expiresAt: Date.now() + 60_000,
        source: { kind: "owner-card", ref: "card-bulk" },
        threadId: manual.id,
      });
      const bulk = await harness.app.request(
        `/api/v1/environments/${environment.id}/archive-threads`,
        {
          method: "POST",
          headers: {
            [THREAD_LIFECYCLE_APPROVAL_HEADER_NAME]: approval.approvalId,
            ...automationHeaders,
          },
        },
      );
      expect(bulk.status).toBe(200);
      expect(await readJson(bulk)).toEqual({
        ok: true,
        archivedThreadIds: [bot.id],
      });
      expect(getThread(harness.db, manual.id)?.archivedAt).toBeNull();

      const pluginShaped = await harness.app.request(
        `/api/v1/threads/${manual.id}/archive-all`,
        automationPost(),
      );
      expect(pluginShaped.status).toBe(403);

      const refused = await harness.app.request(
        `/api/v1/projects/${project.id}`,
        { method: "DELETE", headers: automationHeaders },
      );
      expect(refused.status).toBe(403);
      expect(getProject(harness.db, project.id)?.deletedAt).toBeNull();
      expect(getThread(harness.db, manual.id)?.deletedAt).toBeNull();

      const allowed = await harness.app.request(
        `/api/v1/projects/${project.id}`,
        { method: "DELETE" },
      );
      expect(allowed.status).toBe(200);
      expect(getThread(harness.db, manual.id)?.deletedAt).toEqual(
        expect.any(Number),
      );
      expect(getThread(harness.db, bot.id)?.deletedAt).toEqual(
        expect.any(Number),
      );
    });
  });
});
