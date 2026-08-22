// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LibraryPriorityControls } from "../src/LibraryPriorityControls";

afterEach(cleanup);

describe("LibraryPriorityControls", () => {
  it("exposes accessible Default/My/AI/Recommended and independent review filters", () => {
    const onChange = vi.fn();
    render(<LibraryPriorityControls
      labels={{
        mode: "Priority order", review: "Review state", default: "Default", my: "My",
        ai: "AI", recommended: "Recommended", all: "All",
        needsReview: "Needs review", doesNotNeedReview: "Does not need review",
      }}
      selection={{ mode: "default", review: "all" }}
      onChange={onChange}
    />);

    expect(screen.getByRole("radio", { name: "Default" }).getAttribute("checked"))
      .not.toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Recommended" }));
    expect(onChange).toHaveBeenCalledWith({ mode: "recommended", review: "all" });
    fireEvent.click(screen.getByRole("radio", { name: "Needs review" }));
    expect(onChange).toHaveBeenCalledWith({ mode: "default", review: "needs_review" });
  });

  it("is inert while capability is unavailable", () => {
    render(<LibraryPriorityControls
      disabled
      labels={{ mode: "Priority order", review: "Review state", default: "Default", my: "My",
        ai: "AI", recommended: "Recommended", all: "All",
        needsReview: "Needs review", doesNotNeedReview: "Does not need review" }}
      selection={{ mode: "default", review: "all" }}
      onChange={vi.fn()}
    />);
    expect(screen.getAllByRole("radio").every((control) => control.hasAttribute("disabled")))
      .toBe(true);
  });
});
