export interface ActivityContentInjectionTab {
  pendingUrl?: string | undefined;
  url?: string | undefined;
}

export interface ActivityContentInjectionAdapter {
  getTab(tabId: number): Promise<ActivityContentInjectionTab>;
  inject(tabId: number): Promise<void>;
  ping(tabId: number): Promise<boolean>;
}

export interface ActivityContentInjector {
  ensure(tabId: number): Promise<void>;
  ensureAll(tabIds: readonly number[]): Promise<void>;
}

function isEligibleUrl(value: string | undefined): boolean {
  if (value === undefined || !URL.canParse(value)) return false;
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}

export function createActivityContentInjector(
  adapter: ActivityContentInjectionAdapter,
): ActivityContentInjector {
  const inFlight = new Map<number, Promise<void>>();

  const injectIfNeeded = async (tabId: number): Promise<void> => {
    try {
      const tab = await adapter.getTab(tabId);
      const url = tab.pendingUrl?.trim() || tab.url?.trim();
      if (!isEligibleUrl(url)) return;
      if (await adapter.ping(tabId)) return;
      await adapter.inject(tabId);
    } catch {
      // Chrome Web Store, privileged pages, and tabs disappearing mid-check
      // reject messaging or scripting. Activity tracking is best-effort there.
    }
  };

  const ensure = (tabId: number): Promise<void> => {
    const existing = inFlight.get(tabId);
    if (existing !== undefined) return existing;

    const operation = injectIfNeeded(tabId).finally(() => {
      if (inFlight.get(tabId) === operation) inFlight.delete(tabId);
    });
    inFlight.set(tabId, operation);
    return operation;
  };

  return {
    ensure,
    async ensureAll(tabIds) {
      // Installation/update is rare; serial injection avoids flooding the
      // scripting API when a profile has hundreds of already-open tabs.
      for (const tabId of new Set(tabIds)) await ensure(tabId);
    },
  };
}
