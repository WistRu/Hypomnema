export type LocalizedExtensionError = {
  messageName:
    | "extensionErrorContentUpload"
    | "extensionErrorContextQueueChanged"
    | "extensionErrorContextQueueCorrupted"
    | "extensionErrorOfflineQueueFull"
    | "extensionErrorSnapshotUpload"
    | "popupActionFailed"
    | "popupChooseBrowserIdentity"
    | "popupContextStaleQueued";
  substitutions?: string[];
};

const IDENTITY_REQUIRED_ERROR =
  "Choose this extension's browser identity in Browser settings before synchronizing tabs.";

export function localizedExtensionError(
  message: string,
): LocalizedExtensionError {
  if (message === IDENTITY_REQUIRED_ERROR) {
    return { messageName: "popupChooseBrowserIdentity" };
  }

  const upload = /^(Snapshot|Content) upload failed \(HTTP (\d{3})\)/.exec(
    message,
  );
  if (upload?.[1] && upload[2]) {
    return {
      messageName:
        upload[1] === "Snapshot"
          ? "extensionErrorSnapshotUpload"
          : "extensionErrorContentUpload",
      substitutions: [upload[2]],
    };
  }

  if (message.startsWith("TabHub's offline queue is full")) {
    return { messageName: "extensionErrorOfflineQueueFull" };
  }

  if (
    message ===
    "Personal-context queue is corrupted; no later mutations were sent"
  ) {
    return { messageName: "extensionErrorContextQueueCorrupted" };
  }

  if (message === "The queued context changed; review it again") {
    return { messageName: "extensionErrorContextQueueChanged" };
  }

  if (message === "Page changed; review required") {
    return { messageName: "popupContextStaleQueued" };
  }

  return { messageName: "popupActionFailed" };
}
