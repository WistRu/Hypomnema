import { vi } from "vitest";

/**
 * App probes the extension to decide whether to offer pairing. In jsdom the
 * real bridge posts into a window nothing answers and resolves unavailable
 * only after its timeout, so every render would idle for seconds. This returns
 * the same unavailable answer immediately.
 *
 * Use from a `vi.mock("../src/extension-bridge", ...)` factory; a test that
 * cares what the extension says should build its own stub instead.
 */
export function unavailableExtensionBridge() {
  return {
    activate: vi.fn(),
    command: vi.fn(),
    pair: vi.fn(),
    probe: async () => ({
      available: false as const,
      browser: null,
      browserSessionId: null,
      controlWindowId: null,
      installationId: null,
      pendingUndos: [],
      windows: [],
    }),
  };
}
