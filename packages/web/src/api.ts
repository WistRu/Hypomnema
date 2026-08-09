import {
  assignTagsResponseSchema,
  deleteResponseSchema,
  duplicateGroupListResponseSchema,
  graphResponseSchema,
  linkListResponseSchema,
  setStatusResponseSchema,
  summaryEnqueueResponseSchema,
  summaryJobSchema,
  tabBulkIdsResponseSchema,
  tabDetailResponseSchema,
  tabInstanceBulkResponseSchema,
  tabInstanceListResponseSchema,
  tabLinkSchema,
  tabListResponseSchema,
  tagTreeResponseSchema,
  workspaceDetailSchema,
  workspaceListResponseSchema,
  type CreateWorkspace,
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

export type LibraryTabFilters = Omit<TabListFilters, "page">;

export interface OpenTabListFilters {
  browser: string;
  duplicatesOnly: boolean;
  page: number;
  pageSize?: number;
  q: string;
}

export interface DuplicateGroupListFilters {
  browser: string;
  page: number;
}

export type PatchTabDetails = PatchTab;
export type CreateTabLink = CreateLink;
export type PatchTabLink = PatchLink;

function appendLibraryTabFilters(
  searchParams: URLSearchParams,
  filters: LibraryTabFilters,
): void {
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
}

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
  appendLibraryTabFilters(searchParams, filters);

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

export async function fetchAllLibraryTabIds(
  filters: LibraryTabFilters,
  signal?: AbortSignal,
) {
  const searchParams = new URLSearchParams();
  appendLibraryTabFilters(searchParams, filters);
  const query = searchParams.toString();
  const payload = await requestJson(
    `/api/tabs/bulk-ids${query ? `?${query}` : ""}`,
    {
      headers: { Accept: "application/json" },
      signal: signal ?? null,
    },
    "TabHub could not load all filtered Library tabs",
    "TabHub returned an unreadable Library tab selection.",
  );
  const parsed = tabBulkIdsResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected Library tab selection.");
  }
  return parsed.data.ids;
}

export async function fetchAllOpenTabs(
  filters: Omit<OpenTabListFilters, "page" | "pageSize">,
  signal?: AbortSignal,
) {
  const searchParams = new URLSearchParams();
  if (filters.browser !== "all") {
    searchParams.set("browser", filters.browser);
  }
  if (filters.duplicatesOnly) {
    searchParams.set("duplicates_only", "true");
  }
  if (filters.q) {
    searchParams.set("q", filters.q);
  }

  const query = searchParams.toString();
  const payload = await requestJson(
    `/api/tab-instances/bulk${query ? `?${query}` : ""}`,
    {
      headers: { Accept: "application/json" },
      signal: signal ?? null,
    },
    "TabHub could not load all open tabs",
    "TabHub returned an unreadable bulk open-tab list.",
  );
  const parsed = tabInstanceBulkResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected bulk open-tab list.");
  }

  return parsed.data.items;
}

export async function fetchAllDuplicateGroups(
  filters: Omit<DuplicateGroupListFilters, "page">,
  signal?: AbortSignal,
) {
  const items = [];
  let page = 1;
  let total = 0;
  do {
    const response = await fetchDuplicateGroups({ ...filters, page }, signal);
    items.push(...response.items);
    total = response.totalGroups;
    if (response.items.length === 0) break;
    page += 1;
  } while (items.length < total);
  return items;
}

export async function fetchOpenTabs(
  filters: OpenTabListFilters,
  signal?: AbortSignal,
) {
  const searchParams = new URLSearchParams({
    page: String(filters.page),
    pageSize: String(filters.pageSize ?? 50),
  });

  if (filters.browser !== "all") {
    searchParams.set("browser", filters.browser);
  }
  if (filters.duplicatesOnly) {
    searchParams.set("duplicates_only", "true");
  }
  if (filters.q) {
    searchParams.set("q", filters.q);
  }

  const payload = await requestJson(
    `/api/tab-instances?${searchParams.toString()}`,
    {
      headers: { Accept: "application/json" },
      signal: signal ?? null,
    },
    "TabHub could not load open tabs",
    "TabHub returned an unreadable open-tab list.",
  );
  const parsed = tabInstanceListResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected open-tab list.");
  }

  return parsed.data;
}

export async function fetchDuplicateGroups(
  filters: DuplicateGroupListFilters,
  signal?: AbortSignal,
) {
  const searchParams = new URLSearchParams({
    page: String(filters.page),
    pageSize: "50",
  });
  if (filters.browser !== "all") {
    searchParams.set("browser", filters.browser);
  }

  const payload = await requestJson(
    `/api/duplicate-groups?${searchParams.toString()}`,
    {
      headers: { Accept: "application/json" },
      signal: signal ?? null,
    },
    "TabHub could not load exact duplicate groups",
    "TabHub returned an unreadable duplicate-group list.",
  );
  const parsed = duplicateGroupListResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected duplicate-group list.");
  }

  return parsed.data;
}

export async function fetchWorkspaces(signal?: AbortSignal) {
  const payload = await requestJson(
    "/api/workspaces",
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load saved workspaces",
    "TabHub returned unreadable saved workspaces.",
  );
  const parsed = workspaceListResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("TabHub returned unexpected saved workspaces.");
  return parsed.data;
}

export async function fetchWorkspace(id: number, signal?: AbortSignal) {
  const payload = await requestJson(
    `/api/workspaces/${id}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load this workspace",
    "TabHub returned an unreadable workspace.",
  );
  const parsed = workspaceDetailSchema.safeParse(payload);
  if (!parsed.success) throw new Error("TabHub returned an unexpected workspace.");
  return parsed.data;
}

export async function createWorkspace(input: CreateWorkspace) {
  const payload = await requestJson(
    "/api/workspaces",
    {
      body: JSON.stringify(input),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    },
    "TabHub could not save this workspace",
    "TabHub returned an unreadable workspace.",
  );
  const parsed = workspaceDetailSchema.safeParse(payload);
  if (!parsed.success) throw new Error("TabHub returned an unexpected workspace.");
  return parsed.data;
}

export async function renameWorkspace(id: number, name: string) {
  const payload = await requestJson(
    `/api/workspaces/${id}`,
    {
      body: JSON.stringify({ name }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "PATCH",
    },
    "TabHub could not rename this workspace",
    "TabHub returned an unreadable workspace.",
  );
  const parsed = workspaceDetailSchema.safeParse(payload);
  if (!parsed.success) throw new Error("TabHub returned an unexpected workspace.");
  return parsed.data;
}

export async function deleteWorkspace(id: number) {
  await requestJson(
    `/api/workspaces/${id}`,
    { headers: { Accept: "application/json" }, method: "DELETE" },
    "TabHub could not delete this workspace",
    "TabHub returned an unreadable deletion result.",
  );
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

export async function fetchGraph(rootTag: string, signal?: AbortSignal) {
  const searchParams = new URLSearchParams();
  if (rootTag) searchParams.set("root_tag", rootTag);
  const query = searchParams.size > 0 ? `?${searchParams.toString()}` : "";
  const payload = await requestJson(
    `/api/graph${query}`,
    { headers: { Accept: "application/json" }, signal: signal ?? null },
    "TabHub could not load the graph",
    "TabHub returned an unreadable graph.",
  );
  const parsed = graphResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("TabHub returned an unexpected graph.");
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
