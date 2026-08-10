import type { TagTreeNode } from "@tabhub/shared";
import { useQuery } from "@tanstack/react-query";
import { useId, useMemo } from "react";

import { fetchTagTree } from "./api";
import { defaultTopicPath } from "./system-topics";

interface TopicPathInputProps {
  disabled?: boolean;
  placeholder?: string;
  required?: boolean;
  value: string;
  onChange: (value: string) => void;
}

function topicPaths(nodes: TagTreeNode[]): string[] {
  return nodes.flatMap((node) => [node.path, ...topicPaths(node.children)]);
}

export function TopicPathInput({
  disabled = false,
  placeholder,
  required = false,
  value,
  onChange,
}: TopicPathInputProps) {
  const suggestionsId = useId();
  const topicsQuery = useQuery({
    queryKey: ["tags"],
    queryFn: ({ signal }) => fetchTagTree(signal),
  });
  const suggestions = useMemo(
    () =>
      topicPaths(topicsQuery.data?.items ?? []).filter(
        (path) => path !== defaultTopicPath,
      ),
    [topicsQuery.data?.items],
  );

  return (
    <>
      <input
        disabled={disabled}
        list={suggestionsId}
        maxLength={2_048}
        placeholder={placeholder}
        required={required}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={suggestionsId}>
        {suggestions.map((path) => (
          <option key={path} value={path} />
        ))}
      </datalist>
    </>
  );
}
