import type { GraphNode } from "@tabhub/shared";
import { Children, isValidElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { GraphNodeCard } from "../src/GraphView";

const node: GraphNode = {
  browser: "edge",
  id: 42,
  importance: 2,
  isOpen: true,
  status: "inbox",
  title: "Graph tab",
  url: "https://example.com/graph",
};

describe("GraphNodeCard middle click", () => {
  it("closes an open graph tab and ignores a closed record", () => {
    const onMiddleClose = vi.fn();
    const openCard = GraphNodeCard({
      browser: "Edge",
      closingLabel: "Closing...",
      groupKey: "Topic",
      node,
      onMiddleClose,
      openLabel: "open",
      statusLabel: "inbox",
    });
    const event = {
      button: 1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    openCard.props.onAuxClick(event);
    expect(onMiddleClose).toHaveBeenCalledWith(42);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();

    const closedCard = GraphNodeCard({
      browser: "Edge",
      closingLabel: "Closing...",
      groupKey: "Topic",
      node: { ...node, id: 43, isOpen: false },
      onMiddleClose,
      openLabel: "closed",
      statusLabel: "inbox",
    });
    closedCard.props.onAuxClick({
      button: 1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    expect(onMiddleClose).toHaveBeenCalledOnce();
  });

  it("shows close progress and a localized error on the exact graph node", () => {
    const closingCard = GraphNodeCard({
      browser: "Edge",
      closeInProgress: true,
      closingLabel: "Closing...",
      groupKey: "Topic",
      node,
      onMiddleClose: vi.fn(),
      openLabel: "open",
      statusLabel: "inbox",
    });
    const closingChildren = Children.toArray(closingCard.props.children);
    const meta = closingChildren[1];

    expect(isValidElement(meta)).toBe(true);
    if (!isValidElement(meta)) return;

    const metaItems = Children.toArray(
      (meta.props as { children?: unknown }).children,
    );
    const closeState = metaItems[2];
    expect(isValidElement(closeState)).toBe(true);
    if (!isValidElement(closeState)) return;

    expect((closeState.props as { children?: unknown }).children).toBe(
      "Closing...",
    );

    const failedCard = GraphNodeCard({
      browser: "Edge",
      closeError: "This exact tab could not be closed.",
      closingLabel: "Closing...",
      groupKey: "Topic",
      node,
      onMiddleClose: vi.fn(),
      openLabel: "open",
      statusLabel: "inbox",
    });
    const feedback = Children.toArray(failedCard.props.children)[2];
    expect(isValidElement(feedback)).toBe(true);
    if (!isValidElement(feedback)) return;

    expect((feedback.props as { role?: string }).role).toBe("alert");
    expect((feedback.props as { children?: unknown }).children).toBe(
      "This exact tab could not be closed.",
    );
  });
});
