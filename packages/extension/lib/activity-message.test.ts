import { describe, expect, it } from "vitest";

import {
  activityContentScriptPing,
  activityContentScriptPong,
  isActivityContentScriptPing,
  isActivityContentScriptPong,
  parseActivitySignal,
} from "./activity-message";

describe("activity content-script messages", () => {
  it("accepts only a strict heartbeat or trusted-interaction signal", () => {
    expect(
      parseActivitySignal({
        type: "tabhub:activity-signal",
        kind: "interaction",
      }),
    ).toEqual({
      type: "tabhub:activity-signal",
      kind: "interaction",
    });
    expect(
      parseActivitySignal({
        type: "tabhub:activity-signal",
        kind: "interaction",
        key: "secret text",
      }),
    ).toBeUndefined();

    expect(
      parseActivitySignal({
        type: "tabhub:activity-signal",
        kind: "heartbeat",
        url: "https://example.com/article",
      }),
    ).toEqual({
      type: "tabhub:activity-signal",
      kind: "heartbeat",
      url: "https://example.com/article",
    });
    expect(
      parseActivitySignal({
        type: "tabhub:activity-signal",
        kind: "heartbeat",
      }),
    ).toBeUndefined();
  });

  it("recognizes only strict content-script ping envelopes", () => {
    expect(isActivityContentScriptPing(activityContentScriptPing)).toBe(true);
    expect(isActivityContentScriptPong(activityContentScriptPong)).toBe(true);
    expect(
      isActivityContentScriptPing({ ...activityContentScriptPing, extra: true }),
    ).toBe(false);
  });
});
