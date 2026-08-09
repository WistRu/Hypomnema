import { defineConfig } from "wxt";

export default defineConfig({
  manifestVersion: 3,
  manifest: {
    default_locale: "en",
    name: "__MSG_extensionName__",
    description: "__MSG_extensionDescription__",
    minimum_chrome_version: "116",
    permissions: ["alarms", "scripting", "storage", "tabs", "unlimitedStorage"],
    host_permissions: [
      "http://127.0.0.1:7717/*",
      "http://*/*",
      "https://*/*",
    ],
    action: {
      default_title: "__MSG_extensionName__",
    },
  },
});
