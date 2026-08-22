import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  formatDuration,
  hasRussianTranslation,
  I18nProvider,
  localizedErrorMessage,
  resolveLocale,
  translate,
  useI18n,
} from "../src/i18n";

function LocaleProbe() {
  const { formatNumber, locale, localeTag, t } = useI18n();
  return (
    <output data-locale={locale} data-locale-tag={localeTag}>
      {t("Page {page} of {total}", {
        page: formatNumber(1_234),
        total: formatNumber(5_678),
      })}
    </output>
  );
}

function LiveUtcProbe() {
  const { formatDate, t } = useI18n();
  const date = formatDate("2026-08-21T12:34:56.000Z", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  });
  return <output>{t("Daily start limit resets at {date} UTC", { date })}</output>;
}

const W90_SOURCE_FILES = [
  "LiveResourceResearchPanel.tsx",
  "LiveAcquisitionRunView.tsx",
  "ResearchPurgeControl.tsx",
  "ResourceHeader.tsx",
  "ResearchHistoryDrawer.tsx",
] as const;

const W90_DYNAMIC_TRANSLATION_KEYS = [
  "Captured", "Missing", "Failed", "Excluded",
  "discovered", "captured", "eligible", "used", "missing", "failed",
  "live_acquisition", "safe_public_http_v1", "inventory", "exact_capture",
  "page_context", "resource_context", "activity", "relation", "truncated", "complete",
  "Live acquisition is running", "Live acquisition completed", "Mixed live acquisition completed",
  "No usable live sources", "Live acquisition was blocked", "Live acquisition needs review",
  "Live acquisition was cancelled", "Live acquisition failed", "Live acquisition is being purged",
  "Live acquisition was redacted", "Queued", "Running", "Succeeded", "Partially completed",
  "Cancelled", "Superseded", "Reserved pages", "Visited pages", "Captured pages",
  "Blocked pages", "Ambiguous pages", "Robots actions", "Network actions", "Planned actions",
  "Active actions", "active", "expired", "consumed", "revoked", "handoff", "captured_only",
  "blocked", "ambiguous", "superseded", "Robots", "Page", "planned", "resolution_started",
  "resolved", "authorized", "started", "completed", "unusable", "pending",
  "DNS_RESULT_UNKNOWN", "RUNTIME_RESTARTED_BEFORE_REQUEST", "IPV4_REQUIRED_V1",
  "PARTIAL_RESPONSE", "META_REFRESH", "AUTH_REQUIRED", "CHALLENGE_PAGE", "SPA_SHELL",
  "INSUFFICIENT_PUBLIC_TEXT", "INVALID_UTF8", "CONSENT_EXPIRED_IN_FLIGHT",
  "ACQUISITION_RESOURCE_MEMBERSHIP_MISMATCH", "SENSITIVE_URL_CAPTURE_REQUIRED",
  "LIVE_ACQUISITION_DISABLED", "LIVE_ACQUISITION_DISABLED_IN_FLIGHT", "POLICY_BLOCKED",
  "TRANSPORT_DNS_FAILURE", "TRANSPORT_CONNECT_FAILURE", "TRANSPORT_TLS_FAILURE",
  "TRANSPORT_TIMEOUT", "HTTP_INFORMATIONAL", "HTTP_SUCCESS", "HTTP_REDIRECT",
  "HTTP_CLIENT_ERROR", "HTTP_SERVER_ERROR", "RESPONSE_SIZE_LIMIT", "FETCH_COMPLETED",
  "CANCELLED", "BUDGET_EXHAUSTED", "LIVE_ACQUISITION_RESOURCE_REQUIRED",
  "LIVE_ACQUISITION_TARGET_UNSUPPORTED", "RESEARCH_WORKFLOW_UNSUPPORTED",
  "PURGE_WAITING_FOR_ACTION", "SUBJECT_FORGOTTEN", "WORKFLOW_COMPLETED", "WORKFLOW_BLOCKED",
  "WORKFLOW_AMBIGUOUS", "WORKFLOW_FAILED", "WORKFLOW_CANCELLED", "NO_ELIGIBLE_SOURCE",
  "PROVIDER_UNAVAILABLE", "Waiting for safe deletion", "Deletion is on hold", "Ready to delete",
  "Deletion committed", "Deletion completed", "Deletion failed", "Deletion requires manual review",
  "Waiting for provider settlement",
] as const;

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

