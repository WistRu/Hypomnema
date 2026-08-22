import { describe, expect, it } from "vitest";
import { personalAttentionFeatureFlagsOff,
  resolvePersonalAttentionFeatureFlags } from "../src/attention-feature-flags.js";

describe("privacy purge feature flag", () => {
  it("is independently fail-closed and reads its dedicated environment key", () => {
    expect(personalAttentionFeatureFlagsOff.privacyPurge).toBe(false);
    expect(resolvePersonalAttentionFeatureFlags({ TABHUB_FEATURE_PRIVACY_PURGE: "true" })
      .privacyPurge).toBe(true);
    expect(resolvePersonalAttentionFeatureFlags({ TABHUB_FEATURE_PRIVACY_PURGE: "false",
      TABHUB_FEATURE_LIVE_ACQUISITION: "true" }).privacyPurge).toBe(false);
  });
});

