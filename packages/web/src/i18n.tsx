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
  "AI": "ИИ",
  "Activate saved version": "Активировать сохранённую версию",
  "Active version": "Активная версия",
  "All": "Все",
  "Bulk Resource evaluation": "Массовая оценка ресурсов",
  "Candidate hash": "Хеш кандидата",
  "Compared active AST hash": "Хеш AST активной версии при сравнении",
  "Compared with active version": "Сравнение с активной версией",
  "Confirm activation": "Подтвердить активацию",
  "Confirm change": "Подтвердить изменение",
  "Confirm rule change": "Подтверждение изменения правил",
  "Controlled language grammar": "Грамматика контролируемого языка",
  "Compiled source": "Скомпилированный исходный фрагмент",
  "Compiled conditions": "Скомпилированные условия",
  "Compiled effects": "Скомпилированные эффекты",
  "Error at characters {start}-{end}: ": "Ошибка в символах {start}-{end}: ",
  "Default": "По умолчанию",
  "Disable": "Отключить",
  "Does not need review": "Не требует проверки",
  "Loading personal priority rules...": "Загрузка персональных правил приоритета...",
  "My": "Моя",
  "My importance": "Моя важность",
  "Natural language": "Естественный язык",
  "Personal priority rules": "Персональные правила приоритета",
  "Preview": "Предпросмотр",
  "Preview changes": "Предпросмотр изменений",
  "Preview rollback": "Предпросмотр отката",
  "Priority order": "Порядок приоритета",
  "Priority recompute": "Пересчёт приоритета",
  "Priority recompute finished: {status}": "Пересчёт приоритета завершён: {status}",
  "Recommended": "Рекомендуемая",
  "Recompute priority": "Пересчитать приоритет",
  "Reset": "Сбросить",
  "Resource bulk result: {succeeded} succeeded, {failed} failed, {unknown} unknown; {pages} logical pages.":
    "Результат массовой оценки ресурсов: успешно — {succeeded}, ошибок — {failed}, неизвестно — {unknown}; логических страниц — {pages}.",
  "Review state": "Статус проверки",
  "Rule editor mode": "Режим редактора правил",
  "Rule source": "Текст правил",
  "Save inactive version": "Сохранить неактивную версию",
  "Select {resource} for bulk evaluation": "Выбрать {resource} для массовой оценки",
  "Set evaluation for selected Resources": "Оценить выбранные ресурсы",
  "Set evaluation to {level} of 3": "Установить оценку {level} из 3",
  "Set importance for selected browser tabs": "Установить важность выбранных вкладок браузера",
  "Set importance for selected logical pages": "Установить важность выбранных логических страниц",
  "Showing the latest versions only.": "Показаны только последние версии.",
  "Structured rule additions (JSON)": "Дополнительные структурированные правила (JSON)",
  "Structured rules": "Структурированные правила",
  "This changes the active priority rules. Recompute remains a separate action.":
    "Это изменит активные правила приоритета. Пересчёт останется отдельным действием.",
  "Untitled": "Без названия",
  "Version": "Версия",
  "Version history": "История версий",
  "{count} logical pages": "Логических страниц: {count}",
  "{resources} Resources, {pages} logical pages": "Ресурсов: {resources}, логических страниц: {pages}",
  "Logical-page mapping unavailable; refresh before setting importance.":
    "Связь с логическими страницами недоступна; обновите данные перед изменением важности.",
  "Saved version {version} is inactive.": "Версия {version} сохранена, но не активна.",
  "Priority rules activated.": "Правила приоритета активированы.",
  "Personal priority rules disabled.": "Персональные правила приоритета отключены.",
  "Personal priority rules reset.": "Персональные правила приоритета сброшены.",
  "Priority rules rolled back.": "Правила приоритета возвращены к выбранной версии.",
  "This rule is unsupported. Review the highlighted source and try again.":
    "Это правило не поддерживается. Проверьте выделенный фрагмент и повторите попытку.",
  "These priority rules are invalid. Review their conditions and effects.":
    "Эти правила приоритета некорректны. Проверьте их условия и эффекты.",
  "Active priority rules changed. Reload them and preview again.":
    "Активные правила приоритета изменились. Обновите их и повторите предпросмотр.",
  "Personal priority rules no longer exist. Reload and try again.":
    "Персональные правила приоритета больше не существуют. Обновите данные и повторите попытку.",
  "This priority-rule version no longer exists. Reload the version history.":
    "Эта версия правил приоритета больше не существует. Обновите историю версий.",
  "This preview is too large. Narrow the rule set and try again.":
    "Этот предпросмотр слишком велик. Сузьте набор правил и повторите попытку.",
  "This preview took too long. Narrow the rule set and try again.":
    "Предпросмотр занял слишком много времени. Сузьте набор правил и повторите попытку.",
  "Personal priority rules are unavailable right now.":
    "Персональные правила приоритета сейчас недоступны.",
  "Activity period": "Период активности",
  "Last 7 days": "Последние 7 дней",
  "Last 30 days": "Последние 30 дней",
  "All time": "Всё время",
  "Activity for selected period": "Активность за выбранный период",
  "Loading activity...": "Загрузка активности...",
  "Updating activity...": "Обновление активности...",
  "Activity unavailable": "Данные об активности недоступны",
  "Retry activity": "Повторить загрузку активности",
  "Full window coverage": "Полное покрытие периода",
  "Partial coverage since {date}": "Частичные данные с {date}",
  "Tracking since {date}": "Отслеживание с {date}",
  "Tracking start unknown": "Начало отслеживания неизвестно",
  "Resources": "Ресурсы",
  "Resource": "Ресурс",
  "Website": "Сайт",
  "Platform": "Платформа",
  "Collection": "Коллекция",
  "Public": "Публичный",
  "Authenticated": "Требует входа",
  "Sensitive": "Чувствительный",
  "Library grouping": "Группировка библиотеки",
  "Active Library filters": "Активные фильтры библиотеки",
  "Remove topic filter": "Убрать фильтр по теме",
  "Remove resource filter": "Убрать фильтр по ресурсу",
  "Clear all": "Очистить всё",
  "Page {page}": "Страница {page}",
  "Resource list pages": "Страницы списка ресурсов",
  "Classification review pages": "Страницы проверки классификации",
  "Filter tabs by resource": "Фильтровать вкладки по ресурсу",
  "All resources": "Все ресурсы",
  "Logical pages": "Логические страницы",
  "Browser pages": "Страницы браузеров",
  "Physical open copies": "Физически открытые копии",
  "Loading resources...": "Загрузка ресурсов...",
  "No resources match the active filters.": "Нет ресурсов, соответствующих активным фильтрам.",
  "Classification review": "Проверка классификации",
  "Unmatched and ambiguous pages": "Несопоставленные и неоднозначные страницы",
  "Nothing is assigned until you choose explicitly.": "Ничего не назначается без вашего явного выбора.",
  "Loading review queue...": "Загрузка очереди проверки...",
  "No pages need classification review.": "Нет страниц, требующих проверки классификации.",
  "Ambiguous": "Неоднозначно",
  "Unmatched": "Не сопоставлено",
  "Candidates: {names}": "Кандидаты: {names}",
  "Assign manually": "Назначить вручную",
  "Choose a resource": "Выберите ресурс",
  "Resource ID": "ID ресурса",
  "Choose a valid Resource ID.": "Укажите корректный ID ресурса.",
  "Apply override": "Применить явное назначение",
  "Create and assign {host}": "Создать и назначить {host}",
  "resource": "ресурс",
  "This address cannot become a resource automatically.": "Из этого адреса нельзя автоматически создать ресурс.",
  "Unexpected resource update.": "Неожиданный результат обновления ресурса.",
  "Loading resource details...": "Загрузка сведений о ресурсе...",
  "Resource unavailable": "Ресурс недоступен",
  "Resource details are not ready.": "Сведения о ресурсе ещё не готовы.",
  "Selected resource": "Выбранный ресурс",
  "All-time activity": "Активность за всё время",
  "On screen: {duration}": "На экране: {duration}",
  "Active use: {duration}": "Активное использование: {duration}",
  "Coverage start unknown": "Начало периода наблюдения неизвестно",
  "Coverage since {date}": "Наблюдение с {date}",
  "Your evaluation": "Ваша оценка",
  "Personal rating": "Личная оценка",
  "No personal evaluation yet.": "Личной оценки пока нет.",
  "Set by you manually.": "Установлено вами вручную.",
  "AI assessment": "Оценка ИИ",
  "AI priority": "Приоритет ИИ",
  "AI priority explanation": "Объяснение приоритета ИИ",
  "AI priority is separate from your importance and does not change Library order.":
    "Приоритет ИИ отделён от вашей оценки важности и не меняет порядок в Библиотеке.",
  "Shadow only": "Только наблюдение",
  "You: Unrated": "Вы: без оценки",
  "You: {importance}": "Вы: {importance}",
  "AI: {score}": "ИИ: {score}",
  "AI: Excluded": "ИИ: исключено",
  "AI: Unranked": "ИИ: без ранга",
  Current: "Актуально",
  Stale: "Устарело",
  Excluded: "Исключено",
  Unranked: "Без ранга",
  "AI band": "Уровень ИИ",
  "AI score": "Оценка ИИ",
  Confidence: "Уверенность",
  Evaluated: "Оценено",
  "Why AI assigned this priority": "Почему ИИ назначил такой приоритет",
  "No additional contributions were applied.": "Дополнительные вклады не применялись.",
  "{value} score": "{value} к оценке",
  "{value} confidence": "{value} к уверенности",
  "Missing signals": "Недостающие сигналы",
  "No expected signals are missing.": "Все ожидаемые сигналы доступны.",
  "30-day active use": "Активное использование за 30 дней",
  "30-day on-screen time": "Время на экране за 30 дней",
  "Current research report": "Актуальный отчёт исследования",
  "Current summary": "Актуальная сводка",
  "Shareable next action": "Следующее действие, доступное ИИ",
  "Shareable project context": "Контекст проекта, доступный ИИ",
  "Current project membership": "Участие в текущем проекте",
  "Topic membership": "Принадлежность к темам",
  "Workspace membership": "Принадлежность к рабочим пространствам",
  "Pinned state": "Состояние закрепления",
  "Open state": "Состояние открытия",
  "Page status": "Статус страницы",
  "Knowledge relations": "Связи в базе знаний",
  "Page age": "Возраст страницы",
  "Last-seen recency": "Давность последнего просмотра",
  "Duplicate physical copies": "Дублирующиеся физические копии",
  "Resource page count": "Количество страниц ресурса",
  "Captured Resource page count": "Количество сохранённых страниц ресурса",
  "At least 15 minutes of active use in 30 days":
    "Не менее 15 минут активного использования за 30 дней",
  "Member of a current project": "Относится к текущему проекту",
  "Has a current research report": "Есть актуальный отчёт исследования",
  "Has a current summary": "Есть актуальная сводка",
  "Pinned in the browser": "Закреплено в браузере",
  "Has knowledge relations": "Есть связи в базе знаний",
  "Has a shareable next action": "Есть следующее действие, доступное ИИ",
  "Has shareable project context": "Есть контекст проекта, доступный ИИ",
  "Confidence is below the active review threshold":
    "Уверенность ниже действующего порога проверки",
  "Conflicting rules were resolved deterministically.":
    "Конфликтующие правила разрешены детерминированно.",
  "A personal rule requested review.": "Личное правило запросило проверку.",
  Low: "Низкий",
  Medium: "Средний",
  High: "Высокий",
  Critical: "Критический",
  "Unsupported URL": "Неподдерживаемый адрес",
  "Private or internal page": "Приватная или внутренняя страница",
  "Excluded by a personal rule": "Исключено личным правилом",
  "Excluded by policy": "Исключено политикой",
  "Insufficient signals": "Недостаточно сигналов",
  "Temporarily unavailable": "Временно недоступно",
  "No AI score is assigned to an excluded subject.":
    "Исключённому объекту оценка ИИ не назначается.",
  "Exclusion details": "Сведения об исключении",
  "This subject has not been ranked yet.": "Этот объект ещё не ранжирован.",
  "This explanation is stale and is shown only for review.":
    "Это объяснение устарело и показывается только для проверки.",
  "Loading AI priority...": "Загрузка приоритета ИИ...",
  "Your feedback on this AI assessment": "Ваш отзыв об этой оценке ИИ",
  Feedback: "Отзыв",
  "Looks right": "Всё верно",
  "Too high": "Слишком высокий",
  "Too low": "Слишком низкий",
  "Optional note": "Необязательное примечание",
  "Send feedback": "Отправить отзыв",
  "Feedback saved.": "Отзыв сохранён.",
  "Retry same feedback": "Повторить тот же отзыв",
  "Review AI priorities": "Проверить приоритеты ИИ",
  "AI priority review queue": "Очередь проверки приоритетов ИИ",
  "Loading priority review queue...": "Загрузка очереди проверки приоритетов...",
  "No AI priorities need review.": "Нет приоритетов ИИ, требующих проверки.",
  "Priority review queue pages": "Страницы очереди проверки приоритетов",
  "Page #{id}": "Страница №{id}",
  "Resource #{id}": "Ресурс №{id}",
  "TabHub could not load AI priority": "TabHub не смог загрузить приоритет ИИ",
  "TabHub returned unreadable AI priority.": "TabHub вернул нечитаемые данные приоритета ИИ.",
  "TabHub returned mismatched AI priority.": "TabHub вернул приоритет ИИ для другого объекта.",
  "TabHub could not load the priority review queue":
    "TabHub не смог загрузить очередь проверки приоритетов",
  "TabHub returned an unreadable priority review queue.":
    "TabHub вернул нечитаемую очередь проверки приоритетов.",
  "TabHub returned an unexpected priority review queue.":
    "TabHub вернул неожиданную очередь проверки приоритетов.",
  "TabHub could not save priority feedback": "TabHub не смог сохранить отзыв о приоритете",
  "TabHub returned unreadable priority feedback.":
    "TabHub вернул нечитаемый результат сохранения отзыва.",
  "TabHub returned mismatched priority feedback.":
    "TabHub вернул отзыв о приоритете для другого объекта.",
  "Not available yet": "Пока недоступна",
  "Aliases": "Псевдонимы",
  "System and agent aliases remain protected. Edit only user aliases below.": "Системные псевдонимы и псевдонимы агента защищены. Ниже редактируются только пользовательские.",
  "Editable resource aliases": "Редактируемые псевдонимы ресурса",
  "Each alias must use: host | exact_host or suffix_host | /path | priority": "Каждый псевдоним должен иметь вид: хост | exact_host или suffix_host | /путь | приоритет",
  "One per line: host | exact_host or suffix_host | /path | priority": "По одному в строке: хост | exact_host или suffix_host | /путь | приоритет",
  "Protected aliases: {aliases}": "Защищённые псевдонимы: {aliases}",
  "Save aliases": "Сохранить псевдонимы",
  "Aliases saved": "Псевдонимы сохранены",
  "Resource context": "Контекст ресурса",
  "Resource note or next action": "Заметка о ресурсе или следующее действие",
  "Why is this resource useful?": "Чем полезен этот ресурс?",
  "What should happen next?": "Что нужно сделать дальше?",
  "Save context": "Сохранить контекст",
  "Loading resource context...": "Загрузка контекста ресурса...",
  "No resource context yet.": "Контекста ресурса пока нет.",
  "This resource changed. Its latest details were reloaded; review and try again.": "Ресурс изменился. Свежие данные уже загружены; проверьте их и повторите попытку.",
  "Resource rules changed. Their latest version was reloaded; review and try again.": "Правила ресурса изменились. Их свежая версия уже загружена; проверьте её и повторите попытку.",
  "This page classification changed. Reload the review queue and try again.": "Классификация страницы изменилась. Обновите очередь проверки и повторите попытку.",
  "This resource is no longer active.": "Этот ресурс больше не активен.",
  "Personal context": "Личный контекст",
  "Personal context: {context}": "Личный контекст: {context}",
  "Why this page matters or why this exact tab is open.":
    "Почему эта страница важна или зачем сейчас открыта именно эта вкладка.",
  "{count} browser copies": (params) => {
    const count = numericParam(params);
    return `${count} ${russianPlural(count, "копия в браузере", "копии в браузерах", "копий в браузерах")}`;
  },
  "Checking personal context": "Проверка личного контекста",
  "Loading personal context": "Загрузка личного контекста",
  "Save for": "Сохранить для",
  "This page in all browsers": "Этой страницы во всех браузерах",
  "Only this open tab": "Только этой открытой вкладки",
  "Use exact context for {title} in {browser}, window {windowId}, tab {tabId}":
    "Использовать точный контекст для «{title}» в {browser}, окно {windowId}, вкладка {tabId}",
  "Open copy": "Открытая копия",
  "Select an open copy": "Выберите открытую копию",
  "Untitled tab": "Вкладка без названия",
  "window {windowId}, tab {tabId}": "окно {windowId}, вкладка {tabId}",
  "No addressable open copy is available.": "Нет доступной открытой копии с точным адресом.",
  "Applies to {affected} saved browser copies; {open} are open now.":
    "Применяется к сохранённым копиям: {affected}; сейчас открыто: {open}.",
  "Context kind": "Тип контекста",
  Purpose: "Назначение",
  Interest: "Интерес",
  Question: "Вопрос",
  Project: "Проект",
  "Next action": "Следующее действие",
  Disposition: "Решение",
  "Why is this important?": "Почему это важно?",
  "Why is this open now?": "Зачем это открыто сейчас?",
  "Quick dispositions": "Быстрые решения",
  "Quick context presets": "Быстрые шаблоны контекста",
  Do: "Сделать",
  Research: "Исследовать",
  Reference: "Справка",
  Compare: "Сравнить",
  Temporary: "Временно",
  "Selected preset: {preset}": "Выбран шаблон: {preset}",
  "Not useful": "Не пригодится",
  "Already handled": "Уже обработано",
  "Local only": "Только локально",
  "May be used by AI": "Можно использовать ИИ",
  "Save revision": "Сохранить редакцию",
  "Current page context": "Текущий контекст страницы",
  "No personal context yet.": "Личного контекста пока нет.",
  You: "Вы",
  "AI suggestion": "Предложение ИИ",
  Accepted: "Принято",
  Rejected: "Отклонено",
  Edit: "Изменить",
  Accept: "Принять",
  Reject: "Отклонить",
  Remove: "Убрать",
  "Revision history": "История редакций",
  Operation: "Операция",
  Withdrawn: "Отозвано",
  Promoted: "Перенесено",
  Expired: "Истекло",
  Added: "Добавлено",
  Removed: "Удалено",
  Restored: "Восстановлено",
  "Exact open-tab intent": "Цель конкретной открытой вкладки",
  "Loading open-tab intent": "Загрузка цели открытой вкладки",
  "Open now": "Открыто сейчас",
  Archive: "Архивировать",
  "Promote as": "Перенести как",
  "Promote to page context": "Перенести в контекст страницы",
  "No intent for this exact open tab.": "Для этой конкретной вкладки цели пока нет.",
  "Intent history": "История целей",
  "Pair this browser for personal context": "Подключить этот браузер к личному контексту",
  "One-time step for this browser. Pairing does not expire.":
    "Разовое действие для этого браузера. Подключение не истекает.",
  "This browser is paired.": "Этот браузер подключён.",
  "TabHub could not tell whether this browser was paired. Check the extension window, then reload this page.":
    "TabHub не смог определить, подключился ли браузер. Проверьте окно расширения и обновите страницу.",
  "This browser could not be paired automatically. Enter these in the extension window instead.":
    "Не удалось подключить браузер автоматически. Введите эти значения в окне расширения.",
  "Pairing code": "Код подключения",
  "Pairing challenge": "Идентификатор подключения",
  "Expires {date}": "Истекает {date}",
  "Personal context saved.": "Личный контекст сохранён.",
  "Open-tab intent saved.": "Цель открытой вкладки сохранена.",
  "Context removed.": "Контекст убран.",
  "Context restored.": "Контекст восстановлен.",
  "Suggestion accepted.": "Предложение принято.",
  "Suggestion rejected.": "Предложение отклонено.",
  "Open-tab intent archived.": "Цель открытой вкладки архивирована.",
  "Intent promoted to page context.": "Цель перенесена в контекст страницы.",
  "Save undone.": "Сохранение отменено.",
  "Change undone.": "Изменение отменено.",
  "This open tab changed. Refresh its copies and try again.":
    "Эта открытая вкладка изменилась. Обновите список копий и повторите.",
  "Personal context requires a paired local browser. Pair this browser and try again.":
    "Для личного контекста нужен подключённый локальный браузер. Подключите этот браузер и повторите попытку.",
  "This context entry is no longer current. Reload personal context and try again.":
    "Эта запись контекста уже не является текущей. Обновите личный контекст и повторите попытку.",
  "The requested personal context no longer exists. Reload and try again.":
    "Запрошенный личный контекст больше не существует. Обновите данные и повторите попытку.",
  "This context entry belongs to a different page. Reload personal context and try again.":
    "Эта запись контекста относится к другой странице. Обновите личный контекст и повторите попытку.",
  "This context entry cannot be changed in its current state. Reload personal context and try again.":
    "Эту запись контекста нельзя изменить в её текущем состоянии. Обновите личный контекст и повторите попытку.",
  "Only AI suggestions can be accepted or rejected.":
    "Принимать или отклонять можно только предложения ИИ.",
  "This action conflicts with an earlier request. Reload and try again.":
    "Это действие конфликтует с предыдущим запросом. Обновите данные и повторите попытку.",
  "This open-tab intent cannot be changed in its current state. Reload it and try again.":
    "Цель этой открытой вкладки нельзя изменить в её текущем состоянии. Обновите её и повторите попытку.",
  "This open-tab intent belongs to a different page. Refresh open copies and try again.":
    "Цель этой открытой вкладки относится к другой странице. Обновите список открытых копий и повторите попытку.",
  "TabHub rejected invalid personal-context data. Review the fields and try again.":
    "TabHub отклонил некорректные данные личного контекста. Проверьте поля и повторите попытку.",
  Undo: "Отменить действие",
  "Clear sorting for {column}": "Сбросить сортировку по столбцу «{column}»",
  "Sort by {column}": "Сортировать по столбцу «{column}»",
  "Sort {column} ascending": "Сортировать «{column}» по возрастанию",
  "Sort {column} descending": "Сортировать «{column}» по убыванию",
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
  Activity: "Активность",
  "Active use": "Активное использование",
  "How activity is measured": "Как измеряется активность",
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
  "Manage browser tabs": "Управление вкладками",
  "Library collection": "Коллекция библиотеки",
  "All pages": "Все страницы",
  "To review": "На разбор",
  Trash: "Корзина",
  "Pages suggested for review": "Страницы на разбор",
  "Suggestions use weak signals and your explicit decisions. Nothing is deleted automatically.":
    "Рекомендации основаны на слабых сигналах и ваших явных решениях. Ничего не удаляется автоматически.",
  "Forgotten pages stay here for 7 days before permanent deletion.":
    "Забытые страницы хранятся здесь 7 дней до окончательного удаления.",
  "{count} pages": "Страниц: {count}",
  "Loading retention collection": "Загрузка коллекции",
  "No pages need review.": "Нет страниц, требующих разбора.",
  "Trash is empty.": "Корзина пуста.",
  "Why suggested": "Почему предложено",
  "Closed page": "Закрытая страница",
  "Search results page": "Страница результатов поиска",
  "No captured content": "Нет сохранённого содержимого",
  "No confirmed interaction": "Нет подтверждённого взаимодействия",
  "No custom fields": "Нет произвольных полей",
  "No links": "Нет связей",
  "Open copies: {count}": "Открытых копий: {count}",
  "Pinned copies: {count}": "Закреплённых копий: {count}",
  "Saved workspaces: {count}": "Сохранённых пространств: {count}",
  "Links: {count}": "Связей: {count}",
  Keep: "Оставить",
  "Keep {title}": "Оставить «{title}»",
  Later: "Позже",
  "Review {title} later": "Вернуть «{title}» на разбор позже",
  "Close and forget": "Закрыть и забыть",
  "Close and forget {title}": "Закрыть и забыть «{title}»",
  "Closing copies...": "Закрытие копий...",
  "Close every open copy of this page and move it to Trash? You can restore it for 7 days.":
    "Закрыть все открытые копии этой страницы и переместить её в корзину? Восстановление доступно 7 дней.",
  "The owning browser session is offline. Nothing was forgotten.":
    "Нужная сессия браузера не в сети. Ничего не забыто.",
  "The browser result is unknown. Nothing was forgotten from the Library.":
    "Результат команды браузера неизвестен. Из библиотеки ничего не забыто.",
  "An open copy could not be addressed safely. Nothing was forgotten.":
    "Не удалось безопасно адресовать открытую копию. Ничего не забыто.",
  "The open copies changed during confirmation. Nothing was forgotten.":
    "Открытые копии изменились во время подтверждения. Ничего не забыто.",
  "Not every open copy closed successfully. Nothing was forgotten.":
    "Не все открытые копии успешно закрылись. Ничего не забыто.",
  "Open copies still remain. Nothing was forgotten from the Library.":
    "Открытые копии всё ещё существуют. Из библиотеки ничего не забыто.",
  "TabHub could not safely forget this page.":
    "TabHub не смог безопасно забыть эту страницу.",
  "Permanently deleted {date}": "Окончательное удаление: {date}",
  Restore: "Восстановить",
  "Restore {title}": "Восстановить «{title}»",
  "Retention pagination": "Страницы коллекции разбора",
  "Page retention": "Хранение страницы",
  "Your decision is personal to this page. TabHub will never delete it from a suggestion alone.":
    "Это ваше персональное решение для этой страницы. TabHub никогда не удалит её только из-за рекомендации.",
  "This page will stay in the Library.": "Эта страница останется в библиотеке.",
  "This page will return to review later.":
    "Эта страница вернётся на разбор позже.",
  "{count} copies were already closed; the page remains in the Library.":
    "Уже закрыто копий: {count}; страница осталась в библиотеке.",
  "Bulk tab actions": "Массовые действия с вкладками",
  "Check summary status": "Проверить статус сводки",
  "Check page summary status": "Проверить статус сводки страницы",
  "Retry page summary": "Повторить создание сводки страницы",
  "Page summary depth": "Глубина сводки страницы",
  "Short page summary": "Краткая сводка страницы",
  "A compact overview of this single page.":
    "Компактный обзор одной этой страницы.",
  "Deep page summary": "Подробная сводка страницы",
  "A detailed analysis of this single captured page.":
    "Подробный анализ одной этой сохранённой страницы.",
  "Capture and summarize": "Сохранить и создать сводку",
  "Capturing page for summary...": "Сохранение страницы для сводки...",
  "Queueing page summary...": "Постановка сводки страницы в очередь...",
  "Page summary queued.": "Сводка страницы поставлена в очередь.",
  "Creating page summary...": "Создание сводки страницы...",
  "Short page summary ready.": "Краткая сводка страницы готова.",
  "Deep page summary ready.": "Подробная сводка страницы готова.",
  "TabHub could not check this page summary job.":
    "TabHub не смог проверить задачу сводки страницы.",
  "TabHub could not queue this page summary.":
    "TabHub не смог поставить сводку страницы в очередь.",
  "Captured page content is no longer available. Capture and summarize again.":
    "Сохранённое содержимое страницы больше недоступно. Сохраните страницу и создайте сводку снова.",
  "The page-summary provider is unavailable. Try again after it is configured.":
    "Провайдер сводок страниц недоступен. Повторите попытку после его настройки.",
  "TabHub could not create this page summary.":
    "TabHub не смог создать сводку страницы.",
  "TabHub returned a summary job for a different capture. Capture and summarize again.":
    "TabHub вернул задачу сводки для другого сохранения. Сохраните страницу и создайте сводку снова.",
  "Captured content changed while the page summary was running. Capture and summarize again.":
    "Сохранённое содержимое изменилось во время создания сводки страницы. Сохраните страницу и создайте сводку снова.",
  "Confirming the current captured revision before showing this page summary...":
    "Проверка актуальной сохранённой версии перед показом сводки страницы...",
  "Summarize captured revision": "Создать сводку сохранённой версии",
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
  "Dismiss report": "Закрыть отчёт",
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
  Unrated: "Без оценки",
  "Clear importance": "Очистить важность",
  "Set importance to {level} of 3": "Установить важность: {level} из 3",
  "Current confirmed importance: Unrated.":
    "Текущая подтверждённая важность: без оценки.",
  "Current confirmed importance: {level} of 3.":
    "Текущая подтверждённая важность: {level} из 3.",
  "Set manually by you on {date}.": "Установлено вами вручную {date}.",
  "Recorded by an agent on your behalf on {date}.":
    "Записано агентом по вашему поручению {date}.",
  "Previous importance needs review": "Нужно проверить прежнюю важность",
  "Needs review": "Требует проверки",
  "Older TabHub data contains this importance, but its author is unknown. It stays unrated until you confirm it.":
    "В старых данных TabHub есть эта оценка важности, но её автор неизвестен. Пока вы её не подтвердите, страница остаётся без оценки.",
  "Browser copies disagree about importance. TabHub has not chosen a winner.":
    "Копии в браузерах расходятся в оценке важности. TabHub не выбрал значение автоматически.",
  "Previous browser values": "Прежние значения в браузерах",
  "{browser} · {value} · Tab #{id}":
    "{browser} · {value} · Вкладка №{id}",
  "Confirm {level} of 3": "Подтвердить: {level} из 3",
  "Importance saved for all browser copies.":
    "Важность сохранена для всех копий в браузерах.",
  "Checking importance mode": "Проверка режима важности",
  "TabHub could not load feature settings":
    "TabHub не удалось загрузить настройки функций",
  "TabHub returned unreadable feature settings.":
    "TabHub вернул нечитаемые настройки функций.",
  "TabHub returned unexpected feature settings.":
    "TabHub вернул неожиданные настройки функций.",
  "TabHub could not load this page's importance":
    "TabHub не удалось загрузить важность этой страницы",
  "TabHub returned unreadable logical page details.":
    "TabHub вернул нечитаемые сведения о логической странице.",
  "TabHub returned unexpected logical page details.":
    "TabHub вернул неожиданные сведения о логической странице.",
  "TabHub could not update this page's importance":
    "TabHub не удалось обновить важность этой страницы",
  "TabHub returned an unreadable importance update.":
    "TabHub вернул нечитаемый результат обновления важности.",
  "TabHub returned an unexpected importance update.":
    "TabHub вернул неожиданный результат обновления важности.",
  OK: "Ок",
  Incoming: "Входящая",
  "Importance {level} of 3": "Важность: {level} из 3",
  Inbox: "Входящие",
  "In progress": "В работе",
  "Just now": "Только что",
  Kind: "Тип",
  "Knowledge graph": "Граф знаний",
  Library: "Библиотека",
  "Library pages": "Страницы библиотеки",
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
  "On screen": "На экране",
  "Page activity": "Активность страницы",
  "Open-tab activity": "Активность открытых вкладок",
  "No open copies": "Нет открытых копий",
  "No recorded activity": "Нет записанной активности",
  "Open copies unavailable": "Открытые копии недоступны",
  "Accumulated for this page across tracked browser sessions.":
    "Накоплено для этой страницы за все отслеженные сессии браузера.",
  "Combined across currently open physical copies.":
    "Сумма по физическим копиям, открытым сейчас.",
  "On-screen time within 60 seconds of recent mouse, keyboard, scroll, or touch input.":
    "Время на экране в течение 60 секунд после недавнего действия мышью, клавиатурой, прокрутки или касания.",
  "No tags assigned.": "Теги не назначены.",
  Note: "Примечание",
  Open: "Открыта",
  "Open in browser": "Открыть в браузере",
  "Open & closed": "Открытые и закрытые",
  "Open {tab} in browser": "Открыть «{tab}» в браузере",
  "Open only": "Только открытые",
  "Open tab details": "Открыть сведения о вкладке",
  "Open tabs": "Открытые вкладки",
  "Open copies": "Открытые копии",
  "Multiple open copies": "Несколько открытых копий",
  "Activity is tracked separately for each physical tab in its current browser session.":
    "Активность учитывается отдельно для каждой физической вкладки в текущей сессии браузера.",
  "Loading open copies...": "Загрузка открытых копий...",
  "No open copies in the current browser session.":
    "В текущей сессии браузера нет открытых копий.",
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
  "Retry short summary": "Повторить создание сводки",
  Russian: "Русский",
  Save: "Сохранить",
  "Save link": "Сохранить связь",
  "Search tab titles, URLs, and content":
    "Поиск по заголовкам, URL и содержимому",
  "Search titles, URLs, and content": "Найти заголовки, URL и содержимое",
  "Select {tab}": "Выбрать «{tab}»",
  "Select all browser tabs on this page":
    "Выбрать все вкладки браузеров на этой странице",
  "Selected while its browser window was in the foreground and the computer was active.":
    "Вкладка была выбрана, окно браузера находилось на переднем плане, а компьютер был активен.",
  "Select all tabs on this page": "Выбрать все вкладки на этой странице",
  "Select browser tabs for {tab}": "Выбрать вкладки браузеров для «{tab}»",
  "Select and manage exact tabs in their owning browsers.":
    "Выбирайте и управляйте конкретными вкладками в их браузерах.",
  "Show all {count} characters": "Показать все символы: {count}",
  "Show compact view": "Показать сокращённо",
  "Something went wrong.": "Что-то пошло не так.",
  "Source to this tab": "От исходной вкладки к этой",
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
  "No topic": "Без темы",
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
  "Add topic": "Добавить тему",
  "Add subtopic": "Добавить подтему",
  "Add subtopic to {topic}": "Добавить подтему в «{topic}»",
  "Create top-level topic": "Создать тему верхнего уровня",
  "Create subtopic under {topic}": "Создать подтему в «{topic}»",
  "Create topic": "Создать тему",
  "Edit topic {topic}": "Изменить тему «{topic}»",
  "Topic name": "Название темы",
  "Parent topic": "Родительская тема",
  "Top level": "Верхний уровень",
  "Use custom color": "Использовать свой цвет",
  "Topic color": "Цвет темы",
  "Save topic": "Сохранить тему",
  "Rename or move topic": "Переименовать или переместить тему",
  "Delete topic": "Удалить тему",
  "Delete topic {topic}": "Удалить тему «{topic}»",
  "Delete topic “{name}”?": "Удалить тему «{name}»?",
  "Topics with subtopics cannot be deleted.":
    "Нельзя удалить тему, пока у неё есть подтемы.",
  "Create a top-level topic or assign one to a tab.":
    "Создайте тему верхнего уровня или назначьте тему вкладке.",
  "Assign topic": "Назначить тему",
  "No topics assigned.": "Темы не назначены.",
  "A topic with this name already exists at that level.":
    "Тема с таким названием уже существует на этом уровне.",
  "A topic cannot be moved inside itself or one of its subtopics.":
    "Тему нельзя переместить внутрь неё самой или одной из её подтем.",
  "Move or delete the subtopics before deleting this topic.":
    "Перед удалением темы переместите или удалите её подтемы.",
  "The default topic is managed automatically.":
    "Тема «Без темы» управляется автоматически.",
  "This topic no longer exists.": "Эта тема больше не существует.",
  "This topic is no longer assigned to the tab.":
    "Эта тема больше не назначена вкладке.",
  "This tab no longer exists.": "Эта вкладка больше не существует.",
  "One of the relation endpoints no longer exists.":
    "Один из связываемых узлов больше не существует.",
  "A node cannot be related to itself.":
    "Нельзя создать связь узла с самим собой.",
  "This relation no longer exists.": "Эта связь больше не существует.",
  "Remove {topic}, assigned by {source}":
    "Удалить тему {topic}, назначенную: {source}",
  "3D knowledge graph": "Трёхмерный граф знаний",
  "3D view is unavailable": "Трёхмерный вид недоступен",
  "Drag to rotate, right-drag to pan, and scroll to zoom.":
    "Перетаскивайте, чтобы вращать; правой кнопкой — перемещать; колесом — масштабировать.",
  "Capture tabs or create topics to start building the knowledge graph.":
    "Сохраните вкладки или создайте темы, чтобы начать строить граф знаний.",
  "Choose a relation target.": "Выберите целевой узел для связи.",
  "Choose any tab or topic in the 3D space to inspect its details and connections.":
    "Выберите вкладку или тему в трёхмерном пространстве, чтобы увидеть сведения и связи.",
  "Clear relation target": "Сбросить целевой узел связи",
  Connections: "Связи",
  "Creating relation...": "Создание связи...",
  "Delete relation to {node}": "Удалить связь с узлом «{node}»",
  "Find a tab or topic": "Найти вкладку или тему",
  "Graph legend": "Легенда графа",
  "Open topic in Library": "Открыть тему в библиотеке",
  Relations: "Связи",
  "Search by title, URL, or topic": "Поиск по названию, URL или теме",
  "Select a node": "Выберите узел",
  "Selected node → target": "Выбранный узел → целевой узел",
  Tabs: "Вкладки",
  "Tabs in subtree": "Вкладки во всей ветке",
  "Target → selected node": "Целевой узел → выбранный узел",
  "WebGL could not start. You can still manage topics and tabs in the Library.":
    "Не удалось запустить WebGL. Темами и вкладками по-прежнему можно управлять в библиотеке.",
  containment: "Иерархия",
  membership: "Принадлежность",
  relation: "Связь",
  "Tab node": "Узел-вкладка",
  "Topic node": "Узел-тема",
  "Node details": "Сведения об узле",
  "Focus depth": "Глубина связей",
  "Loading neighborhood...": "Загрузка окружения...",
  "Couldn't load the full neighborhood.":
    "Не удалось загрузить полное окружение узла.",
  "1 step": "1 шаг",
  "{count} steps": (params) => {
    const count = numericParam(params, "rawCount");
    return `${params.count} ${russianPlural(count, "шаг", "шага", "шагов")}`;
  },
  "All connected": "Все связанные",
  "Clear selection": "Снять выделение",
  "Center selected node": "Центрировать выбранный узел",
  Topic: "Тема",
  "Topic path": "Путь темы",
  "Direct tabs": "Вкладки непосредственно в теме",
  Subtopics: "Подтемы",
  "Selected: {title}": "Выбрано: {title}",
  "Create relation": "Создать связь",
  "Delete relation": "Удалить связь",
  "Relation kind": "Тип связи",
  "From node": "Исходный узел",
  "To node": "Целевой узел",
  "Why are these nodes connected?": "Почему эти узлы связаны?",
  "No relations yet.": "Связей пока нет.",
  "{count} nodes in focus": (params) => {
    const count = numericParam(params, "rawCount");
    return `В фокусе: ${params.count} ${russianPlural(count, "узел", "узла", "узлов")}`;
  },
  "{count} topics": (params) => {
    const count = numericParam(params, "rawCount");
    return `${params.count} ${russianPlural(count, "тема", "темы", "тем")}`;
  },
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
  "Close: {succeeded} closed · {skipped} skipped · {failed} failed · {notRun} profiles not completed · {unknown} profiles unknown":
    "Закрытие: закрыто {succeeded} · пропущено {skipped} · ошибок {failed} · профилей без завершения {notRun} · профилей с неизвестным результатом {unknown}",
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
  "Session {id}": "Сессия {id}",
  "{count} open copy": "{count} открытая копия",
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
  "The live close preview expired. Run the check again; no tabs were closed.":
    "Актуальная проверка закрытия устарела. Запустите её снова; вкладки не были закрыты.",
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
  "No connected browser profile can close the selected tabs.":
    "Ни один подключённый профиль браузера не может закрыть выбранные вкладки.",
  "No connected browser profile passed the live close preview.":
    "Ни один подключённый профиль браузера не прошёл актуальную проверку закрытия.",
  "No connected browser profile can close the matching duplicate copies.":
    "Ни один подключённый профиль браузера не может закрыть найденные копии-дубликаты.",
  "The browser profile changed during the live duplicate preview.":
    "Профиль браузера изменился во время актуальной проверки дубликатов.",
  "Excluded profiles: {profiles}": "Исключённые профили: {profiles}",
  "{profile} ({count} tabs)": "{profile} (вкладок: {count})",
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
  "Close can run across connected profiles; other browser actions require one profile.":
    "Закрытие выполняется по всем подключённым профилям; для остальных действий нужен один профиль.",
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
  "Switch to open tab": "Перейти к открытой вкладке",
  "Switch to open tab: {tab}": "Перейти к открытой вкладке: {tab}",
  "Switch to this existing browser tab": "Перейти к этой существующей вкладке браузера",
  "Switch to this existing browser tab. Middle-click to close it.":
    "Перейти к этой открытой вкладке браузера. Нажмите колёсиком, чтобы закрыть её.",
  "Switch to this existing browser tab. Middle-click anywhere in the row to close it.":
    "Перейти к этой открытой вкладке браузера. Нажмите колёсиком в любом месте строки, чтобы закрыть её.",
  "Switching...": "Переключение...",
  "Closing...": "Закрытие...",
  "tab {tabId}": "вкладка {tabId}",
  "The extension activated a different physical tab than requested.":
    "Расширение активировало другую физическую вкладку.",
  "The extension browser session changed during the action.":
    "Во время действия изменилась сессия браузера расширения.",
  "This browser action requires TabHub in the owning browser profile.":
    "Для этого действия TabHub должен быть открыт в профиле браузера-владельца.",
  "This tab is no longer open. Refresh the Library and try again.":
    "Эта вкладка больше не открыта. Обновите Библиотеку и повторите попытку.",
  "The tab is closed, but the browser blocked opening it. Try again.":
    "Вкладка закрыта, но браузер заблокировал её открытие. Повторите попытку.",
  "Windows activated the tab, but could not bring its browser to the foreground. Try again.":
    "Windows активировала вкладку, но не смогла вывести её браузер на передний план. Повторите попытку.",
  "This action is unavailable through the connected browser relay.":
    "Это действие недоступно через подключённый браузерный канал.",
  "The extension returned a result for a different command.":
    "Расширение вернуло результат другой команды.",
  "This tab could not be closed by middle click. Refresh and try again.":
    "Эту вкладку не удалось закрыть нажатием колёсика. Обновите список и повторите попытку.",
  "The tab changed during live revalidation and was not closed.":
    "Вкладка изменилась во время повторной проверки и не была закрыта.",
  "The TabHub control tab is protected and cannot close itself.":
    "Управляющая вкладка TabHub защищена и не может закрыть сама себя.",
  "Reload the updated TabHub extension in that browser before closing tabs with the middle mouse button.":
    "Перезагрузите обновлённое расширение TabHub в этом браузере, прежде чем закрывать вкладки колёсиком мыши.",
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
  "Untagged": "Без тем",
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
  "TabHub could not resolve this open tab":
    "TabHub не удалось найти физическую открытую вкладку",
  "TabHub returned an unreadable open-tab target.":
    "TabHub вернул нечитаемую цель открытой вкладки.",
  "TabHub returned an unexpected open-tab target.":
    "TabHub вернул неожиданную цель открытой вкладки.",
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
  "TabHub could not load tags": "TabHub не удалось загрузить темы",
  "TabHub returned an unreadable tag tree.":
    "TabHub вернул нечитаемое дерево тем.",
  "TabHub could not create this topic": "TabHub не удалось создать эту тему",
  "TabHub returned an unreadable topic.":
    "TabHub вернул нечитаемые данные темы.",
  "TabHub returned an unexpected topic.":
    "TabHub вернул неожиданные данные темы.",
  "TabHub could not update this topic": "TabHub не удалось обновить эту тему",
  "TabHub returned an unreadable topic update.":
    "TabHub вернул нечитаемый результат обновления темы.",
  "TabHub returned an unexpected topic update.":
    "TabHub вернул неожиданный результат обновления темы.",
  "TabHub could not delete this topic": "TabHub не удалось удалить эту тему",
  "TabHub returned an unreadable topic deletion.":
    "TabHub вернул нечитаемый результат удаления темы.",
  "TabHub returned an unexpected topic deletion.":
    "TabHub вернул неожиданный результат удаления темы.",
  "TabHub could not load the graph": "TabHub не удалось загрузить граф",
  "TabHub returned an unreadable graph.": "TabHub вернул нечитаемый граф.",
  "TabHub could not load the knowledge graph":
    "TabHub не удалось загрузить граф знаний",
  "TabHub returned an unreadable knowledge graph.":
    "TabHub вернул нечитаемый граф знаний.",
  "TabHub returned an unexpected knowledge graph.":
    "TabHub вернул неожиданный граф знаний.",
  "TabHub could not create this relation":
    "TabHub не удалось создать эту связь",
  "TabHub returned an unreadable relation.":
    "TabHub вернул нечитаемые данные связи.",
  "TabHub returned an unexpected relation.":
    "TabHub вернул неожиданные данные связи.",
  "TabHub could not delete this relation":
    "TabHub не удалось удалить эту связь",
  "TabHub returned an unreadable relation deletion.":
    "TabHub вернул нечитаемый результат удаления связи.",
  "TabHub returned an unexpected relation deletion.":
    "TabHub вернул неожиданный результат удаления связи.",
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
  "TabHub could not assign this tag": "TabHub не удалось назначить эту тему",
  "TabHub returned an unreadable tag update.":
    "TabHub вернул нечитаемый результат назначения темы.",
  "TabHub returned an unexpected tag update.":
    "TabHub вернул неожиданный результат назначения темы.",
  "TabHub could not remove this tag": "TabHub не удалось снять эту тему",
  "TabHub returned an unreadable tag removal.":
    "TabHub вернул нечитаемый результат снятия темы.",
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
    "TabHub вернул неожиданное дерево тем.",
  "TabHub returned an unexpected graph.": "TabHub вернул неожиданный граф.",
  "TabHub returned unexpected tab details.":
    "TabHub вернул неожиданные сведения о вкладке.",
  "TabHub returned an unexpected tag removal.":
    "TabHub вернул неожиданный результат снятия темы.",
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
  "An explicit single close requires exactly one physical tab.":
    "Для явного одиночного закрытия требуется ровно одна физическая вкладка.",
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
  "That browser tab is no longer available. Refresh the Library and try again.":
    "Эта вкладка браузера больше недоступна. Обновите библиотеку и повторите попытку.",
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
  "This browser session is offline.": "Эта сессия браузера не подключена.",
  "Reload the updated extension in this browser.":
    "Перезагрузите обновлённое расширение в этом браузере.",
  "This copy has incomplete browser identity.":
    "У этой копии неполные данные браузера.",
  "This copy is discarded; activate it before capture.":
    "Эта копия выгружена из памяти; активируйте её перед сохранением.",
  "The selected copy was closed. Refresh open copies.":
    "Выбранная копия закрыта. Обновите список открытых копий.",
  "The selected copy navigated. Refresh it before capturing.":
    "Выбранная копия перешла на другую страницу. Обновите её перед сохранением.",
  "The selected copy changed. Refresh and select it again.":
    "Выбранная копия изменилась. Обновите список и выберите её снова.",
  "This page type cannot be captured.": "Страницу этого типа нельзя сохранить.",
  "TabHub could not extract readable page content.":
    "TabHub не удалось извлечь читаемое содержимое страницы.",
  "The captured content could not reach TabHub.":
    "Сохранённое содержимое не удалось передать в TabHub.",
  "TabHub rejected this capture. Refresh and select the copy again.":
    "TabHub отклонил сохранение. Обновите список и выберите копию снова.",
  "{browser}, window {windowId}, tab {tabId}, installation {installation}":
    "{browser}, окно {windowId}, вкладка {tabId}, установка {installation}",
  "Page captured as content revision {revision}.":
    "Страница сохранена как версия содержимого {revision}.",
  "Capture outcome is unknown. Refresh before taking another action.":
    "Результат сохранения неизвестен. Обновите данные перед следующим действием.",
  "The refreshed page shows captured content revision {revision}. Continue with the summary without capturing again.":
    "После обновления найдена сохранённая версия содержимого {revision}. Продолжите создание сводки без повторного сохранения.",
  "The refreshed page does not show a new capture. Select an open copy before trying again.":
    "После обновления новое сохранение не найдено. Выберите открытую копию перед повторной попыткой.",
  "Page-summary capture was disabled while this action was starting. TabHub is refreshing feature settings.":
    "Сохранение страницы для сводки было отключено во время запуска действия. TabHub обновляет настройки функций.",
  "This browser session went offline. Refresh copies.":
    "Сессия браузера отключилась. Обновите список копий.",
  "Reload the updated extension, then refresh copies.":
    "Перезагрузите обновлённое расширение, затем обновите список копий.",
  "TabHub could not refresh capture availability.":
    "TabHub не удалось обновить доступность сохранения.",
  "Capture one exact open copy before creating a fresh summary.":
    "Сохраните одну точную открытую копию перед созданием новой сводки.",
  "Checking capture availability...": "Проверка доступности сохранения...",
  "Open this page in a connected browser to capture it.":
    "Откройте эту страницу в подключённом браузере, чтобы сохранить её.",
  "Open copy to capture": "Открытая копия для сохранения",
  "Capturing page...": "Сохранение страницы...",
  "Capture page": "Сохранить страницу",
  "Refresh copies": "Обновить копии",
  "TabHub could not check connected browser sessions.":
    "TabHub не удалось проверить подключённые сессии браузеров.",
  Acquisition: "Источник данных",
  "Cancel research": "Отменить исследование",
  "Capture failure: {code}": "Ошибка сохранения: {code}",
  "Capture results": "Результаты сохранения",
  "Capture selected open pages": "Сохранить выбранные открытые страницы",
  "Capture candidates are limited to the first 100 selected open pages.":
    "Кандидаты на сохранение ограничены первыми 100 выбранными открытыми страницами.",
  "Captured-only corpus": "Только ранее сохранённые материалы",
  "Checking exact open copies...": "Проверка точных открытых копий...",
  "Choose exact copies that are already open. Research capture never opens or navigates a URL.":
    "Выберите точные уже открытые копии. Сохранение для исследования никогда не открывает адрес и не переходит по нему.",
  "Confirm and refresh preflight": "Подтвердить и обновить проверку",
  "Confirm authenticated origins for this run":
    "Подтвердить источники с авторизацией для этого запуска",
  "Confirm sensitive origins for this run":
    "Подтвердить чувствительные источники для этого запуска",
  Discovered: "Найдено",
  Captured: "Сохранено",
  Eligible: "Подходит",
  Used: "Использовано",
  Missing: "Не сохранено",
  Failed: "Ошибки",
  Estimate: "Оценка затрат",
  "Include context explicitly marked as shareable with AI":
    "Включить контекст, явно разрешённый для ИИ",
  "Limitation: {reason}": "Ограничение: {reason}",
  "Invalid URL": "Некорректный URL",
  "Browser-internal page": "Внутренняя страница браузера",
  "Browser extension page": "Страница расширения браузера",
  "Local file": "Локальный файл",
  "Inline data URL": "Встроенный data URL",
  "Unsupported URL scheme": "Неподдерживаемая схема URL",
  "URL contains embedded credentials": "URL содержит встроенные учётные данные",
  "Localhost source": "Источник localhost",
  "Private IP source": "Источник с частным IP-адресом",
  "Private hostname source": "Источник с частным именем хоста",
  "Registrable domain unavailable": "Регистрируемый домен недоступен",
  "Sensitive source could not be safely confirmed":
    "Чувствительный источник нельзя безопасно подтвердить",
  "Captured text is empty": "Сохранённый текст пуст",
  "Source limit reached": "Достигнут лимит источников",
  "Corpus byte limit reached": "Достигнут лимит объёма корпуса",
  "Limitations: {items}": "Ограничения: {items}",
  "Logical-page mapping unavailable; refresh before researching this selection.":
    "Связь с логическими страницами недоступна; обновите данные перед исследованием выбранного.",
  "Maximum included sources": "Максимум включённых источников",
  "No already-open exact copies are available for missing pages.":
    "Для несохранённых страниц нет доступных точных открытых копий.",
  "No eligible captured pages": "Нет подходящих сохранённых страниц",
  "Improve the captured corpus": "Улучшить сохранённый корпус",
  "Open-copy data could not be loaded for capture.":
    "Не удалось загрузить открытые копии для сохранения.",
  "Connected browser scopes could not be loaded for capture.":
    "Не удалось проверить подключённые браузеры для сохранения.",
  "Open copies could not be mapped to logical pages.":
    "Не удалось сопоставить открытые копии с логическими страницами.",
  Retry: "Повторить",
  "No manifest exclusions.": "В манифесте нет исключений.",
  "Open copy for page {id}": "Открытая копия страницы {id}",
  "Page {id} · {state} · {access}": "Страница {id} · {state} · {access}",
  "Selected tab: {value}": "Выбранная вкладка: {value}",
  "Content revision: {value}": "Версия содержимого: {value}",
  "Content digest: {value}": "Отпечаток содержимого: {value}",
  "Origin digest: {value}": "Отпечаток источника: {value}",
  "Captured chunk: bytes {start}-{end} · digest {digest} · {truncation}":
    "Сохранённый фрагмент: байты {start}-{end} · отпечаток {digest} · {truncation}",
  "Captured chunk: none": "Сохранённый фрагмент: отсутствует",
  None: "Нет",
  "Page {id}: captured": "Страница {id}: сохранена",
  "Page {id}: failed ({code}); refresh copies and retry that page.":
    "Страница {id}: ошибка ({code}); обновите копии и повторите только для этой страницы.",
  "Per-run privacy confirmation": "Подтверждение приватности для этого запуска",
  "Prepare research": "Подготовить исследование",
  "Preparing research selection...": "Подготовка выбранных страниц для исследования...",
  "Research estimate": "Оценка исследования",
  "Approved research budget": "Подтверждённый бюджет исследования",
  "Approved budget": "Подтверждённый бюджет",
  "{count} maximum steps": "Максимум шагов: {count}",
  "{count} maximum tokens": "Максимум токенов: {count}",
  "Research preflight": "Проверка перед исследованием",
  "Research question": "Вопрос исследования",
  "Research selected pages": "Исследовать выбранные страницы",
  "Research supports at most 100 selected logical pages.":
    "Для исследования можно выбрать не более 100 логических страниц.",
  "Research this page": "Исследовать эту страницу",
  "Research this resource": "Исследовать этот ресурс",
  "Resource research unavailable: this page is not assigned to a Resource.":
    "Исследование ресурса недоступно: страница не привязана к ресурсу.",
  "Resource research unavailable: this page matches multiple Resources.":
    "Исследование ресурса недоступно: страница соответствует нескольким ресурсам.",
  "Resource research unavailable: this page is excluded from Resources.":
    "Исследование ресурса недоступно: страница исключена из ресурсов.",
  "Resource research unavailable: this Resource is not eligible.":
    "Исследование ресурса недоступно: этот ресурс не допущен.",
  "Review Resource assignment": "Проверить привязку к ресурсу",
  "Reviewing Resource assignment for page {id}.":
    "Проверка привязки к ресурсу для страницы {id}.",
  "Locating the requested review page...": "Поиск нужной страницы в очереди проверки...",
  "The requested page is no longer in classification review.":
    "Запрошенной страницы больше нет в очереди проверки классификации.",
  "Research: {status}": "Исследование: {status}",
  "Safe source manifest": "Безопасный манифест источников",
  "Safe snapshot manifest": "Безопасный манифест снимков",
  "{kind} snapshot · {identity} · digest {digest} · {bytes} B · {truncation}":
    "Снимок «{kind}» · {identity} · отпечаток {digest} · {bytes} Б · {truncation}",
  "Page context": "Контекст страницы",
  Relation: "Связь",
  "context entry {id}, page {pageId}": "запись контекста {id}, страница {pageId}",
  "context entry {id}, resource {resourceId}": "запись контекста {id}, ресурс {resourceId}",
  "page {pageId}, activity date {date}": "страница {pageId}, дата активности {date}",
  "relation {id}": "связь {id}",
  truncated: "усечён",
  complete: "полный",
  "Shareable snapshots: {count} · {bytes} B":
    "Разрешённые снимки: {count} · {bytes} Б",
  "Stage: {stage} · {completed}/{total}": "Этап: {stage} · {completed}/{total}",
  claimed: "Задание получено",
  provider_ready: "Запрос к ИИ подготовлен",
  terminal_publication: "Публикация результата",
  "Start research": "Запустить исследование",
  "The source manifest shows only page IDs, states, access classes, digests, and limits. Confirmation shows normalized origins only; full URL paths, captured text, private context, and titles remain hidden.":
    "Манифест источников показывает только ID страниц, состояния, классы доступа, отпечатки и ограничения. При подтверждении видны только нормализованные адреса источников; полные пути URL, сохранённый текст, приватный контекст и заголовки скрыты.",
  "Origins requiring confirmation": "Источники, требующие подтверждения",
  "Authenticated origin: {origin}": "Источник с авторизацией: {origin}",
  "Sensitive origin: {origin}": "Чувствительный источник: {origin}",
  "Unavailable: {reason}": "Недоступно: {reason}",
  "Browser extension offline": "Расширение браузера не подключено",
  "Extension update required": "Требуется обновление расширения",
  "Exact tab identity is incomplete": "Неполные данные точной вкладки",
  "This page type cannot be captured": "Страницу этого типа нельзя сохранить",
  "This tab is discarded; activate it before capture":
    "Вкладка выгружена из памяти; активируйте её перед сохранением",
  "Up to {cost}": "До {cost}",
  "Up to {duration}": "До {duration}",
  "{count} input tokens": "Входных токенов: {count}",
  "{count} output tokens": "Выходных токенов: {count}",
  "{count} provider calls": "Вызовов провайдера: {count}",
  queued: "в очереди",
  running: "выполняется",
  succeeded: "завершено",
  partial: "частичный результат",
  failed: "ошибка",
  cancelled: "отменено",
  superseded: "заменено новым запуском",
  "Research is disabled. Enable it and prepare a new preflight.":
    "Исследования отключены. Включите их и подготовьте новую проверку.",
  "The research provider is unavailable. Check provider settings and try again.":
    "Провайдер исследования недоступен. Проверьте настройки провайдера и повторите попытку.",
  "The approved research preflight is stale. Prepare it again.":
    "Подтверждённая проверка исследования устарела. Подготовьте её заново.",
  "The research budget is exhausted. Reduce the scope or approve a new budget.":
    "Бюджет исследования исчерпан. Уменьшите область или подтвердите новый бюджет.",
  "This research run cannot be cancelled now.":
    "Этот запуск исследования сейчас нельзя отменить.",
  "The research selection changed. Prepare a new preflight.":
    "Выбранные страницы изменились. Подготовьте новую проверку.",
  "This research scope is too large. Narrow it and try again.":
    "Область исследования слишком велика. Сузьте её и повторите попытку.",
  "Captured material is required before this research can start.":
    "Перед запуском исследования нужно сохранить материалы.",
  "Research history": "История исследований",
  "Close research history": "Закрыть историю исследований",
  "Research creation is disabled; published history remains available.":
    "Создание исследований отключено; опубликованная история остаётся доступной.",
  "Loading research history...": "Загрузка истории исследований...",
  "Latest attempt": "Последняя попытка",
  "Latest attempt: {status}": "Последняя попытка: {status}",
  "Created {date}": "Создано {date}",
  "Published reports": "Опубликованные отчёты",
  "Report heads": "Основные версии отчёта",
  "Current fresh report {id}": "Текущий актуальный отчёт {id}",
  "Last successful report {id}": "Последний успешный отчёт {id}",
  "Latest published report {id}": "Последний опубликованный отчёт {id}",
  "Research history is inconsistent. Retry before relying on it.":
    "История исследований содержит противоречия. Повторите загрузку, прежде чем на неё полагаться.",
  "No published reports yet.": "Опубликованных отчётов пока нет.",
  "Load more": "Загрузить ещё",
  "Version {version}": "Версия {version}",
  "View report version {version}": "Открыть отчёт версии {version}",
  "Parent report {id}": "Родительский отчёт {id}",
  "Loading report...": "Загрузка отчёта...",
  "Report version {version}": "Отчёт версии {version}",
  "Report {id}": "Отчёт {id}",
  "Report version {version} · run {run}": "Версия отчёта {version} · запуск {run}",
  "Current fresh": "Текущий актуальный",
  "Last successful": "Последний успешный",
  "Latest published": "Последний опубликованный",
  "Fresh report": "Актуальный отчёт",
  "Stale report": "Устаревший отчёт",
  "Redacted report state": "Скрытый отчёт",
  "Superseded report": "Заменённый отчёт",
  "Successful publication": "Успешная публикация",
  "Partial publication": "Частичная публикация",
  "Budget exhausted": "Бюджет исчерпан",
  "Corpus became stale": "Корпус устарел",
  "Research run queued": "Запуск исследования ожидает выполнения",
  "Research run in progress": "Исследование выполняется",
  "Research run published successfully": "Исследование успешно опубликовано",
  "Research run published partially": "Исследование опубликовано частично",
  "Research run failed": "Исследование завершилось ошибкой",
  "Research run cancelled": "Исследование отменено",
  "Research run superseded": "Исследование заменено новым запуском",
  "State: {state}": "Состояние: {state}",
  State: "Состояние",
  Publication: "Публикация",
  Reason: "Причина",
  "Parent report": "Родительский отчёт",
  fresh: "актуальный",
  stale: "устаревший",
  redacted: "скрытый",
  budget_exhausted: "бюджет исчерпан",
  corpus_became_stale: "корпус устарел",
  "Redacted report": "Скрытый отчёт",
  "This report has been redacted. Its private material is unavailable.":
    "Этот отчёт скрыт. Его приватные материалы недоступны.",
  "Executive summary": "Краткое резюме",
  "Value for you": "Ценность для вас",
  Capabilities: "Возможности",
  Limitations: "Ограничения",
  Risks: "Риски",
  Unknowns: "Неизвестное",
  "Next steps": "Следующие шаги",
  "None recorded.": "Ничего не указано.",
  "Report text": "Текст отчёта",
  "Claims and evidence": "Утверждения и доказательства",
  "No claims recorded.": "Утверждений нет.",
  "Redacted claim": "Скрытое утверждение",
  "Confidence: {confidence}": "Уверенность: {confidence}",
  Inference: "Вывод",
  "Inference rationale unavailable.": "Обоснование вывода недоступно.",
  "Evidence for claim {number}": "Доказательства для утверждения {number}",
  "Claim {ordinal} · id {id} · digest {digest}":
    "Утверждение {ordinal} · ID {id} · отпечаток {digest}",
  "Rationale digest: {digest}": "Отпечаток обоснования: {digest}",
  "Required evidence is unavailable.": "Необходимое доказательство недоступно.",
  "Captured page content": "Сохранённое содержимое страницы",
  "Page context snapshot": "Снимок контекста страницы",
  "Resource context snapshot": "Снимок контекста ресурса",
  "Activity snapshot": "Снимок активности",
  "Relation snapshot": "Снимок связи",
  "Evidence state: {state}": "Состояние доказательства: {state}",
  "Evidence {ordinal} · id {id}": "Доказательство {ordinal} · ID {id}",
  Valid: "Действительно",
  Invalid: "Недействительно",
  Redacted: "Скрыто",
  "Source {source} · revision {revision} · digest {digest}":
    "Источник {source} · ревизия {revision} · отпечаток {digest}",
  "Snapshot {id} · locator digest {locatorDigest} · excerpt digest {excerptDigest}":
    "Снимок {id} · отпечаток указателя {locatorDigest} · отпечаток фрагмента {excerptDigest}",
  "Invalid evidence unavailable: {reason}": "Недействительное доказательство недоступно: {reason}",
  "Redacted evidence unavailable: {reason}": "Скрытое доказательство недоступно: {reason}",
  "No reason recorded": "Причина не указана",
  "Bytes {start}–{end}": "Байты {start}–{end}",
  "Whole snapshot": "Весь снимок",
  "Evidence digests": "Отпечатки доказательства",
  "Locator digest: {digest}": "Отпечаток указателя: {digest}",
  "Excerpt digest: {digest}": "Отпечаток фрагмента: {digest}",
  Provenance: "Происхождение",
  Provider: "Провайдер",
  Model: "Модель",
  "Prompt version": "Версия промпта",
  "Pricing version": "Версия цен",
  "Input fingerprint": "Отпечаток входных данных",
  "Request ID": "ID запроса",
  "Terminal attempt": "Финальная попытка",
  Steps: "Шаги",
  "Input tokens": "Входные токены",
  "Output tokens": "Выходные токены",
  "Wall time": "Время выполнения",
  Generated: "Создано",
  Cost: "Стоимость",
  "Save next step as context": "Сохранить следующий шаг как контекст",
  "Choose one next step": "Выберите один следующий шаг",
  "Next action saved.": "Следующее действие сохранено.",
  "A selection cannot save one shared next action. Open one page or Resource and choose its next step there.":
    "Для набора нельзя сохранить одно общее следующее действие. Откройте одну страницу или ресурс и выберите следующий шаг там.",
  "Refine this report": "Уточнить этот отчёт",
  "Coverage comparison": "Сравнение охвата",
  "Coverage compared with parent report {id}": "Охват относительно родительского отчёта {id}",
  Measure: "Показатель",
  "Prior report": "Предыдущий отчёт",
  "Current preflight": "Текущая проверка",
  Delta: "Изменение",
  "Coverage compares available material only; it does not prove better research quality. Used sources are omitted because preflight usage stays zero until publication.":
    "Охват сравнивает только доступные материалы и не доказывает повышение качества исследования. Использованные источники не показаны, потому что до публикации их число в проверке равно нулю.",
  "TabHub could not load research report history":
    "TabHub не удалось загрузить историю отчётов исследования",
  "TabHub returned unreadable research report history.":
    "TabHub вернул нечитаемую историю отчётов исследования.",
  "TabHub returned mismatched research report history.":
    "TabHub вернул историю отчётов для другой цели исследования.",
  "TabHub could not load this research report":
    "TabHub не удалось загрузить этот отчёт исследования",
  "TabHub returned an unreadable research report.":
    "TabHub вернул нечитаемый отчёт исследования.",
  "TabHub returned mismatched research report detail.":
    "TabHub вернул другой отчёт или отчёт для другой цели исследования.",
  "Research refinement target does not match its parent report.":
    "Цель уточнения не совпадает с целью родительского отчёта.",
  "TabHub could not start this research refinement":
    "TabHub не удалось запустить уточнение исследования",
  "TabHub returned an unreadable research job.":
    "TabHub вернул нечитаемое задание исследования.",
  "TabHub returned an unexpected research refinement job.":
    "TabHub вернул неожиданное задание уточнения исследования.",
  "Research refinement parent does not match its preflight.":
    "Родительский отчёт уточнения не совпадает с предварительной проверкой.",
  "TabHub returned mismatched research progress.":
    "TabHub вернул ход выполнения другого исследования.",
  "Research history contains conflicting copies of one report.":
    "История исследований содержит противоречащие друг другу копии одного отчёта.",
  "Research history assigns one version to multiple reports.":
    "История исследований назначает одну версию нескольким отчётам.",
  "A selection cannot receive one shared next action.":
    "Набору страниц нельзя назначить одно общее следующее действие.",
  "TabHub could not save resource context":
    "TabHub не удалось сохранить контекст ресурса",
  "TabHub returned an unreadable resource-context update.":
    "TabHub вернул нечитаемый результат обновления контекста ресурса.",
  "TabHub returned an unexpected resource-context update.":
    "TabHub вернул неожиданный результат обновления контекста ресурса.",
  "TabHub could not update personal context":
    "TabHub не удалось обновить личный контекст",
  "TabHub returned an unreadable personal-context update.":
    "TabHub вернул нечитаемый результат обновления личного контекста.",
  "TabHub returned an unexpected personal-context update.":
    "TabHub вернул неожиданный результат обновления личного контекста.",
  "TabHub could not read research progress":
    "TabHub не удалось прочитать ход исследования",
  "TabHub returned unreadable research progress.":
    "TabHub вернул нечитаемый ход исследования.",
  "TabHub could not start this research run":
    "TabHub не удалось запустить это исследование",
  "TabHub returned an unexpected research job.":
    "TabHub вернул неожиданное задание исследования.",
  "TabHub could not cancel this research run":
    "TabHub не удалось отменить это исследование",
  "TabHub could not prepare this research run":
    "TabHub не удалось подготовить это исследование",
  "TabHub returned unreadable research preflight data.":
    "TabHub вернул нечитаемые данные предварительной проверки исследования.",
  "TabHub returned mismatched research preflight data.":
    "TabHub вернул предварительную проверку для другой цели исследования.",
  "ACQUISITION_RESOURCE_MEMBERSHIP_MISMATCH": "Страница больше не относится к этому ресурсу",
  "AUTH_REQUIRED": "Требуется авторизация",
  "Acquisition stage: {stage}": "Этап получения: {stage}",
  "Acquisition state": "Состояние получения",
  "Acquisition time limit in milliseconds": "Лимит времени получения в миллисекундах",
  "Action": "Действие",
  "Action {id}": "Действие {id}",
  "Active actions": "Активные действия",
  "Ambiguous pages": "Неоднозначные страницы",
  "Approved origins": "Разрешённые источники",
  "Approved origins for this run": "Источники, разрешённые для этого запуска",
  "Approved public origins": "Разрешённые публичные источники",
  "BUDGET_EXHAUSTED": "Бюджет исчерпан",
  "Blocked pages": "Заблокированные страницы",
  "Body idle timeout": "Тайм-аут бездействия тела ответа",
  "Browser network": "Сеть браузера",
  "Byte caps": "Лимиты объёма данных",
  "CANCELLED": "Отменено",
  "CHALLENGE_PAGE": "Страница проверки доступа",
  "CONSENT_EXPIRED_IN_FLIGHT": "Согласие истекло во время получения",
  "Cancelled": "Отменено",
  "Captured corpus coverage": "Охват сохранённого корпуса",
  "Captured corpus manifest": "Манифест сохранённого корпуса",
  "Captured corpus snapshots": "Снимки сохранённого корпуса",
  "Captured pages": "Сохранённые страницы",
  "Completed {date}": "Завершено {date}",
  "Connect timeout": "Тайм-аут подключения",
  "Consent and safe policy": "Согласие и политика безопасности",
  "Consent duration": "Срок действия согласия",
  "Consent expires": "Согласие истекает",
  "Consent expires at {date}": "Согласие истекает {date}",
  "Consent state": "Состояние согласия",
  "Coordinator: {status}": "Координатор: {status}",
  "Cost cap": "Лимит стоимости",
  "DNS timeout": "Тайм-аут DNS",
  "DNS_RESULT_UNKNOWN": "Результат DNS неизвестен",
  "Daily live starts are exhausted. {count} remain; reset at {date} UTC.":
    "Дневной лимит онлайн-запусков исчерпан. Осталось: {count}; сброс в {date} UTC.",
  "Daily start limit resets at {date} UTC": "Дневной лимит запусков сбросится {date} UTC",
  "Daily starts remaining: {count}": "Осталось запусков на сегодня: {count}",
  "Delete permanently": "Удалить безвозвратно",
  "Delete this research run": "Удалить этот запуск исследования",
  "Delete this resource's research history": "Удалить историю исследований этого ресурса",
  "Deleted {count} stored rows": "Удалено сохранённых записей: {count}",
  "Deleting...": "Удаление...",
  "Deletion committed": "Удаление подтверждено",
  "Deletion completed": "Удаление завершено",
  "Deletion error: {message}": "Ошибка удаления: {message}",
  "Deletion failed": "Удаление не выполнено",
  "Deletion is on hold": "Удаление приостановлено",
  "Deletion requires manual review": "Удаление требует ручной проверки",
  "Depth {depth}": "Глубина {depth}",
  "Egress": "Исходящее соединение",
  "Enter 1 to 16 public HTTPS origins, one per line.":
    "Введите от 1 до 16 публичных HTTPS-источников, по одному в строке.",
  "Estimate: {calls} calls, {input} input tokens, {output} output tokens, up to {cost}, up to {duration}.":
    "Оценка: {calls} вызовов, {input} входных токенов, {output} выходных токенов, до {cost} и до {duration}.",
  "Exact consent returned by TabHub": "Точные условия согласия от TabHub",
  "Exact live research consent": "Точное согласие на онлайн-исследование",
  "FETCH_COMPLETED": "Получение завершено",
  "Fallback": "Резервный способ",
  "Final dossier {reportId} includes live acquisition evidence.":
    "Итоговое досье {reportId} содержит материалы онлайн-получения.",
  "Final research has not started": "Итоговое исследование ещё не запущено",
  "Final research state": "Состояние итогового исследования",
  "Final research: {status}": "Итоговое исследование: {status}",
  "Final run {runId}, source {sourceId}": "Итоговый запуск {runId}, источник {sourceId}",
  "GET only; no cookies, credentials, or redirects":
    "Только GET; без cookie, учётных данных и перенаправлений",
  "HTTPS origins, one per line": "HTTPS-источники, по одному в строке",
  "HTTP_CLIENT_ERROR": "Ошибка HTTP на стороне клиента",
  "HTTP_INFORMATIONAL": "Информационный ответ HTTP",
  "HTTP_REDIRECT": "Перенаправление HTTP",
  "HTTP_SERVER_ERROR": "Ошибка HTTP на стороне сервера",
  "HTTP_SUCCESS": "Успешный ответ HTTP",
  "Handed off": "Передано итоговому исследованию",
  "Headers timeout": "Тайм-аут заголовков",
  "Hidden": "Скрыто",
  "I approve this exact Resource, origin list, policy, limits, corpus, and fingerprint for one run.":
    "Я одобряю именно этот ресурс, список источников, политику, лимиты, корпус и отпечаток для одного запуска.",
  "INSUFFICIENT_PUBLIC_TEXT": "Недостаточно публичного текста",
  "INVALID_UTF8": "Некорректный текст UTF-8",
  "IPV4_REQUIRED_V1": "Требуется публичный IPv4",
  "LIVE_ACQUISITION_DISABLED": "Онлайн-получение отключено",
  "LIVE_ACQUISITION_DISABLED_IN_FLIGHT": "Онлайн-получение отключено во время запуска",
  "LIVE_ACQUISITION_RESOURCE_REQUIRED": "Для онлайн-получения требуется ресурс",
  "LIVE_ACQUISITION_TARGET_UNSUPPORTED": "Цель не поддерживает онлайн-получение",
  "Live Resource research": "Онлайн-исследование ресурса",
  "Live acquisition audit": "Аудит онлайн-получения",
  "Live acquisition completed": "Онлайн-получение завершено",
  "Live acquisition failed": "Онлайн-получение завершилось с ошибкой",
  "Live acquisition is being purged": "Данные онлайн-получения удаляются",
  "Live acquisition is running": "Идёт онлайн-получение",
  "Live acquisition limits": "Лимиты онлайн-получения",
  "Live acquisition needs review": "Онлайн-получение требует проверки",
  "Live acquisition progress": "Ход онлайн-получения",
  "Live acquisition was blocked": "Онлайн-получение заблокировано",
  "Live acquisition was cancelled": "Онлайн-получение отменено",
  "Live acquisition was redacted": "Данные онлайн-получения скрыты",
  "Live success: {value}": "Успешное онлайн-получение: {value}",
  "Loading live acquisition status...": "Загрузка состояния онлайн-получения...",
  "Local TabHub server": "Локальный сервер TabHub",
  "META_REFRESH": "Перенаправление через meta refresh",
  "Manifest {id}": "Манифест {id}",
  "Maximum AI research cost": "Максимальная стоимость ИИ-исследования",
  "Maximum AI research cost in USD": "Максимальная стоимость ИИ-исследования в USD",
  "Maximum depth": "Максимальная глубина",
  "Maximum header bytes": "Максимальный объём заголовков",
  "Maximum link depth": "Максимальная глубина переходов",
  "Maximum network actions": "Максимум сетевых действий",
  "Maximum pages": "Максимум страниц",
  "Maximum source bytes": "Максимальный объём одного источника",
  "Maximum total bytes": "Максимальный общий объём",
  "May differ from browser VPN or proxy": "Может отличаться от VPN или прокси браузера",
  "Method: {method}. No cookies, credentials, or authorization headers are sent.":
    "Метод: {method}. Cookie, учётные данные и заголовки авторизации не отправляются.",
  "Minimum per-origin cadence: {duration}.": "Минимальный интервал для одного источника: {duration}.",
  "Mixed live acquisition completed": "Смешанное онлайн-получение завершено",
  "Mixed result: {usable} usable live sources and {omissions} visible omissions.":
    "Смешанный результат: пригодных онлайн-источников — {usable}, видимых пропусков — {omissions}.",
  "NO_ELIGIBLE_SOURCE": "Нет подходящих источников",
  "Network action cap": "Лимит сетевых действий",
  "Network actions": "Сетевые действия",
  "No": "Нет",
  "No live dossier was produced from this acquisition.":
    "По результатам этого получения онлайн-досье не создано.",
  "No usable live sources": "Нет пригодных онлайн-источников",
  "None yet": "Пока нет",
  "Not applicable": "Не применимо",
  "Not available": "Недоступно",
  "Omission: {reason}": "Причина пропуска: {reason}",
  "Ordered acquisition actions": "Упорядоченные действия получения",
  "Origins are hidden during privacy processing.": "Источники скрыты на время приватного удаления.",
  "Outcome code: {code}": "Код результата: {code}",
  "Outgoing request policy": "Политика исходящих запросов",
  "PARTIAL_RESPONSE": "Получен неполный ответ",
  "POLICY_BLOCKED": "Заблокировано политикой безопасности",
  "PROVIDER_UNAVAILABLE": "Провайдер недоступен",
  "PURGE_WAITING_FOR_ACTION": "Удаление ожидает завершения действия",
  "Page": "Страница",
  "Page and depth cap": "Лимит страниц и глубины",
  "Page {id}: {state}; source {source}; method {method}":
    "Страница {id}: {state}; источник {source}; способ {method}",
  "Partially completed": "Завершено частично",
  "Pending": "Ожидание",
  "Pending final research": "Ожидается итоговое исследование",
  "Permanently delete research data?": "Безвозвратно удалить данные исследования?",
  "Planned actions": "Запланированные действия",
  "Preparing live research review...": "Подготовка проверки онлайн-исследования...",
  "Privacy deletion is unavailable": "Приватное удаление недоступно",
  "Privacy purge is in progress. Source material and provenance are hidden.":
    "Идёт приватное удаление. Материалы источников и происхождение скрыты.",
  "Progress and coverage": "Ход и охват",
  "Provider: {provider}; model: {model}; prompt: {prompt}; pricing: {pricing}":
    "Провайдер: {provider}; модель: {model}; промпт: {prompt}; тариф: {pricing}",
  "Public web requests leave from the local TabHub server. Its network route may differ from your browser VPN or proxy, and browser extensions and signed-in browser sessions do not apply.":
    "Публичные веб-запросы отправляются с локального сервера TabHub. Его сетевой маршрут может отличаться от VPN или прокси браузера; расширения и авторизованные сеансы браузера не применяются.",
  "Queued": "В очереди",
  "RESEARCH_WORKFLOW_UNSUPPORTED": "Процесс исследования не поддерживается",
  "RESPONSE_SIZE_LIMIT": "Превышен лимит размера ответа",
  "RUNTIME_RESTARTED_BEFORE_REQUEST": "Среда перезапустилась до отправки запроса",
  "Ready to delete": "Готово к удалению",
  "Redirects are rejected and never followed.": "Перенаправления отклоняются и не выполняются.",
  "Refresh status": "Обновить состояние",
  "Request policy": "Политика запросов",
  "Request timeout": "Тайм-аут запроса",
  "Requests leave from the local TabHub server, not the browser. Browser VPN or proxy routing may differ.":
    "Запросы отправляются с локального сервера TabHub, а не из браузера. Маршрутизация VPN или прокси браузера может отличаться.",
  "Research public pages from this Resource": "Исследовать публичные страницы этого ресурса",
  "Research run {run} was deleted and its report is redacted.":
    "Запуск исследования {run} удалён, а его отчёт скрыт.",
  "Research scope": "Область исследования",
  "Reserved pages": "Зарезервированные страницы",
  "Resource live research": "Онлайн-исследование ресурса",
  "Resource {id}": "Ресурс {id}",
  "Resource {resourceId}": "Ресурс {resourceId}",
  "Resource: {resource}": "Ресурс: {resource}",
  "Retry deletion": "Повторить удаление",
  "Review live research": "Проверить онлайн-исследование",
  "Previous live review summary": "Предыдущая сводка проверки онлайн-исследования",
  "This safe summary was restored after reload. Review again before approval or start.":
    "Эта безопасная сводка восстановлена после перезагрузки. Перед одобрением или запуском выполните проверку заново.",
  "No captured corpus entries were returned.": "В сохранённом корпусе нет записей.",
  "No acquisition actions were recorded for this run.": "Для этого запуска не записано действий получения данных.",
  "Captured-only research is required. Open the captured research flow for an exact already-open tab.":
    "Требуется исследование только сохранённых данных. Откройте поток сохранённого исследования для точной уже открытой вкладки.",
  "Exact live fallback source": "Точный источник резервного сохранения",
  "Run {jobId}, action {actionId}; reason {reason}.":
    "Запуск {jobId}, действие {actionId}; причина: {reason}.",
  "Only an already-open exact copy of this URL can be captured.":
    "Можно сохранить только точную уже открытую копию этого URL.",
  "Robots": "Robots",
  "Robots actions": "Действия robots.txt",
  "Robots and cadence": "Robots.txt и частота запросов",
  "Robots and page actions in server-projected order":
    "Действия robots.txt и страниц в порядке, заданном сервером",
  "Robots policy is checked before page requests.": "Правила robots.txt проверяются до запросов страниц.",
  "Robots required; at least {milliseconds} ms":
    "Проверка robots.txt обязательна; интервал не менее {milliseconds} мс",
  "Run states": "Состояния запуска",
  "Running": "Выполняется",
  "SENSITIVE_URL_CAPTURE_REQUIRED": "Требуется сохранение чувствительного URL из открытой вкладки",
  "SPA_SHELL": "Обнаружена оболочка одностраничного приложения",
  "SUBJECT_FORGOTTEN": "Объект удалён",
  "Safe material": "Безопасные сведения",
  "Shareable snapshots: {count}": "Доступных для ИИ снимков: {count}",
  "Source provenance": "Происхождение источника",
  "Source kind: {kind} · acquisition method: {method}":
    "Тип источника: {kind} · способ получения: {method}",
  "Source usable: {value}": "Источник пригоден: {value}",
  "Start approved live research": "Запустить одобренное онлайн-исследование",
  "Starting live research...": "Запуск онлайн-исследования...",
  "State and outcome": "Состояние и результат",
  "Succeeded": "Успешно",
  "Superseded": "Заменено следующим этапом",
  "TRANSPORT_CONNECT_FAILURE": "Не удалось подключиться",
  "TRANSPORT_DNS_FAILURE": "Ошибка DNS",
  "TRANSPORT_TIMEOUT": "Тайм-аут транспорта",
  "TRANSPORT_TLS_FAILURE": "Ошибка TLS",
  "The coordinator was superseded after handoff; this is not a failure.":
    "После передачи итоговому исследованию координатор был заменён следующим этапом — это не ошибка.",
  "This irreversible action deletes the selected research data and its stored history.":
    "Это необратимое действие удалит выбранные данные исследования и сохранённую историю.",
  "This run was redacted. Source material and provenance are hidden.":
    "Данные этого запуска скрыты. Материалы источников и происхождение недоступны.",
  "Updated {date}": "Обновлено {date}",
  "Updating deletion status...": "Обновление состояния удаления...",
  "Usability": "Пригодность",
  "Usable live sources": "Пригодные онлайн-источники",
  "Use exact open-tab capture fallback": "Использовать точное сохранение открытой вкладки",
  "Use exact tab capture": "Сохранить точную копию вкладки",
  "Visible omissions": "Видимые пропуски",
  "Visited pages": "Посещённые страницы",
  "WORKFLOW_AMBIGUOUS": "Процесс завершён неоднозначно",
  "WORKFLOW_BLOCKED": "Процесс заблокирован",
  "WORKFLOW_CANCELLED": "Процесс отменён",
  "WORKFLOW_COMPLETED": "Процесс завершён",
  "WORKFLOW_FAILED": "Ошибка процесса",
  "Waiting for provider settlement": "Ожидание окончательного расчёта провайдера",
  "Waiting for safe deletion": "Ожидание безопасного удаления",
  "Workflow outcome: {outcome}": "Результат процесса: {outcome}",
  "Yes": "Да",
  "active": "активно",
  "activity": "активность",
  "ambiguous": "неоднозначно",
  "authorized": "разрешено",
  "blocked": "заблокировано",
  "captured": "сохранено",
  "captured_only": "только сохранённые данные",
  "completed": "завершено",
  "consumed": "использовано",
  "discovered": "обнаружено",
  "eligible": "подходит",
  "exact_capture": "точное сохранение вкладки",
  "expired": "истекло",
  "handoff": "передано итоговому исследованию",
  "https://example.com": "https://example.com",
  "inventory": "инвентаризация",
  "live_acquisition": "онлайн-получение",
  "missing": "отсутствует",
  "page_context": "контекст страницы",
  "pending": "ожидание",
  "planned": "запланировано",
  "resolution_started": "начато определение адреса",
  "resolved": "адрес определён",
  "resource_context": "контекст ресурса",
  "revoked": "отозвано",
  "safe_public_http_v1": "безопасный публичный HTTP v1",
  "started": "запущено",
  "unusable": "непригодно",
  "used": "использовано",
  "{amount} USD": "{amount} USD",
  "{completed} of {total} deletion steps completed":
    "Выполнено шагов удаления: {completed} из {total}",
  "{kind} snapshot {ordinal}: {bytes} bytes; digest {digest}; {truncation}":
    "Снимок «{kind}» {ordinal}: {bytes} байт; дайджест {digest}; {truncation}",
  "{milliseconds} ms": "{milliseconds} мс",
  "{pages} pages; depth {depth}": "Страниц: {pages}; глубина: {depth}",
  "{source} per source; {total} total; {headers} headers":
    "На источник: {source}; всего: {total}; заголовки: {headers}",
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

