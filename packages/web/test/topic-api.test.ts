import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTopic,
  deleteTopic,
  updateTopic,
} from "../src/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("topic CRUD API", () => {
  it("creates a colored child topic through the existing tag endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        { id: 12, name: "Crypto", parentId: 4, color: "#46c9a3" },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createTopic({ name: "Crypto", parentId: 4, color: "#46c9a3" }),
    ).resolves.toEqual({
      id: 12,
      name: "Crypto",
      parentId: 4,
      color: "#46c9a3",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tags",
      expect.objectContaining({
        body: JSON.stringify({
          name: "Crypto",
          parentId: 4,
          color: "#46c9a3",
        }),
        method: "POST",
      }),
    );
  });

  it("moves, renames, and clears the color in one patch", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ id: 12, name: "Web3", parentId: null, color: null }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateTopic(12, { name: "Web3", parentId: null, color: null }),
    ).resolves.toEqual({ id: 12, name: "Web3", parentId: null, color: null });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tags/12",
      expect.objectContaining({
        body: JSON.stringify({ name: "Web3", parentId: null, color: null }),
        method: "PATCH",
      }),
    );
  });

  it("deletes exactly one leaf topic and validates the receipt", async () => {
    const fetchMock = vi.fn(async () => Response.json({ deleted: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteTopic(12)).resolves.toEqual({ deleted: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tags/12",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("rejects a malformed topic response instead of leaking it into the tree", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "bad" })));

    await expect(createTopic({ name: "Crypto" })).rejects.toThrow(
      "TabHub returned an unexpected topic.",
    );
  });

  it("preserves a structured server error code for localization", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: "TAG_CONFLICT",
            message: "A tag named Crypto already exists under parent 7",
          },
          { status: 409 },
        ),
      ),
    );

    await expect(createTopic({ name: "Crypto", parentId: 7 })).rejects.toMatchObject({
      name: "ApiRequestError",
      code: "TAG_CONFLICT",
      status: 409,
    });
  });
});
