import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";

describe("Library bulk ID selection", () => {
  it("returns and mutates every filtered canonical tab without a page ceiling", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tabhub-library-bulk-"));
    const app = createApp({
      databasePath: join(directory, "tabhub.sqlite"),
      logger: false,
    });

    try {
      const tabCount = 1_001;
      const chromeSnapshot = await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "chrome",
          tabs: Array.from({ length: tabCount }, (_, index) => ({
            index,
            title: `Chrome ${index + 1}`,
            url: `https://chrome.example/${index + 1}`,
            windowId: 1,
          })),
        },
      });
      expect(chromeSnapshot.statusCode).toBe(200);

      await app.inject({
        method: "POST",
        url: "/api/ingest/snapshot",
        payload: {
          browser: "edge",
          tabs: [
            {
              index: 0,
              title: "Excluded Edge tab",
              url: "https://edge.example/excluded",
              windowId: 1,
            },
          ],
        },
      });

      const selected = await app.inject({
        method: "GET",
        url: "/api/tabs/bulk-ids?browser=chrome&status=inbox&importance=0&is_open=true",
      });

      expect(selected.statusCode).toBe(200);
      expect(selected.json().ids).toHaveLength(tabCount);
      expect(new Set(selected.json().ids).size).toBe(tabCount);

      const updated = await app.inject({
        method: "PATCH",
        url: "/api/tabs/status",
        payload: { ids: selected.json().ids, status: "done" },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toEqual({ status: "done", updated: tabCount });

      const filteredAfterMutation = await app.inject({
        method: "GET",
        url: "/api/tabs/bulk-ids?browser=chrome&status=done",
      });
      expect(filteredAfterMutation.json().ids).toEqual(selected.json().ids);
    } finally {
      await app.close();
      await rm(directory, { force: true, recursive: true });
    }
  });
});
