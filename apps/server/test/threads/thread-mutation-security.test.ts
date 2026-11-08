import { describe, expect, it } from "vitest";
import { getThread, pinThread } from "@bb/db";
import { ownerManualThreadLifecycleActor } from "@bb/domain";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
import { resolveThreadLifecycleActor } from "../../src/services/threads/thread-lifecycle-actor.js";

const mutations = [
  ["PATCH", ""],
  ["DELETE", ""],
  ["POST", "/send"],
  ["POST", "/edit-message"],
  ["POST", "/retry"],
  ["POST", "/stop"],
  ["POST", "/compact"],
  ["POST", "/context/clear"],
  ["POST", "/plan/cancel"],
  ["POST", "/goal/clear"],
  ["POST", "/open"],
  ["POST", "/pane-action"],
  ["PUT", "/tabs"],
  ["POST", "/pin"],
  ["POST", "/unpin"],
  ["PATCH", "/pin-order"],
  ["POST", "/archive"],
  ["POST", "/archive-all"],
  ["POST", "/unarchive"],
  ["POST", "/queued-messages"],
  ["PATCH", "/queued-messages/fake"],
  ["DELETE", "/queued-messages/fake"],
  ["POST", "/queued-messages/fake/send"],
  ["PATCH", "/queued-messages/fake/order"],
  ["POST", "/interactions/fake/respond"],
  ["POST", "/interactions/fake/resolve"],
  ["POST", "/interactions/fake/cancel"],
] as const;

describe("public mutation security boundary", () => {
  it.each(["manual", null] as const)(
    "blocks every explicit thread route for %s provenance before validation or effects",
    async (creationProvenance) => {
      await withTestHarness(async (harness) => {
        const { host } = seedHostSession(harness.deps);
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
          path: "/tmp/security-fixture",
        });
        const thread = seedThread(harness.deps, {
          projectId: project.id,
          creationProvenance,
        });
        const before = getThread(harness.db, thread.id);
        for (const [method, suffix] of mutations) {
          const response = await harness.app.request(
            `/api/v1/threads/${thread.id}${suffix}`,
            {
              method,
              headers: {
                "content-type": "application/json",
                "x-bb-app-surface": "web",
                "x-bb-owner": "true",
                "x-bb-lifecycle-approval": "forged",
                cookie: "bb_owner_lifecycle=forged",
              },
              body: JSON.stringify({
                title: "forged",
                origin: "app",
                approved: true,
              }),
            },
          );
          expect(response.status, `${method} ${suffix}`).toBe(403);
          expect(response.headers.get("set-cookie")).toBeNull();
          expect(getThread(harness.db, thread.id)).toEqual(before);
        }
        expect(
          (await harness.app.request(`/api/v1/threads/${thread.id}`)).status,
        ).toBe(200);
      });
    },
  );
  it("blocks a human-pinned bot while an eligible bot keeps its pin policy", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/security-fixture",
      });
      const thread = seedThread(harness.deps, {
        projectId: project.id,
        creationProvenance: "bot",
      });
      expect(
        (
          await harness.app.request(`/api/v1/threads/${thread.id}/pin`, {
            method: "POST",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await harness.app.request(`/api/v1/threads/${thread.id}/unpin`, {
            method: "POST",
          })
        ).status,
      ).toBe(200);
      pinThread(harness.db, harness.hub, {
        threadId: thread.id,
        actor: ownerManualThreadLifecycleActor,
      });
      expect(
        (
          await harness.app.request(`/api/v1/threads/${thread.id}/unpin`, {
            method: "POST",
          })
        ).status,
      ).toBe(403);
      expect(getThread(harness.db, thread.id)?.pinnedAt).not.toBeNull();
    });
  });
  it("cannot promote even the old owner cookie to human authority", () => {
    const headers = new Map([
      ["cookie", "bb_owner_lifecycle=known-secret"],
      ["x-bb-owner", "true"],
      ["x-bb-app-surface", "desktop"],
    ]);
    expect(
      resolveThreadLifecycleActor(
        { req: { header: (name) => headers.get(name) } },
        "known-secret",
      ),
    ).toEqual({ kind: "automation", approvalId: null });
  });
  it("does not issue an owner cookie in response to app surface declarations", async () => {
    await withTestHarness(async (harness) => {
      for (const surface of ["web", "desktop", "mobile"]) {
        const response = await harness.app.request("/api/v1/threads", {
          headers: { "x-bb-app-surface": surface },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("set-cookie")).toBeNull();
      }
    });
  });
});
