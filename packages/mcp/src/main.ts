import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createMcpServer } from "./server.js";
import { createTabHubApi } from "./tabhub-api.js";

const api = createTabHubApi();
const handle = serveStdio(() => createMcpServer(api), {
  onerror(error) {
    console.error(`[tabhub-mcp] ${error.message}`);
  },
});

function shutdown(): void {
  void handle.close().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tabhub-mcp] Failed to shut down cleanly: ${message}`);
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
