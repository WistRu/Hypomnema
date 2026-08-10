import { Children, isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

import { TabBrowserAction } from "../src/TabBrowserAction";

function actionButton(props: Parameters<typeof TabBrowserAction>[0]): ReactElement {
  const rendered = TabBrowserAction(props);
  const button = Children.toArray(rendered.props.children)[0];
  if (!isValidElement(button)) throw new Error("Action button was not rendered");
  return button;
}

describe("TabBrowserAction middle click", () => {
  it("closes an open canonical tab without running its activation action", () => {
    const onBrowserAction = vi.fn();
    const onMiddleClose = vi.fn();
    const button = actionButton({
      tab: {
        id: 17,
        isOpen: true,
        title: "Existing tab",
        url: "https://example.com/existing",
      },
      onBrowserAction,
      onMiddleClose,
    });
    const event = {
      button: 1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    button.props.onAuxClick(event);

    expect(onMiddleClose).toHaveBeenCalledWith(17);
    expect(onBrowserAction).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it("does not close or open a confirmed-closed record on middle click", () => {
    const onBrowserAction = vi.fn();
    const onMiddleClose = vi.fn();
    const button = actionButton({
      tab: {
        id: 18,
        isOpen: false,
        title: "Closed record",
        url: "https://example.com/closed",
      },
      onBrowserAction,
      onMiddleClose,
    });

    button.props.onAuxClick({
      button: 1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });

    expect(onMiddleClose).not.toHaveBeenCalled();
    expect(onBrowserAction).not.toHaveBeenCalled();
  });
});