describe("locale resolution", () => {
  it("prefers a saved supported locale", () => {
    expect(resolveLocale("en", ["ru-RU"])).toBe("en");
    expect(resolveLocale("ru", ["en-US"])).toBe("ru");
  });

  it("detects Russian from the browser language list", () => {
    expect(resolveLocale(null, ["de-DE", "ru-RU"])).toBe("ru");
  });

  it("uses the first supported browser language", () => {
    expect(resolveLocale(null, ["en-US", "ru-RU"])).toBe("en");
    expect(resolveLocale(null, ["ru-RU", "en-US"])).toBe("ru");
  });

  it("falls back to English for unsupported and malformed locales", () => {
    expect(resolveLocale("de", ["de-DE"])).toBe("en");
    expect(resolveLocale(undefined, [])).toBe("en");
  });
});

describe("duration formatting", () => {
  it("formats compact activity durations in English and Russian", () => {
    expect(formatDuration("en", 3_661_000)).toBe("1h 1m");
    expect(formatDuration("ru", 125_000)).toBe("2 мин 5 с");
    expect(formatDuration("ru", 0)).toBe("0 с");
  });

  it("keeps positive sub-second activity visibly distinct from zero", () => {
    expect(formatDuration("en", 0)).toBe("0s");
    expect(formatDuration("en", 1)).toBe("<1s");
    expect(formatDuration("en", 999)).toBe("<1s");
    expect(formatDuration("en", 1_000)).toBe("1s");
    expect(formatDuration("ru", 0)).toBe("0 с");
    expect(formatDuration("ru", 1)).toBe("<1 с");
    expect(formatDuration("ru", 999)).toBe("<1 с");
    expect(formatDuration("ru", 1_000)).toBe("1 с");
  });
});

