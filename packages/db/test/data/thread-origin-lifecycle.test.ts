import Database from "better-sqlite3";
import fs from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ownerManualThreadLifecycleActor } from "@bb/domain";
import { noopNotifier } from "../../src/notifier.js";
import { threadLifecycleApprovals, threads } from "../../src/schema.js";
import {
  archiveThread,
  createThread,
  issueThreadLifecycleApproval,
  markThreadDeleted,
  pinThread,
  ThreadLifecycleProtectedError,
  unpinThread,
  updateThread,
} from "../../src/data/index.js";
import { createProject } from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

const automation = { kind: "automation", approvalId: null } as const;

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
    type: "persistent",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  return { db, project };
}

function createOwnedThread(
  db: ReturnType<typeof setup>["db"],
  projectId: string,
  input: Omit<Parameters<typeof createThread>[2], "projectId" | "providerId">,
) {
  return createThread(db, noopNotifier, {
    ...input,
    projectId,
    providerId: "codex",
  });
}

describe("thread creation provenance", () => {
  it("pins a visible manual thread only at creation", () => {
    const { db, project } = setup();
    const manual = createOwnedThread(db, project.id, {
      creationProvenance: "manual",
      title: "[GB] TODO",
    });
    expect(manual.creationProvenance).toBe("manual");
    expect(manual.pinnedAt).toEqual(expect.any(Number));
    expect(manual.pinSortKey).toEqual(expect.any(String));

    const unpinned = unpinThread(db, noopNotifier, { threadId: manual.id });
    expect(unpinned?.pinnedAt).toBeNull();
    expect(unpinned?.pinSortKey).toBeNull();
    const renamed = updateThread(db, noopNotifier, manual.id, {
      title: "renamed and done",
    });
    db.update(threads)
      .set({
        createdAt: 1,
        status: "idle",
      })
      .where(eq(threads.id, manual.id))
      .run();
    const stored = db.select().from(threads).where(eq(threads.id, manual.id)).get();
    expect(renamed?.title).toBe("renamed and done");
    expect(stored?.creationProvenance).toBe("manual");
    expect(stored?.pinnedAt).toBeNull();
    expect(stored?.status).toBe("idle");
    expect(stored?.createdAt).toBe(1);
    expect(() => archiveThread(db, noopNotifier, manual.id, automation)).toThrow(
      ThreadLifecycleProtectedError,
    );
    expect(
      db.select().from(threads).where(eq(threads.id, manual.id)).get()?.archivedAt,
    ).toBeNull();
  });

  it("leaves hidden manual threads unpinned and protected", () => {
    const { db, project } = setup();
    const hidden = createOwnedThread(db, project.id, {
      creationProvenance: "manual",
      visibility: "hidden",
    });
    expect(hidden.pinnedAt).toBeNull();
    expect(() =>
      markThreadDeleted(db, noopNotifier, {
        actor: automation,
        threadId: hidden.id,
      }),
    ).toThrow(ThreadLifecycleProtectedError);
  });

  it("protects unknown provenance and leaves proven bot pin policy alone", () => {
    const { db, project } = setup();
    const unknown = createOwnedThread(db, project.id, { title: "legacy" });
    const botTodo = createOwnedThread(db, project.id, {
      creationProvenance: "bot",
      title: "[GB] TODO",
    });
    const botDecision = createOwnedThread(db, project.id, {
      creationProvenance: "bot",
      title: "[DB] decision",
    });
    expect(unknown.creationProvenance).toBeNull();
    expect(unknown.pinnedAt).toBeNull();
    expect(botTodo.pinnedAt).toBeNull();
    expect(botDecision.pinnedAt).toBeNull();
    expect(pinThread(db, noopNotifier, { threadId: botDecision.id })?.pinnedAt).toEqual(
      expect.any(Number),
    );
    expect(unpinThread(db, noopNotifier, { threadId: botTodo.id })?.pinnedAt).toBeNull();
    expect(() => archiveThread(db, noopNotifier, unknown.id, automation)).toThrow(
      ThreadLifecycleProtectedError,
    );
    expect(archiveThread(db, noopNotifier, botTodo.id, automation)?.archivedAt).toEqual(
      expect.any(Number),
    );
    expect(
      archiveThread(db, noopNotifier, botDecision.id, automation)?.archivedAt,
    ).toEqual(expect.any(Number));
    expect(
      db.select().from(threads).where(eq(threads.id, botDecision.id)).get()
        ?.creationProvenance,
    ).toBe("bot");
  });

  it("still lets the owner archive and close a manual thread", () => {
    const { db, project } = setup();
    const archived = createOwnedThread(db, project.id, {
      creationProvenance: "manual",
    });
    const closed = createOwnedThread(db, project.id, {
      creationProvenance: "manual",
    });
    expect(
      archiveThread(db, noopNotifier, archived.id, ownerManualThreadLifecycleActor)
        ?.archivedAt,
    ).toEqual(expect.any(Number));
    expect(
      markThreadDeleted(db, noopNotifier, {
        actor: ownerManualThreadLifecycleActor,
        threadId: closed.id,
      })?.deletedAt,
    ).toEqual(expect.any(Number));
  });

  it("consumes an approval once for the exact thread and action", () => {
    const { db, project } = setup();
    const target = createOwnedThread(db, project.id, {
      creationProvenance: "manual",
    });
    const other = createOwnedThread(db, project.id, {
      creationProvenance: null,
    });
    const archiveApproval = issueThreadLifecycleApproval(db, {
      action: "archive",
      expiresAt: Date.now() + 60_000,
      source: { kind: "owner-card", ref: "card-archive" },
      threadId: target.id,
    });
    const closeApproval = issueThreadLifecycleApproval(db, {
      action: "close",
      expiresAt: Date.now() + 60_000,
      source: { kind: "owner-card", ref: "card-close" },
      threadId: target.id,
    });
    const expired = issueThreadLifecycleApproval(db, {
      action: "archive",
      expiresAt: Date.now() - 1,
      source: { kind: "owner-card", ref: "card-expired" },
      threadId: other.id,
    });

    expect(() =>
      archiveThread(db, noopNotifier, other.id, {
        kind: "automation",
        approvalId: archiveApproval.approvalId,
      }),
    ).toThrow(ThreadLifecycleProtectedError);
    expect(() =>
      markThreadDeleted(db, noopNotifier, {
        actor: { kind: "automation", approvalId: archiveApproval.approvalId },
        threadId: target.id,
      }),
    ).toThrow(ThreadLifecycleProtectedError);
    expect(() =>
      archiveThread(db, noopNotifier, other.id, {
        kind: "automation",
        approvalId: expired.approvalId,
      }),
    ).toThrow(ThreadLifecycleProtectedError);

    expect(
      archiveThread(db, noopNotifier, target.id, {
        kind: "automation",
        approvalId: archiveApproval.approvalId,
      })?.archivedAt,
    ).toEqual(expect.any(Number));
    expect(() =>
      archiveThread(db, noopNotifier, other.id, {
        kind: "automation",
        approvalId: archiveApproval.approvalId,
      }),
    ).toThrow(ThreadLifecycleProtectedError);
    const unarchived = db
      .update(threads)
      .set({ archivedAt: null })
      .where(eq(threads.id, target.id))
      .returning()
      .get();
    expect(unarchived?.archivedAt).toBeNull();
    expect(() =>
      archiveThread(db, noopNotifier, target.id, {
        kind: "automation",
        approvalId: archiveApproval.approvalId,
      }),
    ).toThrow(ThreadLifecycleProtectedError);
    expect(
      db.select().from(threads).where(eq(threads.id, target.id)).get()?.archivedAt,
    ).toBeNull();
    expect(
      markThreadDeleted(db, noopNotifier, {
        actor: { kind: "automation", approvalId: closeApproval.approvalId },
        threadId: target.id,
      })?.deletedAt,
    ).toEqual(expect.any(Number));

    const rows = db.select().from(threadLifecycleApprovals).all();
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(archiveApproval.approvalId)?.consumedAt).toEqual(
      expect.any(Number),
    );
    expect(byId.get(closeApproval.approvalId)?.consumedAt).toEqual(
      expect.any(Number),
    );
    expect(byId.get(expired.approvalId)?.consumedAt).toBeNull();
    expect(byId.get(archiveApproval.approvalId)?.sourceKind).toBe("owner-card");
  });

  it("keeps a pre-existing row null and does not backfill provenance", () => {
    const { db, project } = setup();
    const now = Date.now();
    db.$client
      .prepare(
        `INSERT INTO threads (
          id, project_id, provider_id, latest_attention_at, created_at, updated_at
        ) VALUES (?, ?, 'codex', ?, ?, ?)`,
      )
      .run("thr_legacy_row", project.id, now, now, now);
    const legacy = db
      .select()
      .from(threads)
      .where(eq(threads.id, "thr_legacy_row"))
      .get();
    expect(legacy?.creationProvenance).toBeNull();
    expect(() =>
      archiveThread(db, noopNotifier, "thr_legacy_row", automation),
    ).toThrow(ThreadLifecycleProtectedError);

    const columns = db.$client
      .prepare("PRAGMA table_info(threads)")
      .all() as Array<{ name: string; notnull: number }>;
    const column = columns.find((row) => row.name === "creation_provenance");
    expect(column).toMatchObject({ notnull: 0 });

    const drizzleDir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "drizzle",
    );
    const migrationSql = fs
      .readdirSync(drizzleDir)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => fs.readFileSync(resolve(drizzleDir, name), "utf8"))
      .filter((sql) => sql.includes("creation_provenance"));
    expect(migrationSql).toHaveLength(1);
    expect(migrationSql[0]).not.toMatch(
      /update\s+[`"]?threads[`"]?[\s\S]*creation_provenance/i,
    );
    const alter = migrationSql[0]
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .find((statement) => statement.startsWith("ALTER TABLE"));
    expect(alter).toBe("ALTER TABLE `threads` ADD `creation_provenance` text;");
    const legacyDb = new Database(":memory:");
    legacyDb.exec("CREATE TABLE threads (id text primary key, title text)");
    legacyDb
      .prepare("INSERT INTO threads (id, title) VALUES ('thr_old', 'kept')")
      .run();
    legacyDb.exec(alter ?? "");
    const migrated = legacyDb
      .prepare(
        "SELECT title, creation_provenance FROM threads WHERE id = 'thr_old'",
      )
      .get() as { creation_provenance: string | null; title: string };
    expect(migrated).toEqual({
      creation_provenance: null,
      title: "kept",
    });
    legacyDb.close();
  });
});
