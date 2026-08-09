import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type Locale = "en" | "ru";
export type TranslationParams = Record<string, number | string>;

type Message = string | ((params: TranslationParams) => string);

const STORAGE_KEY = "tabhub.locale";
const PAGE_DESCRIPTION =
  "TabHub keeps tabs from all of your browsers in one local workspace.";
const LOCALE_TAGS: Record<Locale, string> = {
  en: "en-US",
  ru: "ru-RU",
};

function numericParam(params: TranslationParams, key = "count"): number {
  const value = params[key];
  return typeof value === "number" ? value : Number(value ?? 0);
}

function russianPlural(
  value: number,
  one: string,
  few: string,
  many: string,
): string {
  const absolute = Math.abs(value);
  const lastTwo = absolute % 100;
  const last = absolute % 10;

  if (lastTwo >= 11 && lastTwo <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

// English source copy doubles as the fallback key. Keeping every Russian
// translation here makes missing copy easy to audit and avoids component-local
// locale branches.
const russianMessages: Record<string, Message> = {
  "{action} for {tab}": "{action} для «{tab}»",
  "{count} selected": "Выбрано: {count}",
  "{count}d ago": "{count} дн назад",
  "{count}h ago": "{count} ч назад",
  "{count}m ago": "{count} мин назад",
  "{count}mo ago": "{count} мес назад",
  "{count}y ago": "{count} г назад",
  "{first}-{last} of {total}": "{first}–{last} из {total}",
  "0 - Unrated": "0 — Без оценки",
  "0 tabs": "0 вкладок",
  "1 - Low": "1 — Низкая",
  "2 - Medium": "2 — Средняя",
  "3 - High": "3 — Высокая",
  Age: "Возраст",
  Agent: "Агент",
  "Add field": "Добавить поле",
  "All browsers": "Все браузеры",
  "All statuses": "Все статусы",
  "All tabs": "Все вкладки",
  "Any importance": "Любая важность",
  "API unavailable": "API недоступен",
  "Apply status": "Применить статус",
  Archived: "В архиве",
  Assign: "Назначить",
  "Assigned by {source}": "Назначено: {source}",
  "Assign a tag to start your topic tree.":
    "Назначьте тег, чтобы создать дерево тем.",
  "Assign tag": "Назначить тег",
  Browser: "Браузер",
  "Browser tabs": "Вкладки браузеров",
  "Bulk tab actions": "Массовые действия с вкладками",
  "Check summary status": "Проверить статус сводки",
  Clear: "Очистить",
  "Close tab details": "Закрыть сведения о вкладке",
  "Clear filters": "Сбросить фильтры",
  Closed: "Закрыта",
  "Closed only": "Только закрытые",
  Collapse: "Свернуть",
  "Collection unavailable": "Коллекция недоступна",
  "Connect a browser extension to fill this workspace.":
    "Подключите расширение браузера, чтобы наполнить это пространство.",
  Connecting: "Подключение",
  "Connected to another browser. Click a tab title to switch to that existing tab.":
    "Подключено к другому браузеру. Нажмите заголовок вкладки, чтобы переключиться на неё.",
  "Create link": "Создать связь",
  "Custom fields": "Произвольные поля",
  "Couldn't load tabs": "Не удалось загрузить вкладки",
  "Create short summary": "Создать краткую сводку",
  "Creating summary": "Создание сводки",
  "Directed links under {tag} and its descendants.":
    "Направленные связи в теме {tag} и её дочерних темах.",
  Done: "Готово",
  Delete: "Удалить",
  Direction: "Направление",
  Language: "Язык",
  English: "English",
  "Every physical browser tab, including repeated URLs.":
    "Все физические вкладки браузеров, включая повторяющиеся URL.",
  Expand: "Развернуть",
  "Explore relationships across every captured tab.":
    "Исследуйте связи между всеми сохранёнными вкладками.",
  "Filter tabs by topic": "Фильтр вкладок по теме",
  Filters: "Фильтры",
  "Field name": "Название поля",
  Graph: "Граф",
  Importance: "Важность",
  Incoming: "Входящая",
  "Importance {level} of 3": "Важность: {level} из 3",
  Inbox: "Входящие",
  "In progress": "В работе",
  "Just now": "Только что",
  Kind: "Тип",
  "Knowledge graph": "Граф знаний",
  Library: "Библиотека",
  Links: "Связи",
  "Loading collection": "Загрузка коллекции",
  "Loading graph view": "Загрузка графа",
  "Loading links...": "Загрузка связей...",
  "Loading tab details": "Загрузка сведений о вкладке",
  "Loading topics...": "Загрузка тем...",
  "Loading your tabs": "Загрузка вкладок",
  "Local collection": "Локальная коллекция",
  Next: "Следующая",
  "No tabs match these filters": "Нет вкладок, подходящих под фильтры",
  "No tabs yet": "Вкладок пока нет",
  "No captured content.": "Сохранённого содержимого нет.",
  "No summary yet.": "Сводки пока нет.",
  "No tags assigned.": "Теги не назначены.",
  Note: "Примечание",
  Open: "Открыта",
  "Open in browser": "Открыть в браузере",
  "Open & closed": "Открытые и закрытые",
  "Open {tab} in browser": "Открыть «{tab}» в браузере",
  "Open only": "Только открытые",
  "Open tab details": "Открыть сведения о вкладке",
  "Open tabs": "Открытые вкладки",
  Organize: "Организация",
  Other: "Другой",
  "another browser": "другом браузере",
  "Optional context": "Необязательный контекст",
  "Optional value": "Необязательное значение",
  Outgoing: "Исходящая",
  "Page {page} of {total}": "Страница {page} из {total}",
  "Preparing the interactive canvas...": "Подготовка интерактивного полотна...",
  Previous: "Предыдущая",
  "Reading the local collection...": "Чтение локальной коллекции...",
  "Refresh short summary": "Обновить краткую сводку",
  Refreshing: "Обновление",
  "Requesting summary": "Запрос сводки",
  "Research/AI": "Исследования/ИИ",
  "Research/AI/Agents": "Исследования/ИИ/Агенты",
  "Related tab ID": "ID связанной вкладки",
  "Remove {tag}, assigned by {source}":
    "Удалить тег {tag}, назначенный: {source}",
  Retry: "Повторить",
  "Retry short summary": "Повторить создание сводки",
  Russian: "Русский",
  Save: "Сохранить",
  "Save link": "Сохранить связь",
  "Search tab titles and content": "Поиск по заголовкам и содержимому",
  "Search titles and content": "Найти заголовки и содержимое",
  "Select {tab}": "Выбрать «{tab}»",
  "Select all tabs on this page": "Выбрать все вкладки на этой странице",
  "Show all {count} characters": "Показать все символы: {count}",
  "Show compact view": "Показать сокращённо",
  "Something went wrong.": "Что-то пошло не так.",
  "Source to this tab": "От исходной вкладки к этой",
  State: "Состояние",
  Status: "Статус",
  "Summary queued": "Сводка поставлена в очередь",
  "Summary ready": "Сводка готова",
  Tab: "Вкладка",
  "Tab #{id}": "Вкладка №{id}",
  "Tab details | #{id}": "Сведения о вкладке | №{id}",
  "Tab knowledge graph": "Граф знаний вкладок",
  "Tab list pages": "Страницы списка вкладок",
  "Tab state": "Состояние вкладки",
  "TabHub could not create this summary.": "TabHub не удалось создать эту сводку.",
  "Tabs captured from every connected browser.":
    "Вкладки, сохранённые из всех подключённых браузеров.",
  "Tabs collected from connected browsers":
    "Вкладки, собранные из подключённых браузеров",
  "Tabs filed under {tag} and its descendants.":
    "Вкладки в теме {tag} и её дочерних темах.",
  "Tag path": "Путь тега",
  Tags: "Теги",
  "This tab to target": "От этой вкладки к целевой",
  Topics: "Темы",
  "Try again": "Повторить",
  "Try another search, topic, browser, or tab state.":
    "Измените запрос, тему, браузер или состояние вкладки.",
  Unknown: "Неизвестно",
  User: "Пользователь",
  Value: "Значение",
  "Value for {field}": "Значение поля {field}",
  "Why are these tabs connected?": "Почему эти вкладки связаны?",
  "Workflow status": "Рабочий статус",
  Workspace: "Пространство",
  "Workspace view": "Представление пространства",
  "Your browsers, one workspace": "Все браузеры — в одном пространстве",
  owner: "владелец",
  "{count} tabs": (params) => {
    const count = numericParam(params, "rawCount");
    return `${params.count} ${russianPlural(count, "вкладка", "вкладки", "вкладок")}`;
  },
  "{count} nodes": (params) => {
    const count = numericParam(params, "rawCount");
    return `${params.count} ${russianPlural(count, "узел", "узла", "узлов")}`;
  },
  "{count} links": (params) => {
    const count = numericParam(params, "rawCount");
    return `${params.count} ${russianPlural(count, "связь", "связи", "связей")}`;
  },
  "{count} topic groups": (params) => {
    const count = numericParam(params, "rawCount");
    return `${params.count} ${russianPlural(count, "группа тем", "группы тем", "групп тем")}`;
  },
  inbox: "входящие",
  "in progress": "в работе",
  done: "готово",
  archived: "в архиве",
  open: "открыта",
  closed: "закрыта",
  "{title}, {status}, importance {importance}":
    "{title}, {status}, важность {importance}",
  "{count} controllable here": "Доступно для управления здесь: {count}",
  "{count} selected tabs are already excluded by the preview.":
    "Уже исключено при проверке: {count}",
  "{message} Restore controls remain locked; verify the browser tabs before reloading TabHub.":
    "{message} Восстановление остаётся заблокированным; проверьте вкладки браузера перед перезагрузкой TabHub.",
  "Pinned, changed, TabHub control tabs, and exact-copy keepers are protected and rechecked immediately before closing.":
    "Закреплённые и изменённые вкладки, управляющие вкладки TabHub и сохраняемые точные копии защищены и повторно проверяются непосредственно перед закрытием.",
  "Branch from {title} | {count} nodes": "Ветка от {title} | узлов: {count}",
  "Capture tabs to start building the knowledge graph.":
    "Сохраните вкладки, чтобы начать строить граф знаний.",
  "Captured content": "Сохранённое содержимое",
  "Choose another topic or assign tabs to this branch.":
    "Выберите другую тему или назначьте вкладки этой ветке.",
  "Clear branch": "Сбросить ветку",
  Close: "Закрыть",
  "Close {count} tabs?": (params) => {
    const count = numericParam(params, "rawCount");
    return `Закрыть ${params.count} ${russianPlural(count, "вкладку", "вкладки", "вкладок")}?`;
  },
  "Close {count} extra exact copies?": (params) => {
    const count = numericParam(params, "rawCount");
    return `Закрыть ${params.count} ${russianPlural(count, "лишнюю точную копию", "лишние точные копии", "лишних точных копий")}?`;
  },
  "Close duplicate copies": "Закрыть дубликаты",
  "TabHub will keep at least one copy in each of {groups} exact-URL groups and close the extras across {profiles} connected browser profiles.":
    "TabHub оставит минимум по одной копии в каждой из {groups} групп с одинаковым полным URL и закроет лишние вкладки в {profiles} подключённых профилях браузеров.",
  "{copies} extra copies in {groups} unavailable groups will not be closed.":
    "Не будут закрыты лишние копии ({copies}) в недоступных группах ({groups}).",
  "{copies} pinned copies in {groups} groups will remain open.":
    "Останутся открытыми закреплённые копии ({copies}) в группах ({groups}).",
  "{count} ready to close": "Готово к закрытию: {count}",
  "Browser profiles finish independently; if one disconnects, the others may still complete.":
    "Профили браузеров выполняют операцию независимо: если один отключится, остальные всё равно могут завершить закрытие.",
  "Excluded from this cleanup": "Исключено из этой очистки",
  "{groups} groups · {copies} copies":
    "Групп: {groups} · копий: {copies}",
  "Browser profile offline": "Профиль браузера не подключён",
  "Stale or incomplete tab snapshot": "Устаревший или неполный снимок вкладок",
  "Live preview expired": "Срок live preview истёк",
  "Tabs changed during live preview": "Вкладки изменились во время live preview",
  "Live preview unavailable": "Live preview недоступен",
  "No browser profile passed the live duplicate check. No tabs can be closed.":
    "Ни один профиль браузера не прошёл live-проверку дубликатов. Закрытие вкладок недоступно.",
  "Close all duplicates ({count})…": "Закрыть все дубликаты ({count})…",
  "Close all matching duplicates ({count})…":
    "Закрыть все найденные дубликаты ({count})…",
  "Checking every duplicate group…": "Проверяем все группы дубликатов…",
  "Close all duplicates from {group} ({count})…":
    "Закрыть все дубликаты группы «{group}» ({count})…",
  "Close {count} unpinned duplicates…":
    "Закрыть незакреплённые дубликаты ({count})…",
  "Close {count} unpinned duplicates from {group}…":
    "Закрыть незакреплённые дубликаты группы «{group}»: {count}…",
  "Close {count}…": "Закрыть: {count}…",
  "Close tabs": "Закрыть вкладки",
  "Color by": "Цвет по",
  "Copy JSON": "Копировать JSON",
  "Copy Markdown": "Копировать Markdown",
  "Copy URLs": "Копировать URL",
  "Couldn't load graph": "Не удалось загрузить граф",
  "Delete workspace “{name}”?": "Удалить пространство «{name}»?",
  "Destructive browser action": "Необратимое действие в браузере",
  "Exact hostname": "Точное имя хоста",
  "Extra exact copies": "Лишние точные копии",
  focused: "в фокусе",
  "Graph color mode": "Режим окраски графа",
  "Inactive for {count} days": (params) => {
    const count = numericParam(params, "rawCount");
    return `Неактивны ${params.count} ${russianPlural(count, "день", "дня", "дней")}`;
  },
  "Loading graph": "Загрузка графа",
  "Loading workspaces…": "Загрузка пространств…",
  More: "Ещё",
  Move: "Переместить",
  "Move destination": "Куда переместить",
  Mute: "Отключить звук",
  "New window": "Новое окно",
  "No graph nodes yet": "В графе пока нет узлов",
  "No saved workspaces yet.": "Сохранённых пространств пока нет.",
  "No tabs in this topic": "В этой теме нет вкладок",
  "Open here": "Открыть здесь",
  "Opening...": "Открытие...",
  "Open-tab bulk actions": "Массовые действия с открытыми вкладками",
  "Page state warning": "Предупреждение о состоянии страницы",
  Pin: "Закрепить",
  "Reading tabs, topics, and links...": "Чтение вкладок, тем и связей...",
  "Reload {count} tabs?": (params) => {
    const count = numericParam(params, "rawCount");
    return `Перезагрузить ${params.count} ${russianPlural(count, "вкладку", "вкладки", "вкладок")}?`;
  },
  "Reload tabs": "Перезагрузить вкладки",
  "Reload…": "Перезагрузить…",
  "Reloading can discard unsaved form edits and in-page state. The TabHub control tab is protected.":
    "Перезагрузка может сбросить несохранённые изменения форм и состояние страницы. Управляющая вкладка TabHub защищена.",
  Rename: "Переименовать",
  "Save & close…": "Сохранить и закрыть…",
  "Save as workspace…": "Сохранить как пространство…",
  "Saved sessions": "Сохранённые сеансы",
  Select: "Выбрать",
  "Select a node to trace its outgoing follows branch.":
    "Выберите узел, чтобы проследить исходящую ветку связей follows.",
  "Select host": "Выбрать хост",
  Sleep: "Усыпить",
  "This TabHub window": "Это окно TabHub",
  "This TabHub window ({id})": "Это окно TabHub ({id})",
  Unmute: "Включить звук",
  Unpin: "Открепить",
  "Visible page": "Текущая страница",
  "All filtered results": "Все результаты фильтра",
  "Window {id} · {count} tabs": "Окно {id} · вкладок: {count}",
  "Working…": "Выполнение…",
  "Workspace name": "Название пространства",
  Workspaces: "Пространства",
  Cancel: "Отмена",
  "{count} exact copies": (params) => {
    const count = numericParam(params, "rawCount");
    return `${params.count} ${russianPlural(count, "точная копия", "точные копии", "точных копий")}`;
  },
  "{count} physical tabs open": "Открытых физических вкладок: {count}",
  "{count} selected in {browser} · installation {id}":
    "Выбрано: {count} · {browser} · установка {id}",
  "{browser} · installation {id}": "{browser} · установка {id}",
  "{kind}: {succeeded} succeeded · {skipped} skipped · {failed} failed":
    "{kind}: успешно — {succeeded} · пропущено — {skipped} · ошибок — {failed}",
  "0 physical tabs": "0 физических вкладок",
  Active: "Активна",
  "Active and pinned tabs can still appear when they belong to a duplicate group.":
    "Активные и закреплённые вкладки могут отображаться, если входят в группу дубликатов.",
  "Browser location": "Расположение в браузере",
  "Browser profile": "Профиль браузера",
  "Checking extension": "Проверка расширения",
  "Checking connected TabHub extensions.":
    "Проверка подключённых расширений TabHub.",
  "Checking connected TabHub extensions...":
    "Проверка подключённых расширений TabHub...",
  "Checking the local TabHub extension.": "Проверка локального расширения TabHub.",
  "Checking the local TabHub extension...": "Проверка локального расширения TabHub...",
  "Checking...": "Проверка...",
  "Choose this extension's browser identity before switching tabs.":
    "Перед переключением вкладок выберите браузер для этой установки расширения.",
  "Clipboard access failed.": "Не удалось получить доступ к буферу обмена.",
  close: "закрытие",
  "Connected to {browser}. Click a tab title to switch to that existing tab.":
    "Подключено к {browser}. Нажмите заголовок, чтобы перейти к существующей вкладке.",
  "{count} browser profiles connected. TabHub can control tabs in any connected profile.":
    "Подключено профилей браузера: {count}. TabHub может управлять вкладками в любом подключённом профиле.",
  "{count} browser profiles connected for duplicate closing. Switching to a tab still requires TabHub in its browser.":
    "Подключено профилей браузера для закрытия дублей: {count}. Для перехода к вкладке TabHub пока должен быть открыт в её браузере.",
  "Copied {count} tabs as {format}.": "Скопировано вкладок: {count} ({format}).",
  "Duplicate cleanup: {succeeded} closed · {skipped} skipped · {failed} failed · {notRun} profiles not completed · {unknown} profiles unknown":
    "Очистка дубликатов: закрыто {succeeded} · пропущено {skipped} · ошибок {failed} · профилей без завершения {notRun} · профилей с неизвестным результатом {unknown}",
  "{copies} copies in {groups} groups were unavailable or changed.":
    "Недоступны или изменились копии ({copies}) в группах ({groups}).",
  "{browser} · installation {id}: {closed} closed · {skipped} skipped · {failed} failed":
    "{browser} · установка {id}: закрыто {closed} · пропущено {skipped} · ошибок {failed}",
  "{browser} · installation {id}: result unknown for {count} tabs. Do not retry automatically.":
    "{browser} · установка {id}: результат для {count} вкладок неизвестен. Не повторяйте операцию автоматически.",
  "{browser} · installation {id}: close did not complete for {count} tabs. Refresh and check again.":
    "{browser} · установка {id}: закрытие {count} вкладок не выполнено. Обновите данные и повторите проверку.",
  "Couldn't load duplicate groups": "Не удалось загрузить группы дубликатов",
  "Couldn't load open tabs": "Не удалось загрузить открытые вкладки",
  Details: "Сведения",
  discard: "усыпление",
  "Every open occurrence is listed, including exact copies.":
    "Показан каждый открытый экземпляр, включая точные копии.",
  "Every physical tab currently reported by connected browsers":
    "Все физические вкладки, о которых сообщили подключённые браузеры",
  "Exact duplicate groups and their physical tab copies":
    "Группы точных дубликатов и их физические вкладки",
  "Exact duplicate group": "Группа точных дубликатов",
  "Exact URLs are grouped together. TabHub shows the kept copy first, then every duplicate that points to it.":
    "Полностью одинаковые URL собраны в группы. Сначала показана копия, которую TabHub оставит, затем все её дубликаты.",
  "To close the kept copy, including an active tab, choose Keep this copy on another row first.":
    "Чтобы закрыть сохраняемую копию, в том числе активную вкладку, сначала нажмите «Оставить эту копию» в другой строке.",
  "Exact copies": "Точные копии",
  "Exact duplicates only": "Только точные дубликаты",
  "Role in group": "Роль в группе",
  "State / protection": "Состояние / защита",
  "Keep this copy": "Оставить",
  "Keep this copy instead": "Оставить эту копию",
  "Keeper for this exact URL": "Сохраняемая копия этого точного URL",
  "Duplicate of kept copy": "Дубликат сохраняемой копии",
  "Kept copy: {location}": "Сохраняемая копия: {location}",
  "Protected duplicate": "Защищённый дубликат",
  "Pinned; kept copy: {location}":
    "Закреплена; сохраняемая копия: {location}",
  "Installation {id}": "Установка {id}",
  "{count} open copies": (params) => {
    const count = numericParam(params, "rawCount");
    return `${params.count} ${russianPlural(count, "открытая копия", "открытые копии", "открытых копий")}`;
  },
  "After closing, {count} pinned copies will remain.":
    "После закрытия останется закреплённых копий: {count}.",
  "Open TabHub in this browser profile to close this group.":
    "Откройте TabHub в профиле браузера этой группы, чтобы закрыть её дубликаты.",
  "The browser extension that owns this group is offline. Keep that browser open and reload the updated extension.":
    "Расширение браузера этой группы не подключено. Оставьте браузер запущенным и перезагрузите обновлённое расширение.",
  "This duplicate group has stale or incomplete browser identity. Refresh after its browser syncs again.":
    "У группы устарели или неполны данные сессии браузера. Обновите список после следующей синхронизации браузера.",
  "Preview closing every extra copy in this group":
    "Предпросмотр закрытия всех лишних копий этой группы",
  "Select {count} extra copies": "Выбрать лишние копии: {count}",
  "Select {count} extra copies from {group}":
    "Выбрать лишние копии группы «{group}»: {count}",
  "The duplicate group changed. Refresh the list and try again; no tabs will be closed.":
    "Группа дубликатов изменилась. Обновите список и повторите попытку; вкладки не будут закрыты.",
  "No connected browser profile can close any matching duplicate group.":
    "Ни один подключённый профиль браузера не может закрыть найденные дубликаты.",
  "Every connected duplicate preview changed. Refresh and try again.":
    "Все проверенные группы дубликатов изменились. Обновите список и повторите попытку.",
  "The live duplicate preview expired. Run the check again; no tabs were closed.":
    "Проверка дубликатов устарела. Запустите её снова; вкладки не были закрыты.",
  "TabHub returned an incomplete close result. The outcome is unknown.":
    "TabHub получил неполный результат закрытия. Итог операции неизвестен.",
  "This duplicate group changed or is not controllable. Refresh and try again.":
    "Эта группа дубликатов изменилась или недоступна для управления. Обновите список и повторите попытку.",
  "This group has no closable extra copies.":
    "В этой группе нет лишних копий, доступных для закрытия.",
  "0 duplicate groups": "0 групп дубликатов",
  "{first}-{last} of {groups} groups · {tabs} tabs · {copies} extra copies":
    "{first}–{last} из {groups} групп · вкладок: {tabs} · лишних копий: {copies}",
  "Extension unavailable": "Расширение недоступно",
  "Identity required": "Требуется выбрать браузер",
  "Live browser state": "Текущее состояние браузера",
  "Loading every open tab": "Загрузка всех открытых вкладок",
  "Loading duplicate groups": "Загрузка групп дубликатов",
  "Keeping every exact-copy group together...":
    "Собираем каждую группу точных копий целиком...",
  "Loading open tabs": "Загрузка открытых вкладок",
  move: "перемещение",
  Muted: "Без звука",
  "No exact duplicates match": "Подходящих точных дубликатов нет",
  "No connected browser profiles": "Нет подключённых профилей браузера",
  "No connected TabHub extension can control this browser profile.":
    "Ни одно подключённое расширение TabHub не может управлять этим профилем браузера.",
  "No single connected browser profile owns every selected tab.":
    "Выбранные вкладки не принадлежат одному подключённому профилю браузера.",
  "A group appears only when at least two tabs have the same full URL in one browser installation.":
    "Группа появляется, только когда минимум две вкладки имеют полностью одинаковый URL в одной установке браузера.",
  "No open tabs match": "Подходящих открытых вкладок нет",
  "Open tab": "Открытая вкладка",
  "Open TabHub in that browser and reload the updated extension to switch tabs.":
    "Откройте TabHub в этом браузере и перезагрузите обновлённое расширение для переключения вкладок.",
  "Open TabHub in the browser profile that owns these tabs.":
    "Откройте TabHub в профиле браузера, которому принадлежат эти вкладки.",
  "Open TabHub in the browser profile that owns this tab to switch to it.":
    "Откройте TabHub в профиле браузера этой вкладки, чтобы переключиться на неё.",
  "This tab's browser profile is not connected.":
    "Профиль браузера этой вкладки не подключён.",
  "Open TabHub in the target browser and reload the updated extension to switch tabs.":
    "Откройте TabHub в целевом браузере и перезагрузите обновлённое расширение для переключения вкладок.",
  "Opened {opened} workspace tabs; failed {failed}.":
    "Открыто вкладок пространства: {opened}; ошибок: {failed}.",
  "Open-tab list pages": "Страницы списка открытых вкладок",
  "Duplicate group pages": "Страницы групп дубликатов",
  "Other installation": "Другая установка",
  "Physical open tabs": "Физические открытые вкладки",
  Pinned: "Закреплена",
  Playing: "Воспроизводит звук",
  Protection: "Защита",
  "Reading physical browser occurrences...":
    "Чтение физических экземпляров вкладок...",
  "Reading physical tabs...": "Чтение физических вкладок...",
  "Selection spans multiple browser profiles. Select one profile for browser actions.":
    "Выбраны вкладки из нескольких профилей браузера. Для действий выберите вкладки одного профиля.",
  "The selected browser profile is offline.":
    "Выбранный профиль браузера не подключён.",
  "Waiting for a fresh physical-tab snapshot for this selection.":
    "Ожидание свежего снимка физических вкладок для выбранных элементов.",
  "Recent closes available to undo": "Недавние закрытия можно отменить",
  "Re-check extension": "Проверить расширение снова",
  "Re-check extensions": "Проверить расширения снова",
  reload: "перезагрузка",
  "Reopen {count} tabs": (params) => {
    const count = numericParam(params, "rawCount");
    return `Открыть заново ${params.count} ${russianPlural(count, "вкладку", "вкладки", "вкладок")}`;
  },
  "Reopen {count} tabs in {browser} · installation {id}": (params) => {
    const count = numericParam(params, "rawCount");
    return `Открыть заново ${params.count} ${russianPlural(count, "вкладку", "вкладки", "вкладок")} в ${params.browser} · установка ${params.id}`;
  },
  "Reopen closed tabs": "Открыть закрытые вкладки заново",
  "Reopened {restored}; skipped {skipped}; failed {failed}.":
    "Открыто заново: {restored}; пропущено: {skipped}; ошибок: {failed}.",
  "Retry {count} failed": "Повторить неудачные: {count}",
  "Saved “{name}” with {count} tabs.":
    "Пространство «{name}» сохранено; вкладок: {count}.",
  "Search open tab titles and URLs": "Поиск по заголовкам и URL открытых вкладок",
  "Search open titles and URLs": "Найти открытые вкладки по заголовкам и URL",
  "Select all open tabs on this page":
    "Выбрать все открытые вкладки на этой странице",
  "Select all closable duplicate copies on this page":
    "Выбрать все доступные для закрытия дубликаты на этой странице",
  "Select all copies in duplicate groups on this page":
    "Выбрать все копии в группах дубликатов на этой странице",
  "set-muted": "изменение звука",
  "set-pinned": "изменение закрепления",
  Sleeping: "Выгружена",
  Standard: "Обычная",
  Summary: "Сводка",
  "Switch to existing tab: {label}": "Перейти к существующей вкладке: {label}",
  "Switch to this existing browser tab": "Перейти к этой существующей вкладке браузера",
  "Switching...": "Переключение...",
  "tab {tabId}": "вкладка {tabId}",
  "The extension activated a different physical tab than requested.":
    "Расширение активировало другую физическую вкладку.",
  "The extension browser session changed during the action.":
    "Во время действия изменилась сессия браузера расширения.",
  "This browser action requires TabHub in the owning browser profile.":
    "Для этого действия TabHub должен быть открыт в профиле браузера-владельца.",
  "This action is unavailable through the connected browser relay.":
    "Это действие недоступно через подключённый браузерный канал.",
  "The extension returned a result for a different command.":
    "Расширение вернуло результат другой команды.",
  Unique: "Уникальная",
  "unknown tab": "неизвестная вкладка",
  "Wait for a connected extension to send its next snapshot.":
    "Дождитесь следующего снимка от подключённого расширения.",
  "Waiting for a fresh snapshot from this browser session.":
    "Ожидание свежего снимка из этой сессии браузера.",
  "Waiting for an updated physical-tab snapshot.":
    "Ожидание обновлённого снимка физических вкладок.",
  "Waiting for current session": "Ожидание текущей сессии",
  "Waiting for snapshot": "Ожидание снимка",
  "Window {windowId} | position {position} | {tab}":
    "Окно {windowId} | позиция {position} | {tab}",
  Chrome: "Chrome",
  Edge: "Edge",
  Yandex: "Yandex",
  "Every extra copy is pinned, so TabHub will keep it open.":
    "Все лишние копии закреплены, поэтому TabHub оставит их открытыми.",
  "Open TabHub in {browser} to close these duplicates.":
    "Откройте TabHub в {browser}, чтобы закрыть эти дубликаты.",
  "TabHub extension is not connected to this page.":
    "Расширение TabHub не подключено к этой странице.",
  "Untagged": "Без тегов",
  "this browser": "этом браузере",
  "TabHub could not load tabs": "TabHub не удалось загрузить вкладки",
  "TabHub returned an unreadable tab list.":
    "TabHub вернул нечитаемый список вкладок.",
  "TabHub could not load all open tabs":
    "TabHub не удалось загрузить все открытые вкладки",
  "TabHub returned an unreadable bulk open-tab list.":
    "TabHub вернул нечитаемый полный список открытых вкладок.",
  "TabHub returned an unexpected bulk open-tab list.":
    "TabHub вернул неожиданный полный список открытых вкладок.",
  "TabHub could not load open tabs":
    "TabHub не удалось загрузить открытые вкладки",
  "TabHub returned an unreadable open-tab list.":
    "TabHub вернул нечитаемый список открытых вкладок.",
  "TabHub returned an unexpected open-tab list.":
    "TabHub вернул неожиданный список открытых вкладок.",
  "TabHub could not load exact duplicate groups":
    "TabHub не удалось загрузить группы точных дубликатов",
  "TabHub returned an unreadable duplicate-group list.":
    "TabHub вернул нечитаемый список групп дубликатов.",
  "TabHub could not load every exact duplicate group":
    "TabHub не удалось загрузить все группы точных дубликатов",
  "TabHub returned an unreadable bulk duplicate-group list.":
    "TabHub вернул нечитаемый полный список групп дубликатов.",
  "TabHub returned an unexpected bulk duplicate-group list.":
    "TabHub вернул неожиданный полный список групп дубликатов.",
  "TabHub could not load saved workspaces":
    "TabHub не удалось загрузить сохранённые пространства",
  "TabHub returned unreadable saved workspaces.":
    "TabHub вернул нечитаемый список сохранённых пространств.",
  "TabHub returned unexpected saved workspaces.":
    "TabHub вернул неожиданный список сохранённых пространств.",
  "TabHub could not load this workspace":
    "TabHub не удалось загрузить это пространство",
  "TabHub could not save this workspace":
    "TabHub не удалось сохранить это пространство",
  "TabHub could not rename this workspace":
    "TabHub не удалось переименовать это пространство",
  "TabHub returned an unreadable workspace.":
    "TabHub вернул нечитаемые данные пространства.",
  "TabHub could not delete this workspace":
    "TabHub не удалось удалить это пространство",
  "TabHub returned an unreadable deletion result.":
    "TabHub вернул нечитаемый результат удаления.",
  "TabHub could not load tags": "TabHub не удалось загрузить теги",
  "TabHub returned an unreadable tag tree.":
    "TabHub вернул нечитаемое дерево тегов.",
  "TabHub could not load the graph": "TabHub не удалось загрузить граф",
  "TabHub returned an unreadable graph.": "TabHub вернул нечитаемый граф.",
  "TabHub could not load this tab": "TabHub не удалось загрузить эту вкладку",
  "TabHub returned unreadable tab details.":
    "TabHub вернул нечитаемые сведения о вкладке.",
  "TabHub could not update this tab": "TabHub не удалось обновить эту вкладку",
  "TabHub returned an unreadable tab update.":
    "TabHub вернул нечитаемый результат обновления вкладки.",
  "TabHub returned an unexpected tab update.":
    "TabHub вернул неожиданный результат обновления вкладки.",
  "TabHub could not update the selected tabs":
    "TabHub не удалось обновить выбранные вкладки",
  "TabHub returned an unreadable bulk update.":
    "TabHub вернул нечитаемый результат массового обновления.",
  "TabHub returned an unexpected bulk update.":
    "TabHub вернул неожиданный результат массового обновления.",
  "TabHub could not assign this tag": "TabHub не удалось назначить этот тег",
  "TabHub returned an unreadable tag update.":
    "TabHub вернул нечитаемый результат обновления тега.",
  "TabHub returned an unexpected tag update.":
    "TabHub вернул неожиданный результат обновления тега.",
  "TabHub could not remove this tag": "TabHub не удалось удалить этот тег",
  "TabHub returned an unreadable tag removal.":
    "TabHub вернул нечитаемый результат удаления тега.",
  "TabHub could not load links": "TabHub не удалось загрузить связи",
  "TabHub returned unreadable links.": "TabHub вернул нечитаемые связи.",
  "TabHub could not create this link": "TabHub не удалось создать эту связь",
  "TabHub returned an unreadable link.": "TabHub вернул нечитаемую связь.",
  "TabHub could not update this link": "TabHub не удалось обновить эту связь",
  "TabHub returned an unreadable link update.":
    "TabHub вернул нечитаемый результат обновления связи.",
  "TabHub returned an unexpected link update.":
    "TabHub вернул неожиданный результат обновления связи.",
  "TabHub could not delete this link": "TabHub не удалось удалить эту связь",
  "TabHub returned an unreadable link deletion.":
    "TabHub вернул нечитаемый результат удаления связи.",
  "TabHub could not queue this summary":
    "TabHub не удалось поставить сводку в очередь",
  "TabHub returned an unreadable summary response.":
    "TabHub вернул нечитаемый ответ на запрос сводки.",
  "TabHub could not read this summary job":
    "TabHub не удалось прочитать задание сводки",
  "TabHub returned an unreadable summary job.":
    "TabHub вернул нечитаемое задание сводки.",
  "Tab switching timed out. The outcome is unknown and the switch may still complete.":
    "Время ожидания переключения истекло. Результат неизвестен, и переключение ещё может завершиться.",
  "The browser action timed out. Its outcome is unknown and it may still complete.":
    "Время ожидания действия в браузере истекло. Результат неизвестен, и действие ещё может завершиться.",
  "The owning browser extension is offline. Keep the browser open and wait for it to reconnect.":
    "Расширение браузера-владельца не подключено. Оставьте браузер запущенным и дождитесь переподключения.",
  "The browser connection was lost after dispatch. The outcome is unknown; the tab list was refreshed and this confirmation cannot be retried.":
    "Связь с браузером оборвалась после отправки команды. Результат неизвестен; список вкладок обновлён, а это подтверждение нельзя повторить.",
  "The owning browser extension could not complete this command.":
    "Расширению браузера-владельца не удалось выполнить команду.",
  "TabHub extension did not answer in time.":
    "Расширение TabHub не ответило вовремя.",
  "TabHub extension returned an invalid probe response.":
    "Расширение TabHub вернуло некорректный ответ проверки.",
  "TabHub extension returned an invalid tab-command result.":
    "Расширение TabHub вернуло некорректный результат команды.",
  "TabHub extension returned an invalid close preview.":
    "Расширение TabHub вернуло некорректный предварительный расчёт закрытия.",
  "TabHub extension returned an invalid close-undo result.":
    "Расширение TabHub вернуло некорректный результат отмены закрытия.",
  "TabHub extension returned an invalid workspace-open result.":
    "Расширение TabHub вернуло некорректный результат открытия пространства.",
  "TabHub extension returned an invalid mutation receipt.":
    "Расширение TabHub вернуло некорректный отчёт об изменении.",
  "TabHub extension returned an invalid tab-command response.":
    "Расширение TabHub вернуло некорректный ответ на команду.",
  "TabHub extension returned an invalid tab-activation result.":
    "Расширение TabHub вернуло некорректный результат активации вкладки.",
  "TabHub returned an unexpected tab list.":
    "TabHub вернул неожиданный список вкладок.",
  "TabHub returned an unexpected duplicate-group list.":
    "TabHub вернул неожиданный список групп дубликатов.",
  "TabHub returned an unexpected workspace.":
    "TabHub вернул неожиданные данные пространства.",
  "TabHub returned an unexpected tag tree.":
    "TabHub вернул неожиданное дерево тегов.",
  "TabHub returned an unexpected graph.": "TabHub вернул неожиданный граф.",
  "TabHub returned unexpected tab details.":
    "TabHub вернул неожиданные сведения о вкладке.",
  "TabHub returned an unexpected tag removal.":
    "TabHub вернул неожиданный результат удаления тега.",
  "TabHub returned unexpected links.": "TabHub вернул неожиданные связи.",
  "TabHub returned an unexpected link.": "TabHub вернул неожиданную связь.",
  "TabHub returned an unexpected link deletion.":
    "TabHub вернул неожиданный результат удаления связи.",
  "TabHub returned an unexpected summary response.":
    "TabHub вернул неожиданный ответ на запрос сводки.",
  "TabHub returned an unexpected summary job.":
    "TabHub вернул неожиданное задание сводки.",
  "TabHub extension returned an unknown tab-command result.":
    "Расширение TabHub вернуло неизвестный результат команды.",
  "Invalid physical tab activation target.":
    "Некорректная цель активации физической вкладки.",
  "Invalid physical tab command scope.":
    "Некорректная область команды для физических вкладок.",
  "Select at least one physical tab.":
    "Выберите хотя бы одну физическую вкладку.",
  "Physical tab targets must contain unique tab IDs.":
    "Цели физических вкладок должны содержать уникальные ID.",
  "Physical tab targets require their current exact URL.":
    "Для целей физических вкладок требуется их текущий точный URL.",
  "An exact-duplicate close keeper must be a different tab with the same exact URL.":
    "Сохраняемая при закрытии точная копия должна быть другой вкладкой с тем же точным URL.",
  "Invalid confirmed close preview.":
    "Некорректный подтверждённый предварительный расчёт закрытия.",
  "Invalid destination browser window.": "Некорректное целевое окно браузера.",
  "Invalid tab state value.": "Некорректное значение состояния вкладки.",
  "Invalid close undo identifier.": "Некорректный идентификатор отмены закрытия.",
  "A workspace must contain at least one tab.":
    "Пространство должно содержать хотя бы одну вкладку.",
  "Invalid workspace tab.": "Некорректная вкладка пространства.",
  "TabHub extension returned a result for a different command.":
    "Расширение TabHub вернуло результат для другой команды.",
  "TabHub extension rejected the request.":
    "Расширение TabHub отклонило запрос.",
  "Browser actions are available only from the local TabHub app.":
    "Действия с браузером доступны только из локального приложения TabHub.",
  "Choose this extension's browser identity in Browser settings before synchronizing tabs.":
    "Перед синхронизацией вкладок выберите браузер для этой установки расширения в настройках браузера.",
  "TabHub could not identify its browser window.":
    "TabHub не удалось определить окно браузера.",
  "TabHub could not identify the browser tab controlling this action.":
    "TabHub не удалось определить вкладку браузера, из которой выполняется это действие.",
  "That browser tab is no longer available. Refresh Open tabs and try again.":
    "Эта вкладка браузера больше недоступна. Обновите список открытых вкладок и повторите попытку.",
  "That browser tab changed while TabHub was switching to it.":
    "Эта вкладка браузера изменилась, пока TabHub переключался на неё.",
  "That tab belongs to a different browser installation or session. Open TabHub in that browser and try again.":
    "Эта вкладка принадлежит другой установке или сессии браузера. Откройте TabHub в том браузере и повторите попытку.",
  "TabHub could not generate a valid opaque id.":
    "TabHub не удалось создать корректный служебный идентификатор.",
  "This close is too large to store a quota-safe Undo journal entry.":
    "Это закрытие слишком велико, чтобы безопасно сохранить запись для отмены.",
  "That command belongs to a different browser installation or session.":
    "Эта команда относится к другой установке или сессии браузера.",
  "This close preview expired or belongs to a different browser session. Preview again.":
    "Предварительный расчёт закрытия истёк или относится к другой сессии браузера. Выполните его снова.",
  "This Undo expired or belongs to a different browser session.":
    "Срок действия отмены закрытия истёк либо она относится к другой сессии браузера.",
  "The TabHub page is not in a normal browser window.":
    "Страница TabHub открыта не в обычном окне браузера.",
  "The destination is not a normal browser window.":
    "Окно назначения не является обычным окном браузера.",
  "TabHub extension returned an invalid bridge response.":
    "Расширение TabHub вернуло некорректный ответ веб-интерфейсу.",
  "The browser extension could not complete this action.":
    "Расширению браузера не удалось выполнить это действие.",
  [PAGE_DESCRIPTION]:
    "TabHub собирает вкладки из всех ваших браузеров в одном локальном рабочем пространстве.",
};

function interpolate(template: string, params: TranslationParams): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(params, key) ? String(params[key]) : match,
  );
}

