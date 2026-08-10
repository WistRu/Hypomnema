import type { TagTreeResponse } from "@tabhub/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TopicPathInput } from "../src/TopicPathInput";

const topics: TagTreeResponse = {
  items: [
    {
      id: 6,
      name: "Без темы",
      path: "Без темы",
      color: "#64748b",
      tabCount: 4,
      children: [],
    },
    {
      id: 2,
      name: "Работа",
      path: "Работа",
      color: "#3b82f6",
      tabCount: 3,
      children: [
        {
          id: 5,
          name: "ИИ",
          path: "Работа/ИИ",
          color: "#8b5cf6",
          tabCount: 2,
          children: [],
        },
      ],
    },
  ],
};

describe("topic path input", () => {
  it("suggests existing assignable topics while keeping the path editable", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["tags"], topics);

    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <TopicPathInput value="Раб" onChange={vi.fn()} />
      </QueryClientProvider>,
    );

    expect(markup).toContain('value="Раб"');
    expect(markup).toContain('<option value="Работа"></option>');
    expect(markup).toContain('<option value="Работа/ИИ"></option>');
    expect(markup).not.toContain('<option value="Без темы"></option>');
  });
});
