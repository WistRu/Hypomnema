import { defineConfig } from "wxt";

export default defineConfig({
  manifestVersion: 3,
  manifest: {
    name: "TabHub",
    description: "Keep this browser's open tabs synchronized with TabHub.",
    permissions: ["alarms", "scripting", "storage", "tabs", "unlimitedStorage"],
    host_permissions: [
      "http://127.0.0.1:7717/*",
      "http://*/*",
      "https://*/*",
    ],
    action: {
      default_title: "TabHub",
    },
  },
});
