import { describe, expect, it } from "vitest";
import { createMigratedConnection } from "../helpers/migrated-connection.js";
import { noopNotifier } from "../../src/notifier.js";
import { createProject } from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createThread, getThread } from "../../src/data/threads.js";
import { unpinThread, updateThread } from "../../src/data/threads.js";

describe("incident security regression", () => {
  it.each(["unpin", "rename"])(
    "blocks an unapproved %s of a manual session",
    (action) => {
      const db = createMigratedConnection();
      const host = upsertHost(db, noopNotifier, {
        name: "fixture",
        type: "persistent",
      });
      const { project } = createProject(db, noopNotifier, {
        name: "fixture",
        source: { type: "local_path", hostId: host.id, path: "/tmp/fixture" },
      });
      const thread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        creationProvenance: "manual",
        title: "CLNT incident fixture",
      });
      const before = getThread(db, thread.id);
      try {
        expect(() =>
          action === "unpin"
            ? unpinThread(db, noopNotifier, { threadId: thread.id })
            : updateThread(db, noopNotifier, thread.id, {
                title: "[GB] rewritten",
              }),
        ).toThrow();
        expect(getThread(db, thread.id)).toEqual(before);
      } finally {
        db.$client.close();
      }
    },
  );
});
