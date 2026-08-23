import type { KnownBrowser } from "./storage";

/**
 * Every Chromium browser claims `Chrome/` in its user agent, so Chrome is what
 * is left after the others have identified themselves, not something with a
 * token of its own. Order matters: Yandex and Edge both also claim `Chrome/`.
 *
 * `Edg/` is modern Chromium Edge, with `EdgA/` and `EdgiOS/` its mobile
 * spellings. The legacy `Edge/` token is a different product on a different
 * engine, so it is deliberately not read as Edge; it falls to `other` rather
 * than being counted alongside the Chromium one.
 *
 * Anything Chromium that names itself and is not one of the three the Library
 * counts separately is `other`, which is honest. An agent that names no
 * browser at all yields `undefined` rather than a guess, so the caller can ask
 * instead of silently mislabelling every tab the install ever reports.
 */
const brands: ReadonlyArray<{ browser: KnownBrowser; token: RegExp }> = [
  { browser: "yandex", token: /\bYaBrowser\// },
  { browser: "edge", token: /\bEdg(?:A|iOS)?\// },
  { browser: "other", token: /\bOPR\// },
  { browser: "other", token: /\bVivaldi\// },
  { browser: "other", token: /\bEdge\// },
];

export function detectBrowserFromUserAgent(
  userAgent: string,
): KnownBrowser | undefined {
  for (const { browser, token } of brands) {
    if (token.test(userAgent)) return browser;
  }
  return /\bChrome\//.test(userAgent) ? "chrome" : undefined;
}

export function detectBrowser(): KnownBrowser | undefined {
  return typeof navigator === "undefined"
    ? undefined
    : detectBrowserFromUserAgent(navigator.userAgent);
}