const personalContextApiErrorTranslationKeys = {
  CONTEXT_REVIEW_NOT_ALLOWED:
    "Only AI suggestions can be accepted or rejected.",
  CONTEXT_ENTRY_NOT_CURRENT:
    "This context entry is no longer current. Reload personal context and try again.",
  CONTEXT_STATE_INVALID:
    "This context entry cannot be changed in its current state. Reload personal context and try again.",
  CONTEXT_SUBJECT_MISMATCH:
    "This context entry belongs to a different page. Reload personal context and try again.",
  IDEMPOTENCY_KEY_CONFLICT:
    "This action conflicts with an earlier request. Reload and try again.",
  LOCAL_CAPABILITY_REQUIRED:
    "Personal context requires a paired local browser. Pair this browser and try again.",
  NOT_FOUND:
    "The requested personal context no longer exists. Reload and try again.",
  SESSION_INTENT_STATE_INVALID:
    "This open-tab intent cannot be changed in its current state. Reload it and try again.",
  SESSION_INTENT_SUBJECT_MISMATCH:
    "This open-tab intent belongs to a different page. Refresh open copies and try again.",
  SESSION_SCOPE_STALE:
    "This open tab changed. Refresh its copies and try again.",
  VALIDATION_ERROR:
    "TabHub rejected invalid personal-context data. Review the fields and try again.",
} as const;

