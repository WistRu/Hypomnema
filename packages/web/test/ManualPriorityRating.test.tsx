// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualPriorityRating } from "../src/ManualPriorityRating";

afterEach(cleanup);

describe("ManualPriorityRating", () => {
  it("keeps Clear distinct from explicit 1 and reports the requested nullable value", () => {
    const onChange = vi.fn();
    render(<ManualPriorityRating
      labels={{ group: "My importance", clear: "Clear", level: (value) => `Set ${value}` }}
      value={1}
      onChange={onChange}
    />);

    expect(screen.getByRole("button", { name: "Set 1" }).getAttribute("aria-pressed"))
      .toBe("true");
    expect(screen.getByRole("button", { name: "Clear" }).getAttribute("aria-pressed"))
      .toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange).toHaveBeenCalledWith(null);
  });
});
