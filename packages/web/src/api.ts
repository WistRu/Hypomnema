import {
  assignTagsResponseSchema,
  deleteResponseSchema,
  linkListResponseSchema,
  setStatusResponseSchema,
  summaryEnqueueResponseSchema,
  summaryJobSchema,
  tabDetailResponseSchema,
  tabLinkSchema,
  tabListResponseSchema,
  tagTreeResponseSchema,
  type CreateLink,
  type PatchLink,
  type PatchTab,
  type TabImportance,
  type TabStatus,
} from "@tabhub/shared";

export type OpenFilter = "all" | "open" | "closed";

export interface TabListFilters {
  browser: string;
  importance: "all" | TabImportance;
  openState: OpenFilter;
  page: number;
  q: string;
  status: "all" | TabStatus;
  tag: string;
}

export type PatchTabDetails = PatchTab;
export type CreateTabLink = CreateLink;
export type PatchTabLink = PatchLink;

async function responsePayload(response: Response, unreadableMessage: string) {
  if (response.status === 204) return null;

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

async function requestJson(
  input: RequestInfo | URL,
  init: RequestInit,
  errorMessage: string,
  unreadableMessage: string,
) {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw await responseError(response, `${errorMessage} (${response.status}).`);
  }

  return responsePayload(response, unreadableMessage);
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

  if (filters.status !== "all") {
    searchParams.set("status", filters.status);
  }

  if (filters.importance !== "all") {
    searchParams.set("importance", String(filters.importance));
  }

  if (filters.q) {
    searchParams.set("q", filters.q);
  }

  if (filters.tag) {
    searchParams.set("tag", filters.tag);
  }

  const payload = await requestJson(
    `/api/tabs?${searchParams.toString()}`,
    {
      headers: { Accept: "application/json" },
      signal: signal ?? null,
    },
    "TabHub could not load tabs",
    "TabHub returned an unreadable tab list.",
  );
  const parsed = tabListResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected tab list.");
  }

  return parsed.data;
}

export async function fetchTagTree(signal?: AbortSignal) {
  const payload = await requestJson(
    "/api/tags",
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load tags",
    "TabHub returned an unreadable tag tree.",
  );
  const parsed = tagTreeResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected tag tree.");
  }

  return parsed.data;
}

export async function fetchTabDetail(tabId: number, signal?: AbortSignal) {
  const payload = await requestJson(
    `/api/tabs/${tabId}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load this tab",
    "TabHub returned unreadable tab details.",
  );
  const parsed = tabDetailResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned unexpected tab details.");
  }

  return parsed.data;
}

export async function patchTabDetails(tabId: number, patch: PatchTabDetails) {
  const payload = await requestJson(
    `/api/tabs/${tabId}`,
    {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(patch),
    },
    "TabHub could not update this tab",
    "TabHub returned an unreadable tab update.",
  );
  const parsed = tabDetailResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected tab update.");
  }

  return parsed.data;
}

export async function updateTabStatuses(ids: number[], status: TabStatus) {
  const payload = await requestJson(
    "/api/tabs/status",
    {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ids, status }),
    },
    "TabHub could not update the selected tabs",
    "TabHub returned an unreadable bulk update.",
  );
  const parsed = setStatusResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected bulk update.");
  }

  return parsed.data;
}

export async function assignTag(ids: number[], tagPath: string) {
  const payload = await requestJson(
    "/api/tags/assign",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ids, tagPath, assignedBy: "user" }),
    },
    "TabHub could not assign this tag",
    "TabHub returned an unreadable tag update.",
  );
  const parsed = assignTagsResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected tag update.");
  }

  return parsed.data;
}

export async function unassignTag(tabId: number, tagId: number) {
  const payload = await requestJson(
    `/api/tabs/${tabId}/tags/${tagId}`,
    { method: "DELETE", headers: { Accept: "application/json" } },
    "TabHub could not remove this tag",
    "TabHub returned an unreadable tag removal.",
  );
  const parsed = deleteResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected tag removal.");
  }

  return parsed.data;
}

export async function fetchLinks(tabId: number, signal?: AbortSignal) {
  const searchParams = new URLSearchParams({ tab_id: String(tabId) });
  const payload = await requestJson(
    `/api/links?${searchParams.toString()}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load links",
    "TabHub returned unreadable links.",
  );
  const parsed = linkListResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned unexpected links.");
  }

  return parsed.data;
}

export async function createLink(link: CreateTabLink) {
  const payload = await requestJson(
    "/api/links",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(link),
    },
    "TabHub could not create this link",
    "TabHub returned an unreadable link.",
  );
  const parsed = tabLinkSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected link.");
  }

  return parsed.data;
}

export async function patchLink(linkId: number, patch: PatchTabLink) {
  const payload = await requestJson(
    `/api/links/${linkId}`,
    {
      method: "PATCH",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(patch),
    },
    "TabHub could not update this link",
    "TabHub returned an unreadable link update.",
  );
  const parsed = tabLinkSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected link update.");
  }

  return parsed.data;
}

export async function deleteLink(linkId: number) {
  const payload = await requestJson(
    `/api/links/${linkId}`,
    { method: "DELETE", headers: { Accept: "application/json" } },
    "TabHub could not delete this link",
    "TabHub returned an unreadable link deletion.",
  );
  const parsed = deleteResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected link deletion.");
  }

  return parsed.data;
}

export async function enqueueShortSummary(tabId: number) {
  const payload = await requestJson(
    `/api/tabs/${tabId}/summarize`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ depth: "short" }),
    },
    "TabHub could not queue this summary",
    "TabHub returned an unreadable summary response.",
  );
  const parsed = summaryEnqueueResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected summary response.");
  }

  return parsed.data;
}

export async function fetchSummaryJob(jobId: number, signal?: AbortSignal) {
  const payload = await requestJson(
    `/api/jobs/${jobId}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not read this summary job",
    "TabHub returned an unreadable summary job.",
  );
  const parsed = summaryJobSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected summary job.");
  }

  return parsed.data;
}
