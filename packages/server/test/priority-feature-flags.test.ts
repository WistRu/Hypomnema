import { describe, expect, it } from "vitest";

import {
  personalAttentionFeatureFlagsOff,
  resolveAgentUserImportanceFeature,
  resolveEffectivePriorityFeatureFlags,
  resolvePersonalAttentionFeatureFlags,
} from "../src/attention-feature-flags.js";

describe("priority feature flags", () => {
  it("parses priority flags independently and keeps personalization default-off", () => {
    expect(resolvePersonalAttentionFeatureFlags({})).toEqual(
      personalAttentionFeatureFlagsOff,
    );
    expect(resolvePersonalAttentionFeatureFlags({
      TABHUB_FEATURE_PRIORITY_ASSESSMENT_WRITER: "true",
      TABHUB_FEATURE_PRIORITY_PERSONALIZATION: "1",
      TABHUB_FEATURE_PRIORITY_READERS: "1",
      TABHUB_FEATURE_PRIORITY_SHADOW: "true",
    })).toMatchObject({
      priorityAssessmentWriter: true,
      priorityPersonalization: true,
      priorityReaders: true,
      priorityShadow: true,
    });
    for (const name of [
      "TABHUB_FEATURE_PRIORITY_ASSESSMENT_WRITER",
      "TABHUB_FEATURE_PRIORITY_PERSONALIZATION",
      "TABHUB_FEATURE_PRIORITY_READERS",
      "TABHUB_FEATURE_PRIORITY_SHADOW",
    ]) {
      expect(() => resolvePersonalAttentionFeatureFlags({ [name]: "enabled" }))
        .toThrow(`${name} must be one of`);
    }
  });

  it("lets the writer stage alone only at schema 23 while readers start at 22", () => {
    const flags = {
      ...personalAttentionFeatureFlagsOff,
      priorityAssessmentWriter: true,
      priorityReaders: true,
      priorityShadow: true,
    };
    expect(resolveEffectivePriorityFeatureFlags(flags, 21)).toEqual({
      priorityAssessmentWriter: false,
      priorityPersonalization: false,
      priorityReaders: false,
      priorityShadow: false,
    });
    expect(resolveEffectivePriorityFeatureFlags({
      ...flags,
      priorityReaders: false,
      priorityShadow: false,
    }, 22)).toEqual({
      priorityAssessmentWriter: false,
      priorityPersonalization: false,
      priorityReaders: false,
      priorityShadow: false,
    });
    expect(resolveEffectivePriorityFeatureFlags({
      ...flags,
      priorityReaders: false,
    }, 22)).toEqual({
      priorityAssessmentWriter: false,
      priorityPersonalization: false,
      priorityReaders: false,
      priorityShadow: false,
    });
    expect(resolveEffectivePriorityFeatureFlags(flags, 22)).toEqual({
      priorityAssessmentWriter: false,
      priorityPersonalization: false,
      priorityReaders: true,
      priorityShadow: true,
    });
    expect(resolveEffectivePriorityFeatureFlags(flags, 23)).toEqual({
      priorityAssessmentWriter: true,
      priorityPersonalization: false,
      priorityReaders: true,
      priorityShadow: true,
    });

    expect(resolveEffectivePriorityFeatureFlags({
      ...flags,
      priorityPersonalization: true,
    }, 23)).toEqual({
      priorityAssessmentWriter: true,
      priorityPersonalization: true,
      priorityReaders: true,
      priorityShadow: true,
    });
    expect(resolveEffectivePriorityFeatureFlags({
      ...flags,
      priorityAssessmentWriter: false,
      priorityPersonalization: true,
    }, 23)).toEqual({
      priorityAssessmentWriter: false,
      priorityPersonalization: true,
      priorityReaders: true,
      priorityShadow: true,
    });
    expect(resolveEffectivePriorityFeatureFlags({
      ...flags,
      priorityPersonalization: true,
      priorityReaders: false,
    }, 23).priorityPersonalization).toBe(false);
  });

  it("discovers unified agent importance only from schema 23 page or resource support", () => {
    const priorityOn = {
      ...personalAttentionFeatureFlagsOff,
      priorityAssessmentWriter: true,
      priorityReaders: true,
      priorityShadow: true,
    };

    expect(resolveAgentUserImportanceFeature({
      ...priorityOn,
      logicalImportance: true,
      resources: true,
    }, 22)).toBe(false);
    expect(resolveAgentUserImportanceFeature(priorityOn, 23)).toBe(false);
    expect(resolveAgentUserImportanceFeature({
      ...personalAttentionFeatureFlagsOff,
      logicalImportance: true,
    }, 23)).toBe(true);
    expect(resolveAgentUserImportanceFeature({
      ...personalAttentionFeatureFlagsOff,
      resources: true,
    }, 23)).toBe(true);
    expect(resolveAgentUserImportanceFeature({
      ...priorityOn,
      logicalImportance: true,
    }, 23)).toBe(true);
  });
});
