import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface LocalePlaceholder {
  content: string;
  example?: string;
}

interface LocaleMessage {
  message: string;
  placeholders?: Record<string, LocalePlaceholder>;
}

type LocaleCatalog = Record<string, LocaleMessage>;

async function readCatalog(locale: "en" | "ru"): Promise<LocaleCatalog> {
  const url = new URL(
    `../public/_locales/${locale}/messages.json`,
    import.meta.url,
  );
  return JSON.parse(await readFile(url, "utf8")) as LocaleCatalog;
}

function placeholderNames(message: LocaleMessage): string[] {
  return Object.keys(message.placeholders ?? {}).sort();
}

function referencedPlaceholders(message: LocaleMessage): string[] {
  return [...message.message.matchAll(/\$([A-Za-z][A-Za-z0-9_]*)\$/g)]
    .map((match) => match[1]!.toLocaleLowerCase("en-US"))
    .sort();
}

describe("extension locale catalogs", () => {
  it("defines every catalog key referenced by the manifest", async () => {
    const [config, english] = await Promise.all([
      readFile(new URL("../wxt.config.ts", import.meta.url), "utf8"),
      readCatalog("en"),
    ]);
    const manifestMessageNames = [
      ...config.matchAll(/__MSG_([A-Za-z0-9_]+)__/g),
    ].map((match) => match[1]!);

    expect(manifestMessageNames.length).toBeGreaterThan(0);
    for (const name of manifestMessageNames) {
      expect(english, name).toHaveProperty(name);
    }
  });

  it("keeps the Russian catalog in exact key and placeholder parity with English", async () => {
    const [english, russian] = await Promise.all([
      readCatalog("en"),
      readCatalog("ru"),
    ]);

    expect(Object.keys(russian).sort()).toEqual(Object.keys(english).sort());

    for (const key of Object.keys(english)) {
      expect(placeholderNames(russian[key]!)).toEqual(
        placeholderNames(english[key]!),
      );
    }
  });

  it.each(["en", "ru"] as const)(
    "%s messages are non-empty and declare every named placeholder",
    async (locale) => {
      const catalog = await readCatalog(locale);

      for (const [key, message] of Object.entries(catalog)) {
        expect(message.message.trim(), key).not.toBe("");
        expect(referencedPlaceholders(message), key).toEqual(
          placeholderNames(message),
        );

        for (const [name, placeholder] of Object.entries(
          message.placeholders ?? {},
        )) {
          expect(placeholder.content.trim(), `${key}.${name}`).toMatch(
            /^\$\d+$/,
          );
        }
      }
    },
  );
});
