import { Children, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/i18n", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/i18n")>();
  return {
    ...original,
    useI18n: () => ({
      t: (key: string) => original.translate("en", key),
    }),
  };
});

import { ActionReceipt } from "../src/ActionReceipt";

describe("ActionReceipt", () => {
  it("dismisses the report with OK without invoking its Undo action", () => {
    const onDismiss = vi.fn();
    const onUndo = vi.fn();
    const receipt = ActionReceipt({
      children: (
        <>
          <span>2 tabs closed</span>
          <button type="button" onClick={onUndo}>Undo</button>
        </>
      ),
      className: "bulk-receipt",
      onDismiss,
    });
    const buttons = Children.toArray(receipt.props.children).filter(
      (child): child is ReactElement<{ children: string; onClick: () => void }> =>
        isValidElement(child) && child.type === "button",
    );
    const okButton = buttons.find((button) => button.props.children === "OK");

    expect(renderToStaticMarkup(receipt)).toContain("bulk-receipt");
    expect(okButton).toBeDefined();
    okButton?.props.onClick();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onUndo).not.toHaveBeenCalled();
  });
});