const apiErrorTranslationKeys: Record<string, string> = {
  ...personalContextApiErrorTranslationKeys,
  KNOWLEDGE_NODE_NOT_FOUND: "One of the relation endpoints no longer exists.",
  RELATION_NOT_FOUND: "This relation no longer exists.",
  RESOURCE_ASSIGNMENT_CONFLICT: "This page classification changed. Reload the review queue and try again.",
  RESOURCE_NOT_ACTIVE: "This resource is no longer active.",
  RESOURCE_RULESET_VERSION_CONFLICT: "Resource rules changed. Their latest version was reloaded; review and try again.",
  RESOURCE_VERSION_CONFLICT: "This resource changed. Its latest details were reloaded; review and try again.",
  PRIORITY_RULE_LANGUAGE_UNSUPPORTED:
    "This rule is unsupported. Review the highlighted source and try again.",
  INVALID_PRIORITY_RULESET:
    "These priority rules are invalid. Review their conditions and effects.",
  PRIORITY_RULESET_CONFLICT:
    "Active priority rules changed. Reload them and preview again.",
  PRIORITY_RULESET_NOT_FOUND:
    "Personal priority rules no longer exist. Reload and try again.",
  PRIORITY_RULESET_VERSION_NOT_FOUND:
    "This priority-rule version no longer exists. Reload the version history.",
  PRIORITY_RULE_PREVIEW_LIMIT:
    "This preview is too large. Narrow the rule set and try again.",
  PRIORITY_RULE_PREVIEW_TIMEOUT:
    "This preview took too long. Narrow the rule set and try again.",
  PRIORITY_FEATURE_UNAVAILABLE:
    "Personal priority rules are unavailable right now.",
  FEATURE_DISABLED: "Research is disabled. Enable it and prepare a new preflight.",
  RESEARCH_PROVIDER_UNAVAILABLE:
    "The research provider is unavailable. Check provider settings and try again.",
  RESEARCH_PREFLIGHT_STALE:
    "The approved research preflight is stale. Prepare it again.",
  JOB_BUDGET_EXHAUSTED:
    "The research budget is exhausted. Reduce the scope or approve a new budget.",
  JOB_NOT_CANCELLABLE: "This research run cannot be cancelled now.",
  RESEARCH_SELECTION_INVALID:
    "The research selection changed. Prepare a new preflight.",
  RESEARCH_SCOPE_TOO_LARGE:
    "This research scope is too large. Narrow it and try again.",
  RESEARCH_CAPTURE_REQUIRED:
    "Captured material is required before this research can start.",
  SELF_RELATION_NOT_ALLOWED: "A node cannot be related to itself.",
  SYSTEM_TAG_IMMUTABLE: "The default topic is managed automatically.",
  TAB_NOT_FOUND: "This tab no longer exists.",
  TAG_ASSIGNMENT_NOT_FOUND: "This topic is no longer assigned to the tab.",
  TAG_CONFLICT: "A topic with this name already exists at that level.",
  TAG_HAS_CHILDREN: "Move or delete the subtopics before deleting this topic.",
  TAG_HIERARCHY_CONFLICT:
    "A topic cannot be moved inside itself or one of its subtopics.",
  TAG_NOT_FOUND: "This topic no longer exists.",
};

