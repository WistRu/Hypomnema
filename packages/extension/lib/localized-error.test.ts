import { describe, expect, it } from "vitest";

import { localizedExtensionError } from "./localized-error";

describe("localizedExtensionError", () => {
  it("preserves the HTTP status for known upload failures", () => {
    expect(
      localizedExtensionError("Snapshot upload failed (HTTP 503): unavailable"),
    ).toEqual({
      messageName: "extensionErrorSnapshotUpload",
      substitutions: ["503"],
    });
    expect(localizedExtensionError("Content upload failed (HTTP 429)")).toEqual({
      messageName: "extensionErrorContentUpload",
      substitutions: ["429"],
    });
  });

  it("maps identity and queue failures without exposing English copy", () => {
    expect(
      localizedExtensionError(
        "Choose this extension's browser identity in Browser settings before synchronizing tabs.",
      ),
    ).toEqual({ messageName: "popupChooseBrowserIdentity" });
    expect(
      localizedExtensionError("TabHub's offline queue is full (2000 operations)."),
    ).toEqual({ messageName: "extensionErrorOfflineQueueFull" });
  });

  it("uses a localized generic fallback for unknown controlled errors", () => {
    expect(localizedExtensionError("The browser did not move this tab.")).toEqual({
      messageName: "popupActionFailed",
    });
  });
});
