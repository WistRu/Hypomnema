import type { TagTreeNode } from "@tabhub/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../src/i18n";
import {
  flattenTopics,
  TopicTree,
  topicAndDescendantIds,
} from "../src/TopicSidebar";

const tree: TagTreeNode[] = [
  {
    id: 1,
    name: "Work",
    path: "Work",
    color: "#687eff",
    tabCount: 7,
    children: [
      {
        id: 2,
        name: "Crypto",
        path: "Work/Crypto",
        color: null,
        tabCount: 4,
        children: [
          {
            id: 3,
            name: "Research",
            path: "Work/Crypto/Research",
            color: "#46c9a3",
            tabCount: 2,
            children: [],
          },
        ],
      },
    ],
  },
];

describe("topic tree presentation", () => {
  it("flattens arbitrary depth with stable parent and path metadata", () => {
    const flattened = flattenTopics(tree);

    expect(flattened.map(({ id, parentId, path, depth }) => ({
      id,
      parentId,
      path,
      depth,
    }))).toEqual([
      { id: 1, parentId: null, path: "Work", depth: 0 },
      { id: 2, parentId: 1, path: "Work/Crypto", depth: 1 },
      { id: 3, parentId: 2, path: "Work/Crypto/Research", depth: 2 },
    ]);
    expect([...topicAndDescendantIds(flattened[0]!)].sort()).toEqual([1, 2, 3]);
    expect([...topicAndDescendantIds(flattened[1]!)].sort()).toEqual([2, 3]);
  });

  it("renders every level, selected state, color, and safe leaf deletion", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <TopicTree
          nodes={tree}
          selectedTopic={{ id: 2, path: "Work/Crypto" }}
          onAddChild={vi.fn()}
          onDelete={vi.fn()}
          onEdit={vi.fn()}
          onSelect={vi.fn()}
        />
      </I18nProvider>,
    );

    expect(markup).toContain("Work/Crypto/Research");
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain("--topic-color:#687eff");
    expect(markup).toContain('aria-label="Add subtopic to Work/Crypto"');
    expect(markup).toContain('aria-label="Edit topic Work/Crypto"');
    expect(markup).toMatch(/aria-label="Delete topic Work"[^>]*disabled/);
    expect(markup).toMatch(/aria-label="Delete topic Work\/Crypto\/Research"(?![^>]*disabled)/);
  });
});