export function translate(
  locale: Locale,
  key: string,
  params: TranslationParams = {},
): string {
  const message = locale === "ru" ? russianMessages[key] : undefined;
  const template = message ?? key;
  return typeof template === "function"
    ? template(params)
    : interpolate(template, params);
}

export function hasRussianTranslation(key: string): boolean {
  return Object.hasOwn(russianMessages, key);
}

export function localizedErrorMessage(locale: Locale, cause: unknown): string {
  const message =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : translate(locale, "Something went wrong.");
  if (locale !== "ru") return message;
  if (hasRussianTranslation(message)) return translate(locale, message);

  const statusMatch = /^(.*) \((\d{3})\)\.$/.exec(message);
  if (statusMatch?.[1] && hasRussianTranslation(statusMatch[1])) {
    return `${translate(locale, statusMatch[1])} (${statusMatch[2]}).`;
  }

  if (/^TabHub extension did not answer the .+ request in time\.$/.test(message)) {
    return translate(locale, "TabHub extension did not answer in time.");
  }

  if (cause instanceof Error && cause.name === "TabCommandRelayClientError") {
    const relay = cause as Error & {
      code?: unknown;
      outcome?: unknown;
    };
    if (relay.outcome === "unknown") {
      return translate(
        locale,
        "The browser connection was lost after dispatch. The outcome is unknown; the tab list was refreshed and this confirmation cannot be retried.",
      );
    }
    if (relay.code === "SCOPE_OFFLINE") {
      return translate(
        locale,
        "The owning browser extension is offline. Keep the browser open and wait for it to reconnect.",
      );
    }
    return translate(
      locale,
      "The owning browser extension could not complete this command.",
    );
  }

  if (cause instanceof Error && cause.name === "ExtensionBridgeError") {
    if (/[А-Яа-яЁё]/.test(message)) return message;
    return translate(locale, "The browser extension could not complete this action.");
  }

  return message;
}

