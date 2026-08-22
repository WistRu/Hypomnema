import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("personal-context popup", () => {
  it("keeps the feature UI hidden until background discovery enables it", async () => {
    const html = await readFile(
      new URL("../entrypoints/popup/index.html", import.meta.url),
      "utf8",
    );
    expect(html).toContain('id="context-section" class="context-card" hidden');
    expect(html).toContain('value="page"');
    expect(html).toContain('value="this_tab"');
    expect(html).toContain('role="status" aria-live="polite"');
  });

  it("uses manual pairing fields and generates idempotency keys inside the extension", async () => {
    const source = await readFile(
      new URL("../entrypoints/popup/main.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('type: "tabhub:context-pair"');
    expect(source).toContain("contextDraftIdempotencyKey ??= crypto.randomUUID()");
    expect(source).toContain(
      "contextKind: contextKind.value as ContextEntryKind",
    );
    expect(source).toContain('event.key !== "Enter"');
    expect(source).toContain("contextForm.requestSubmit()");
    expect(source).not.toContain("Authorization");
    expect(source).not.toContain("Bearer");
    expect(source).not.toContain("window.postMessage");
  });
});
