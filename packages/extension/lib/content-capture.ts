export const MAX_TEXT_LENGTH = 2_000_000;
export const MAX_HTML_EXCERPT_LENGTH = 250_000;
const DEFAULT_CAPTURE_CONCURRENCY = 4;

export interface CapturableTab {
  discarded?: boolean | undefined;
  id?: number | undefined;
  index: number;
  url?: string | undefined;
  windowId: number;
}

export interface EligibleCaptureTab extends CapturableTab {
  id: number;
  url: string;
}

export interface ExtractedPage {
  htmlExcerpt: string;
  text: string;
  url: string;
}

export interface CapturedPage {
  page: ExtractedPage;
  tab: EligibleCaptureTab;
}

export interface CaptureBatchResult {
  captured: CapturedPage[];
  requested: number;
  skipped: number;
}

export interface ExtractionParts {
  fallbackHtml: string;
  fallbackText: string;
  readabilityHtml?: string | null | undefined;
  readabilityText?: string | null | undefined;
  url: string;
}

export type TabExtractor = (tabId: number) => Promise<unknown>;

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function toEligibleCaptureTab(
  tab: CapturableTab,
): EligibleCaptureTab | undefined {
  if (
    tab.discarded === true ||
    !Number.isInteger(tab.id) ||
    typeof tab.url !== "string" ||
    !isHttpUrl(tab.url)
  ) {
    return undefined;
  }

  return {
    discarded: tab.discarded,
    id: tab.id as number,
    index: tab.index,
    url: tab.url,
    windowId: tab.windowId,
  };
}

function preferredValue(
  primary: string | null | undefined,
  fallback: string,
): string {
  const normalizedPrimary = primary?.trim();
  return normalizedPrimary && normalizedPrimary.length > 0
    ? normalizedPrimary
    : fallback.trim();
}

export function finalizeExtractedPage(parts: ExtractionParts): ExtractedPage {
  return {
    htmlExcerpt: preferredValue(
      parts.readabilityHtml,
      parts.fallbackHtml,
    ).slice(0, MAX_HTML_EXCERPT_LENGTH),
    text: preferredValue(parts.readabilityText, parts.fallbackText).slice(
      0,
      MAX_TEXT_LENGTH,
    ),
    url: parts.url,
  };
}

function parseExtractedPage(value: unknown): ExtractedPage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const candidate = value as Partial<ExtractedPage>;

  if (
    typeof candidate.url !== "string" ||
    !isHttpUrl(candidate.url) ||
    typeof candidate.text !== "string" ||
    typeof candidate.htmlExcerpt !== "string"
  ) {
    return undefined;
  }

  return finalizeExtractedPage({
    fallbackHtml: "",
    fallbackText: "",
    readabilityHtml: candidate.htmlExcerpt,
    readabilityText: candidate.text,
    url: candidate.url,
  });
}

export async function captureEligibleTabs(
  tabs: readonly CapturableTab[],
  extract: TabExtractor,
  concurrency = DEFAULT_CAPTURE_CONCURRENCY,
): Promise<CaptureBatchResult> {
  const eligibleTabs = tabs.flatMap((tab) => {
    const eligible = toEligibleCaptureTab(tab);
    return eligible === undefined ? [] : [eligible];
  });
  const capturedByIndex: Array<CapturedPage | undefined> = new Array(
    eligibleTabs.length,
  );
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < eligibleTabs.length) {
      const index = nextIndex;
      nextIndex += 1;
      const tab = eligibleTabs[index];

      if (tab === undefined) {
        continue;
      }

      try {
        const page = parseExtractedPage(await extract(tab.id));

        if (page !== undefined) {
          capturedByIndex[index] = { page, tab };
        }
      } catch {
        // Restricted, closed, or otherwise unavailable tabs are skipped.
      }
    }
  }

  const workerCount = Math.min(
    Math.max(1, Math.trunc(concurrency)),
    eligibleTabs.length,
  );
  await Promise.all(Array.from({ length: workerCount }, worker));
  const captured = capturedByIndex.filter(
    (item): item is CapturedPage => item !== undefined,
  );

  return {
    captured,
    requested: tabs.length,
    skipped: tabs.length - captured.length,
  };
}
