import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import {
  personalAttentionFeatureFlagsOff,
  resolveEffectiveResearchFeature,
  resolvePersonalAttentionFeatureFlags,
} from "../src/attention-feature-flags.js";

describe("research feature flag", () => {
  it("keeps live acquisition independently default-off", () => {
    expect(personalAttentionFeatureFlagsOff.liveAcquisition).toBe(false);
    expect(resolvePersonalAttentionFeatureFlags({}).liveAcquisition).toBe(false);
    expect(resolvePersonalAttentionFeatureFlags({
      TABHUB_FEATURE_LIVE_ACQUISITION: "true",
    })).toMatchObject({ research: false, liveAcquisition: true });
    expect(() => resolvePersonalAttentionFeatureFlags({
      TABHUB_FEATURE_LIVE_ACQUISITION: "enabled",
    })).toThrow("TABHUB_FEATURE_LIVE_ACQUISITION must be one of");
  });

  it("does not advertise live acquisition when its writer dependencies are unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-live-feature-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
      featureFlags: {
        ...personalAttentionFeatureFlagsOff,
        liveAcquisition: true,
      },
    });
    try {
      expect((await app.inject({ method: "GET", url: "/api/features" })).json())
        .toMatchObject({ research: false, liveAcquisition: false });
      expect((await app.inject({ method: "GET", url: "/api/live-acquisition" })).statusCode)
        .toBe(404);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("is default-off and accepts only explicit boolean spellings", () => {
    expect(personalAttentionFeatureFlagsOff.research).toBe(false);
    expect(resolvePersonalAttentionFeatureFlags({}).research).toBe(false);
    expect(resolvePersonalAttentionFeatureFlags({
      TABHUB_FEATURE_RESEARCH: "true",
    }).research).toBe(true);
    expect(resolvePersonalAttentionFeatureFlags({
      TABHUB_FEATURE_RESEARCH: "1",
    }).research).toBe(true);
    expect(() => resolvePersonalAttentionFeatureFlags({
      TABHUB_FEATURE_RESEARCH: "enabled",
    })).toThrow("TABHUB_FEATURE_RESEARCH must be one of");
  });

  it("enables research writers only on schema 24 or newer", () => {
    const enabled = { ...personalAttentionFeatureFlagsOff, research: true };
    expect(resolveEffectiveResearchFeature(enabled, 23)).toBe(false);
    expect(resolveEffectiveResearchFeature(enabled, 24)).toBe(true);
    expect(resolveEffectiveResearchFeature(enabled, 25)).toBe(true);
    expect(resolveEffectiveResearchFeature(personalAttentionFeatureFlagsOff, 24))
      .toBe(false);
    expect(resolveEffectiveResearchFeature(enabled, Number.NaN)).toBe(false);
  });
});
