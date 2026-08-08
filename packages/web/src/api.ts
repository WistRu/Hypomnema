import { tabListResponseSchema } from "@tabhub/shared";

export type OpenFilter = "all" | "open" | "closed";

export interface TabListFilters {
  browser: string;
  openState: OpenFilter;
  page: number;
  q: string;
}

export async function fetchTabs(
  filters: TabListFilters,
  signal?: AbortSignal,
) {
  const searchParams = new URLSearchParams({
    page: String(filters.page),
    pageSize: "50",
  });

  if (filters.browser !== "all") {
    searchParams.set("browser", filters.browser);
  }

  if (filters.openState !== "all") {
    searchParams.set("is_open", String(filters.openState === "open"));
  }

  if (filters.q) {
    searchParams.set("q", filters.q);
  }

  const response = await fetch(`/api/tabs?${searchParams.toString()}`, {
    headers: { Accept: "application/json" },
    signal: signal ?? null,
  });

  if (!response.ok) {
    throw new Error(`TabHub API returned ${response.status}.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("TabHub API returned an unreadable response.");
  }

  const parsed = tabListResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub API returned an unexpected response.");
  }

  return parsed.data;
}
