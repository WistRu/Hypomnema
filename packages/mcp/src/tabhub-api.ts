import {
  assignTagsResponseSchema,
  setStatusResponseSchema,
  statsResponseSchema,
  tabDetailResponseSchema,
  tabListResponseSchema,
  tagTreeResponseSchema,
  type AssignTagsResponse,
  type SetStatusResponse,
  type StatsResponse,
  type TabDetailResponse,
  type TabImportance,
  type TabListResponse,
  type TabStatus,
  type TagTreeResponse,
} from "@tabhub/shared";

export interface ListTabsInput {
  browser?: string;
  status?: TabStatus;
  importance?: TabImportance;
  isOpen?: boolean;
  q?: string;
  page: number;
  pageSize: number;
}

export interface TabHubApi {
  listTabs(input: ListTabsInput): Promise<TabListResponse>;
  getTab(id: number): Promise<TabDetailResponse>;
  setStatus(input: {
    ids: number[];
    status: TabStatus;
  }): Promise<SetStatusResponse>;
  tagTabs(input: {
    ids: number[];
    tagPath: string;
  }): Promise<AssignTagsResponse>;
  listTags(): Promise<TagTreeResponse>;
  getStats(): Promise<StatsResponse>;
}

export interface TabHubApiOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ResponseSchema<T> {
  parse(value: unknown): T;
}

function serverMessage(value: unknown): string | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return value.message;
  }

  return undefined;
}

export function createTabHubApi(
  options: TabHubApiOptions = {},
): TabHubApi {
  const baseUrl = new URL(
    options.baseUrl ?? process.env.TABHUB_API_URL ?? "http://127.0.0.1:7717",
  );
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<T>(
    path: string,
    schema: ResponseSchema<T>,
    init: RequestInit,
  ): Promise<T> {
    const response = await fetchImpl(new URL(path, baseUrl).href, init);
    let body: unknown;

    try {
      body = await response.json();
    } catch {
      throw new Error(
        `TabHub API ${init.method ?? "GET"} ${path} returned a non-JSON response (HTTP ${response.status})`,
      );
    }

    if (!response.ok) {
      const detail = serverMessage(body);
      throw new Error(
        `TabHub API ${init.method ?? "GET"} ${path} returned HTTP ${response.status}${detail === undefined ? "" : `: ${detail}`}`,
      );
    }

    try {
      return schema.parse(body);
    } catch {
      throw new Error(
        `TabHub API ${init.method ?? "GET"} ${path} returned an invalid response`,
      );
    }
  }

  return {
    async listTabs(input) {
      const searchParams = new URLSearchParams({
        page: String(input.page),
        pageSize: String(input.pageSize),
      });

      if (input.browser !== undefined) {
        searchParams.set("browser", input.browser);
      }
      if (input.status !== undefined) {
        searchParams.set("status", input.status);
      }
      if (input.importance !== undefined) {
        searchParams.set("importance", String(input.importance));
      }
      if (input.isOpen !== undefined) {
        searchParams.set("is_open", String(input.isOpen));
      }
      if (input.q !== undefined) {
        searchParams.set("q", input.q);
      }

      return request(
        `/api/tabs?${searchParams.toString()}`,
        tabListResponseSchema,
        { method: "GET" },
      );
    },

    async getTab(id) {
      return request(`/api/tabs/${id}`, tabDetailResponseSchema, {
        method: "GET",
      });
    },

    async setStatus(input) {
      return request("/api/tabs/status", setStatusResponseSchema, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    },

    async tagTabs(input) {
      return request("/api/tags/assign", assignTagsResponseSchema, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...input, assignedBy: "agent" }),
      });
    },

    async listTags() {
      return request("/api/tags", tagTreeResponseSchema, { method: "GET" });
    },

    async getStats() {
      return request("/api/stats", statsResponseSchema, { method: "GET" });
    },
  };
}
