import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
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
      "That browser tab is no longer available. Refresh Open tabs and try again.",
    );
    known.name = "ExtensionBridgeError";
    expect(localizedErrorMessage("ru", known)).toBe(
      "Эта вкладка браузера больше недоступна. Обновите список открытых вкладок и повторите попытку.",
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
});
