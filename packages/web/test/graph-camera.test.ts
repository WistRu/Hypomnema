import { describe, expect, it } from "vitest";

import { InitialGraphAutoFit } from "../src/graph-camera";

describe("3D graph camera", () => {
  it("allows the initial automatic fit only once", () => {
    const autoFit = new InitialGraphAutoFit();

    expect(autoFit.consume()).toBe(true);
    expect(autoFit.consume()).toBe(false);
    expect(autoFit.consume()).toBe(false);
  });

  it("cancels the pending automatic fit after user navigation", () => {
    const autoFit = new InitialGraphAutoFit();

    autoFit.cancel();

    expect(autoFit.consume()).toBe(false);
  });
});