const bilingualApiErrors = new Set(
  [
    ...Object.keys(personalContextApiErrorTranslationKeys),
    "RESOURCE_ASSIGNMENT_CONFLICT",
    "RESOURCE_NOT_ACTIVE",
    "RESOURCE_RULESET_VERSION_CONFLICT",
    "RESOURCE_VERSION_CONFLICT",
    "PRIORITY_RULE_LANGUAGE_UNSUPPORTED",
    "INVALID_PRIORITY_RULESET",
    "PRIORITY_RULESET_CONFLICT",
    "PRIORITY_RULESET_NOT_FOUND",
    "PRIORITY_RULESET_VERSION_NOT_FOUND",
    "PRIORITY_RULE_PREVIEW_LIMIT",
    "PRIORITY_RULE_PREVIEW_TIMEOUT",
    "PRIORITY_FEATURE_UNAVAILABLE",
    "FEATURE_DISABLED",
    "RESEARCH_PROVIDER_UNAVAILABLE",
    "RESEARCH_PREFLIGHT_STALE",
    "JOB_BUDGET_EXHAUSTED",
    "JOB_NOT_CANCELLABLE",
    "RESEARCH_SELECTION_INVALID",
    "RESEARCH_SCOPE_TOO_LARGE",
    "RESEARCH_CAPTURE_REQUIRED",
  ],
);