export function resolveLocale(
  storedLocale: string | null | undefined,
  languageTags: readonly string[],
): Locale {
  if (storedLocale === "en" || storedLocale === "ru") return storedLocale;
  for (const tag of languageTags) {
    const normalized = tag.toLocaleLowerCase();
    if (normalized.startsWith("ru")) return "ru";
    if (normalized.startsWith("en")) return "en";
  }
  return "en";
}

function detectLocale(): Locale {
  if (typeof window === "undefined") return "en";

  let storedLocale: string | null = null;
  try {
    storedLocale = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }

  const languageTags =
    typeof navigator === "undefined"
      ? []
      : navigator.languages.length > 0
        ? navigator.languages
        : [navigator.language];
  return resolveLocale(storedLocale, languageTags);
}

interface I18nContextValue {
  errorMessage: (cause: unknown) => string;
  formatDate: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => string;
  formatNumber: (value: number) => string;
  locale: Locale;
  localeTag: string;
  setLocale: (locale: Locale) => void;
  t: (key: string, params?: TranslationParams) => string;
}

const defaultContext: I18nContextValue = {
  errorMessage: (cause) => localizedErrorMessage("en", cause),
  formatDate: (value, options) =>
    new Intl.DateTimeFormat(LOCALE_TAGS.en, options).format(new Date(value)),
  formatNumber: (value) => new Intl.NumberFormat(LOCALE_TAGS.en).format(value),
  locale: "en",
  localeTag: LOCALE_TAGS.en,
  setLocale: () => undefined,
  t: (key, params = {}) => translate("en", key, params),
};

const I18nContext = createContext<I18nContextValue>(defaultContext);

export function I18nProvider({
  children,
  initialLocale,
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocale] = useState<Locale>(() => initialLocale ?? detectLocale());
  const localeTag = LOCALE_TAGS[locale];

  useEffect(() => {
    document.documentElement.lang = locale;
    document
      .querySelector<HTMLMetaElement>('meta[name="description"]')
      ?.setAttribute("content", translate(locale, PAGE_DESCRIPTION));
    try {
      window.localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // Language selection still works for the current page without storage.
    }
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      errorMessage: (cause) => localizedErrorMessage(locale, cause),
      formatDate: (input, options) =>
        new Intl.DateTimeFormat(localeTag, options).format(new Date(input)),
      formatNumber: (input) => new Intl.NumberFormat(localeTag).format(input),
      locale,
      localeTag,
      setLocale,
      t: (key, params = {}) => translate(locale, key, params),
    }),
    [locale, localeTag],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
