import { describe, expect, it } from "vitest";
import {
  creationProvenanceForCreateOrigin,
  decideThreadLifecycle,
  ownerManualThreadLifecycleActor,
} from "../src/thread-origin-lifecycle.js";

describe("creation provenance", () => {
  it("maps app creates to manual and cli or plugin creates to bot", () => {
    expect(creationProvenanceForCreateOrigin("app")).toBe("manual");
    expect(creationProvenanceForCreateOrigin("cli")).toBe("bot");
    expect(creationProvenanceForCreateOrigin("plugin")).toBe("bot");
    expect(creationProvenanceForCreateOrigin("sdk")).toBeNull();
    expect(creationProvenanceForCreateOrigin(null)).toBeNull();
  });
});

describe("decideThreadLifecycle", () => {
  it("allows the owner and proven bot threads without an approval", () => {
    expect(
      decideThreadLifecycle({
        action: "archive",
        actor: ownerManualThreadLifecycleActor,
        creationProvenance: "manual",
      }),
    ).toEqual({ allow: true, consumeApprovalId: null, reason: null });
    expect(
      decideThreadLifecycle({
        action: "close",
        actor: { kind: "automation", approvalId: null },
        creationProvenance: "bot",
      }),
    ).toEqual({ allow: true, consumeApprovalId: null, reason: null });
  });

  it("protects manual and unknown threads unless an approval id is present", () => {
    for (const creationProvenance of ["manual", null] as const) {
      expect(
        decideThreadLifecycle({
          action: "archive",
          actor: { kind: "automation", approvalId: null },
          creationProvenance,
        }),
      ).toEqual({
        allow: false,
        consumeApprovalId: null,
        reason: "automatic-lifecycle-denied",
      });
    }
    expect(
      decideThreadLifecycle({
        action: "close",
        actor: { kind: "automation", approvalId: "tlap_one" },
        creationProvenance: null,
      }),
    ).toEqual({
      allow: true,
      consumeApprovalId: "tlap_one",
      reason: null,
    });
  });
});
