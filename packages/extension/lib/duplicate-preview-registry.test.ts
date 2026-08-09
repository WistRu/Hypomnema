import { describe, expect, it } from "vitest";

import { createDuplicatePreviewRegistry } from "./duplicate-preview-registry";
import type { DuplicateClosePlan } from "./duplicate-tabs";

function plan(targetTabId: number): DuplicateClosePlan {
  return {
    groups: [
      {
        exactUrl: "https://example.com/exact",
        keeperTabId: 41,
        protectedCount: 0,
        targetTabIds: [targetTabId],
      },
    ],
  };
}

function memoryStorage() {
  const values = new Map<string, unknown>();

  return {
    async get(key: string) {
      return { [key]: values.get(key) };
    },
    async remove(key: string) {
      values.delete(key);
    },
    async set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) values.set(key, value);
    },
  };
}

describe("duplicate preview registry", () => {
  it("returns the exact background-held plan once and invalidates an older preview", async () => {
    const ids = [
      "123e4567-e89b-42d3-a456-426614174001",
      "123e4567-e89b-42d3-a456-426614174002",
    ];
    const registry = createDuplicatePreviewRegistry(memoryStorage(), {
      createId: () => ids.shift()!,
      now: () => 1_000,
    });
    const scope = {
      browser: "chrome",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
    };
    const firstId = await registry.issue(scope, plan(42));
    const secondPlan = plan(43);
    const secondId = await registry.issue(scope, secondPlan);

    await expect(registry.consume(scope, firstId)).rejects.toThrow(
      "no longer current",
    );
    await expect(registry.consume(scope, secondId)).resolves.toEqual(secondPlan);
    await expect(registry.consume(scope, secondId)).rejects.toThrow(
      "no longer available",
    );
  });

  it("rejects and consumes a preview when the configured browser identity changed", async () => {
    const registry = createDuplicatePreviewRegistry(memoryStorage(), {
      createId: () => "123e4567-e89b-42d3-a456-426614174003",
      now: () => 1_000,
    });
    const chromeScope = {
      browser: "chrome",
      installationId: "123e4567-e89b-42d3-a456-426614174000",
    };
    const previewId = await registry.issue(chromeScope, plan(42));

    await expect(
      registry.consume({ ...chromeScope, browser: "edge" }, previewId),
    ).rejects.toThrow("browser identity changed");
    await expect(registry.consume(chromeScope, previewId)).rejects.toThrow(
      "no longer available",
    );
  });
});