describe("translations", () => {
  it("keeps English as the source-copy fallback", () => {
    expect(translate("en", "Open {tab} in browser", { tab: "Example" })).toBe(
      "Open Example in browser",
    );
  });

  it("interpolates Russian copy and exposes registered keys", () => {
    expect(translate("ru", "Open {tab} in browser", { tab: "Пример" })).toBe(
      "Открыть «Пример» в браузере",
    );
    expect(hasRussianTranslation("Open {tab} in browser")).toBe(true);
  });

  it("localizes durable research progress stages", () => {
    expect(
      ["claimed", "provider_ready", "terminal_publication"].map((stage) =>
        translate("ru", stage),
      ),
    ).toEqual([
      "Задание получено",
      "Запрос к ИИ подготовлен",
      "Публикация результата",
    ]);
  });

  it("uses Russian plural forms for tab counts", () => {
    const tabs = (count: number) =>
      translate("ru", "{count} tabs", {
        count: String(count),
        rawCount: count,
      });

    expect(tabs(1)).toBe("1 вкладка");
    expect(tabs(2)).toBe("2 вкладки");
    expect(tabs(5)).toBe("5 вкладок");
    expect(tabs(21)).toBe("21 вкладка");
  });

  it("uses topic terminology for hierarchical grouping and graph counts", () => {
    const topics = (count: number) =>
      translate("ru", "{count} topics", {
        count: String(count),
        rawCount: count,
      });

    expect(topics(1)).toBe("1 тема");
    expect(topics(2)).toBe("2 темы");
    expect(topics(5)).toBe("5 тем");
    expect(translate("ru", "No topics assigned.")).toBe("Темы не назначены.");
    expect(
      translate("ru", "Remove {topic}, assigned by {source}", {
        source: "Пользователь",
        topic: "Работа/Крипта",
      }),
    ).toBe("Удалить тему Работа/Крипта, назначенную: Пользователь");
  });

  it("localizes structured topic and relation API errors without exposing server English", () => {
    const conflict = Object.assign(
      new Error("A tag named Crypto already exists under parent 7"),
      { code: "TAG_CONFLICT" },
    );
    const selfRelation = Object.assign(
      new Error("topic:7 cannot relate to itself"),
      { code: "SELF_RELATION_NOT_ALLOWED" },
    );
    const systemTopic = Object.assign(
      new Error("System tag 1 cannot be changed manually"),
      { code: "SYSTEM_TAG_IMMUTABLE" },
    );

    expect(localizedErrorMessage("ru", conflict)).toBe(
      "Тема с таким названием уже существует на этом уровне.",
    );
    expect(localizedErrorMessage("ru", selfRelation)).toBe(
      "Нельзя создать связь узла с самим собой.",
    );
    expect(localizedErrorMessage("ru", systemTopic)).toBe(
      "Тема «Без темы» управляется автоматически.",
    );
  });

  it("maps the closed personal-context error set in English and Russian without server copy", () => {
    const cases = [
      {
        code: "LOCAL_CAPABILITY_REQUIRED",
        en: "Personal context requires a paired local browser. Pair this browser and try again.",
        ru: "Для личного контекста нужен подключённый локальный браузер. Подключите этот браузер и повторите попытку.",
      },
      {
        code: "CONTEXT_ENTRY_NOT_CURRENT",
        en: "This context entry is no longer current. Reload personal context and try again.",
        ru: "Эта запись контекста уже не является текущей. Обновите личный контекст и повторите попытку.",
      },
      {
        code: "SESSION_SCOPE_STALE",
        en: "This open tab changed. Refresh its copies and try again.",
        ru: "Эта открытая вкладка изменилась. Обновите список копий и повторите.",
      },
      {
        code: "NOT_FOUND",
        en: "The requested personal context no longer exists. Reload and try again.",
        ru: "Запрошенный личный контекст больше не существует. Обновите данные и повторите попытку.",
      },
      {
        code: "CONTEXT_SUBJECT_MISMATCH",
        en: "This context entry belongs to a different page. Reload personal context and try again.",
        ru: "Эта запись контекста относится к другой странице. Обновите личный контекст и повторите попытку.",
      },
      {
        code: "CONTEXT_STATE_INVALID",
        en: "This context entry cannot be changed in its current state. Reload personal context and try again.",
        ru: "Эту запись контекста нельзя изменить в её текущем состоянии. Обновите личный контекст и повторите попытку.",
      },
      {
        code: "CONTEXT_REVIEW_NOT_ALLOWED",
        en: "Only AI suggestions can be accepted or rejected.",
        ru: "Принимать или отклонять можно только предложения ИИ.",
      },
      {
        code: "IDEMPOTENCY_KEY_CONFLICT",
        en: "This action conflicts with an earlier request. Reload and try again.",
        ru: "Это действие конфликтует с предыдущим запросом. Обновите данные и повторите попытку.",
      },
      {
        code: "SESSION_INTENT_STATE_INVALID",
        en: "This open-tab intent cannot be changed in its current state. Reload it and try again.",
        ru: "Цель этой открытой вкладки нельзя изменить в её текущем состоянии. Обновите её и повторите попытку.",
      },
      {
        code: "SESSION_INTENT_SUBJECT_MISMATCH",
        en: "This open-tab intent belongs to a different page. Refresh open copies and try again.",
        ru: "Цель этой открытой вкладки относится к другой странице. Обновите список открытых копий и повторите попытку.",
      },
      {
        code: "VALIDATION_ERROR",
        en: "TabHub rejected invalid personal-context data. Review the fields and try again.",
        ru: "TabHub отклонил некорректные данные личного контекста. Проверьте поля и повторите попытку.",
      },
    ];

    for (const item of cases) {
      const error = Object.assign(new Error("unsafe server detail"), {
        code: item.code,
      });
      expect(localizedErrorMessage("en", error)).toBe(item.en);
      expect(localizedErrorMessage("ru", error)).toBe(item.ru);
    }
  });

  it("labels kept and duplicate copies in Russian", () => {
    expect(translate("ru", "Keep this copy")).toBe("Оставить");
    expect(
      translate("ru", "Duplicate of kept copy"),
    ).toBe("Дубликат сохраняемой копии");
    expect(
      translate("ru", "{count} open copies", {
        count: "5",
        rawCount: 5,
      }),
    ).toBe("5 открытых копий");
    expect(
      translate("ru", "Close all duplicates from {group} ({count})…", {
        count: "2",
        group: "Example",
        rawCount: 2,
      }),
    ).toBe("Закрыть все дубликаты группы «Example» (2)…");
    expect(
      translate("ru", "After closing, {count} pinned copies will remain.", {
        count: "3",
        rawCount: 3,
      }),
    ).toBe("После закрытия останется закреплённых копий: 3.");
  });

  it("localizes known client errors while preserving status codes", () => {
    expect(
      localizedErrorMessage(
        "ru",
        new Error("TabHub could not load tabs (503)."),
      ),
    ).toBe("TabHub не удалось загрузить вкладки (503).");
    expect(localizedErrorMessage("ru", new Error("Custom server detail"))).toBe(
      "Custom server detail",
    );
  });

  it("localizes controlled extension errors and hides unknown English bridge errors", () => {
    const known = new Error(
      "That browser tab is no longer available. Refresh the Library and try again.",
    );
    known.name = "ExtensionBridgeError";
    expect(localizedErrorMessage("ru", known)).toBe(
      "Эта вкладка браузера больше недоступна. Обновите библиотеку и повторите попытку.",
    );

    const unknown = new Error("No tab with id: 42");
    unknown.name = "ExtensionBridgeError";
    expect(localizedErrorMessage("ru", unknown)).toBe(
      "Расширению браузера не удалось выполнить это действие.",
    );
  });

  it("localizes an outcome-unknown relay error without inviting a retry", () => {
    const error = Object.assign(new Error("connection lost"), {
      name: "TabCommandRelayClientError",
      code: "EXTENSION_DISCONNECTED",
      outcome: "unknown",
    });

    expect(localizedErrorMessage("ru", error)).toContain(
      "это подтверждение нельзя повторить",
    );
  });

  it("localizes a failed Windows foreground handoff distinctly", () => {
    const message =
      "Windows activated the tab, but could not bring its browser to the foreground. Try again.";
    const error = Object.assign(new Error(message), {
      name: "TabCommandRelayClientError",
      code: "FOREGROUND_HANDOFF_FAILED",
      outcome: "unknown",
    });

    expect(localizedErrorMessage("ru", error)).toBe(
      translate("ru", message),
    );
  });

  it("localizes the relay upgrade required for middle-click close", () => {
    const message =
      "Reload the updated TabHub extension in that browser before closing tabs with the middle mouse button.";
    const error = Object.assign(new Error("legacy relay"), {
      name: "TabCommandRelayClientError",
      code: "EXTENSION_PROTOCOL_UNSUPPORTED",
      outcome: "not-sent",
    });

    expect(translate("ru", message)).not.toBe(message);
    expect(localizedErrorMessage("ru", error)).toBe(
      translate("ru", message),
    );
  });

  it("provides a Russian page description", () => {
    expect(
      translate(
        "ru",
        "TabHub keeps tabs from all of your browsers in one local workspace.",
      ),
    ).toBe(
      "TabHub собирает вкладки из всех ваших браузеров в одном локальном рабочем пространстве.",
    );
  });

  it("uses a grammatical connection label for an unknown browser", () => {
    expect(
      translate(
        "ru",
        "Connected to another browser. Click a tab title to switch to that existing tab.",
      ),
    ).toContain("к другому браузеру");
  });

  it("provides locale-aware formatting through the provider", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="ru">
        <LocaleProbe />
      </I18nProvider>,
    );

    expect(markup).toContain('data-locale="ru"');
    expect(markup).toContain('data-locale-tag="ru-RU"');
    expect(markup).toContain(
      new Intl.NumberFormat("ru-RU").format(1_234),
    );
    expect(markup).toContain("Страница");
  });

  it("translates every dynamic personal-context kind", () => {
    expect(
      ["Purpose", "Interest", "Question", "Project", "Next action", "Disposition", "Note"].map(
        (key) => translate("ru", key),
      ),
    ).toEqual([
      "Назначение",
      "Интерес",
      "Вопрос",
      "Проект",
      "Следующее действие",
      "Решение",
      "Примечание",
    ]);
  });

  it("translates every quick personal-context preset", () => {
    expect(
      ["Do", "Research", "Reference", "Compare", "Temporary"].map((key) =>
        translate("ru", key),
      ),
    ).toEqual(["Сделать", "Исследовать", "Справка", "Сравнить", "Временно"]);
  });

  it("has Russian copy for every literal component translation key", () => {
    const sourceDirectory = fileURLToPath(new URL("../src", import.meta.url));
    const sourceFiles = readdirSync(sourceDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
      .map((entry) => `${sourceDirectory}/${entry.name}`);
    const missing = new Set<string>();
    const literalTranslation = /\bt\(\s*"([^"]+)"/g;

    for (const sourceFile of sourceFiles) {
      const source = readFileSync(sourceFile, "utf8");
      for (const match of source.matchAll(literalTranslation)) {
        const key = match[1];
        if (key !== undefined && !hasRussianTranslation(key)) missing.add(key);
      }
    }

    expect([...missing].sort()).toEqual([]);
  });

  it("has Russian copy for every closed research-history label", () => {
    const keys = [
      "fresh", "stale", "redacted", "superseded", "succeeded", "partial",
      "budget_exhausted", "corpus_became_stale", "Valid", "Invalid", "Redacted",
      "Captured page content", "Page context snapshot", "Resource context snapshot",
      "Activity snapshot", "Relation snapshot",
      "Fresh report", "Stale report", "Redacted report state", "Superseded report",
      "Successful publication", "Partial publication", "Budget exhausted",
      "Corpus became stale", "Research run queued", "Research run in progress",
      "Research run published successfully", "Research run published partially",
      "Research run failed", "Research run cancelled", "Research run superseded",
    ];
    expect(keys.filter((key) => !hasRussianTranslation(key))).toEqual([]);
  });

  it("localizes every W80b client and local-API failure path", () => {
    const messages = [
      "TabHub could not load research report history",
      "TabHub returned unreadable research report history.",
      "TabHub returned mismatched research report history.",
      "TabHub could not load this research report",
      "TabHub returned an unreadable research report.",
      "TabHub returned mismatched research report detail.",
      "Research refinement target does not match its parent report.",
      "TabHub could not start this research refinement",
      "TabHub returned an unreadable research job.",
      "TabHub returned an unexpected research refinement job.",
      "Research refinement parent does not match its preflight.",
      "TabHub returned mismatched research progress.",
      "Research history contains conflicting copies of one report.",
      "Research history assigns one version to multiple reports.",
      "A selection cannot receive one shared next action.",
      "TabHub could not save resource context",
      "TabHub returned an unreadable resource-context update.",
      "TabHub returned an unexpected resource-context update.",
      "TabHub could not update personal context",
      "TabHub returned an unreadable personal-context update.",
      "TabHub returned an unexpected personal-context update.",
      "TabHub could not read research progress",
      "TabHub returned unreadable research progress.",
      "TabHub could not start this research run",
      "TabHub returned an unexpected research job.",
      "TabHub could not cancel this research run",
      "TabHub could not prepare this research run",
      "TabHub returned unreadable research preflight data.",
      "TabHub returned mismatched research preflight data.",
    ];
    for (const message of messages) {
      expect(localizedErrorMessage("ru", new Error(message))).not.toBe(message);
    }
    expect(localizedErrorMessage("ru", new Error(
      "TabHub could not load research report history (503).",
    ))).toMatch(/\(503\)\.$/);
  });

  it("closes every literal and typed W90 translation key with placeholder parity", () => {
    const sourceDirectory = fileURLToPath(new URL("../src", import.meta.url));
    const keys = new Set<string>(W90_DYNAMIC_TRANSLATION_KEYS);
    const literalTranslation = /\bt\(\s*"((?:\\.|[^"\\])*)"/g;

    for (const sourceName of W90_SOURCE_FILES) {
      const source = readFileSync(`${sourceDirectory}/${sourceName}`, "utf8");
      for (const match of source.matchAll(literalTranslation)) {
        if (match[1] !== undefined) keys.add(JSON.parse(`"${match[1]}"`));
      }
    }

    const failures = [...keys].sort().flatMap((key) => {
      const translated = translate("ru", key);
      const problems: string[] = [];
      if (!hasRussianTranslation(key)) problems.push("missing RU entry");
      if (placeholders(translated).join(",") !== placeholders(key).join(",")) {
        problems.push(`placeholder mismatch: ${placeholders(translated)} != ${placeholders(key)}`);
      }
      if (/\uFFFD|Ã|Â|Ð|Ñ|Р[°±µ¶·ё№є»Ѕѕї]|С[Ђѓ„…†‡€‰Љљ‹ЊњЌќЋћЏџ‚]/u.test(translated)) {
        problems.push("mojibake");
      }
      return problems.map((problem) => `${key}: ${problem}`);
    });

    expect(failures).toEqual([]);
  });

  it("keeps the W90 UTC disclosure while formatting its date for Russian", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="ru">
        <LiveUtcProbe />
      </I18nProvider>,
    );
    const expectedDate = new Intl.DateTimeFormat("ru-RU", {
      dateStyle: "medium",
      timeStyle: "medium",
      timeZone: "UTC",
    }).format(new Date("2026-08-21T12:34:56.000Z"));

    expect(markup).toContain("Дневной лимит запусков сбросится");
    expect(markup).toContain(expectedDate);
    expect(markup).toContain("UTC");
  });

  it("falls back to the English source key when a Russian W90 key is unknown", () => {
    expect(translate("ru", "Unknown live acquisition label {code}", { code: "X" }))
      .toBe("Unknown live acquisition label X");
  });
});