export function localizedErrorMessage(locale: Locale, cause: unknown): string {
  const message =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : translate(locale, "Something went wrong.");
  const errorCode =
    cause instanceof Error &&
    "code" in cause &&
    typeof cause.code === "string"
      ? cause.code
      : undefined;
  const apiTranslationKey =
    errorCode === undefined ? undefined : apiErrorTranslationKeys[errorCode];
  if (
    apiTranslationKey !== undefined &&
    (locale === "ru" || (errorCode !== undefined && bilingualApiErrors.has(errorCode)))
  ) {
    return translate(locale, apiTranslationKey);
  }
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
    if (relay.code === "EXTENSION_PROTOCOL_UNSUPPORTED") {
      return translate(
        locale,
        "Reload the updated TabHub extension in that browser before closing tabs with the middle mouse button.",
      );
    }
    if (relay.code === "FOREGROUND_HANDOFF_FAILED") {
      return translate(
        locale,
        "Windows activated the tab, but could not bring its browser to the foreground. Try again.",
      );
    }
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

export function formatDuration(locale: Locale, milliseconds: number): string {
  const isPositiveSubsecond =
    Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds < 1_000;
  const totalSeconds = Number.isFinite(milliseconds)
    ? Math.max(0, Math.floor(milliseconds / 1_000))
    : 0;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const units =
    locale === "ru"
      ? { hour: "ч", minute: "мин", second: "с" }
      : { hour: "h", minute: "m", second: "s" };

  if (isPositiveSubsecond) {
    return `<1${locale === "ru" ? " " : ""}${units.second}`;
  }

  if (hours > 0) {
    return [
      `${hours}${locale === "ru" ? " " : ""}${units.hour}`,
      ...(minutes > 0
        ? [`${minutes}${locale === "ru" ? " " : ""}${units.minute}`]
        : []),
    ].join(" ");
  }
  if (minutes > 0) {
    return [
      `${minutes}${locale === "ru" ? " " : ""}${units.minute}`,
      ...(seconds > 0
        ? [`${seconds}${locale === "ru" ? " " : ""}${units.second}`]
        : []),
    ].join(" ");
  }
  return `${seconds}${locale === "ru" ? " " : ""}${units.second}`;
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
  formatDuration: (milliseconds: number) => string;
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
  formatDuration: (value) => formatDuration("en", value),
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
      formatDuration: (input) => formatDuration(locale, input),
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
