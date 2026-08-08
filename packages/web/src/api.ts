import {
  summaryEnqueueResponseSchema,
  summaryJobSchema,
  tabListResponseSchema,
} from "@tabhub/shared";

export type OpenFilter = "all" | "open" | "closed";

export interface TabListFilters {
  browser: string;
  openState: OpenFilter;
  page: number;
  q: string;
}

async function responsePayload(response: Response, unreadableMessage: string) {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error(unreadableMessage);
  }
}

async function responseError(response: Response, fallbackMessage: string) {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return new Error(fallbackMessage);
  }

  if (
    typeof payload === "object" &&
    payload !== null &&
    "message" in payload &&
    typeof payload.message === "string"
  ) {
    return new Error(payload.message);
  }

  return new Error(fallbackMessage);
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

export async function enqueueShortSummary(tabId: number) {
  const response = await fetch(`/api/tabs/${tabId}/summarize`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ depth: "short" }),
  });

  if (!response.ok) {
    throw await responseError(
      response,
      `TabHub could not queue this summary (${response.status}).`,
    );
  }

  const payload = await responsePayload(
    response,
    "TabHub returned an unreadable summary response.",
  );
  const parsed = summaryEnqueueResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected summary response.");
  }

  return parsed.data;
}

export async function fetchSummaryJob(jobId: number, signal?: AbortSignal) {
  const response = await fetch(`/api/jobs/${jobId}`, {
    headers: { Accept: "application/json" },
    signal: signal ?? null,
  });

  if (!response.ok) {
    throw await responseError(
      response,
      `TabHub could not read this summary job (${response.status}).`,
    );
  }

  const payload = await responsePayload(
    response,
    "TabHub returned an unreadable summary job.",
  );
  const parsed = summaryJobSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected summary job.");
  }

  return parsed.data;
}
