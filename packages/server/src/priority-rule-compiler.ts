import { createHash } from "node:crypto";

import {
  canonicalJsonV1 as canonicalJson,
  personalPriorityCompilerVersion,
  personalPriorityNaturalLanguageGrammarV1,
  personalPriorityRuleSchema,
  type PersonalPriorityRule,
} from "@tabhub/shared";

export interface PriorityRuleSourceSpan {
  readonly start: number;
  readonly end: number;
}

export interface CompiledPriorityRuleSpan {
  readonly ruleKey: string;
  readonly rule: PriorityRuleSourceSpan;
  readonly conditions: readonly PriorityRuleSourceSpan[];
  readonly effects: readonly PriorityRuleSourceSpan[];
}

export interface PriorityRuleCompilerResult {
  readonly compilerVersion: typeof personalPriorityCompilerVersion;
  readonly additions: readonly PersonalPriorityRule[];
  readonly sourceSpans: readonly CompiledPriorityRuleSpan[];
  readonly readableRules: readonly PriorityRuleReadableSentence[];
}

export interface PriorityRuleReadableSentence {
  readonly ruleKey: string;
  readonly en: string;
  readonly ru: string;
}

export class PriorityRuleLanguageError extends Error {
  readonly code = "PRIORITY_RULE_LANGUAGE_UNSUPPORTED" as const;

  constructor(message: string, readonly span: PriorityRuleSourceSpan) {
    super(message);
    this.name = "PriorityRuleLanguageError";
  }
}

type Locale = "en" | "ru";
type Condition = PersonalPriorityRule["when"]["all"][number];
type Effect = PersonalPriorityRule["effect"];

const subjectNames = Object.fromEntries((["en", "ru"] as const).map((locale) => [
  locale,
  Object.fromEntries(personalPriorityNaturalLanguageGrammarV1.subjects.map((entry) =>
    [entry.phrases[locale], entry.value])),
])) as Record<Locale, Record<string, PersonalPriorityRule["appliesTo"]>>;

const signalNames = Object.fromEntries((["en", "ru"] as const).map((locale) => [
  locale,
  Object.fromEntries(personalPriorityNaturalLanguageGrammarV1.signals.map((entry) =>
    [entry.phrases[locale], entry.value])),
])) as Record<Locale, Record<string, Condition["signal"]>>;

const booleanSignals = new Set<string>(personalPriorityNaturalLanguageGrammarV1.signals
  .filter((entry) => entry.kind === "boolean").map((entry) => entry.value));
const numericSignals = new Set<string>(personalPriorityNaturalLanguageGrammarV1.signals
  .filter((entry) => entry.kind === "numeric").map((entry) => entry.value));
const durationSignals = new Set(["active_use_30d_ms", "on_screen_30d_ms"]);
const effectNames = Object.fromEntries((["en", "ru"] as const).map((locale) => [
  locale,
  Object.fromEntries(personalPriorityNaturalLanguageGrammarV1.effects.map((entry) =>
    [entry.value, entry.phrases[locale]])),
])) as Record<Locale, Record<keyof Effect, string>>;

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function codePointOffset(source: string, utf16Offset: number): number {
  return [...source.slice(0, utf16Offset)].length;
}

function trimSpan(source: string, start: number, end: number): PriorityRuleSourceSpan {
  while (start < end && /\s/u.test(source[start]!)) start += 1;
  while (end > start && /\s/u.test(source[end - 1]!)) end -= 1;
  return { start, end };
}

function splitOutsideQuotes(
  source: string,
  start: number,
  end: number,
  separator: string,
): PriorityRuleSourceSpan[] {
  const spans: PriorityRuleSourceSpan[] = [];
  let quoted = false;
  let pieceStart = start;
  for (let index = start; index < end; index += 1) {
    if (source[index] === '"') quoted = !quoted;
    if (!quoted && source.startsWith(separator, index)) {
      spans.push(trimSpan(source, pieceStart, index));
      pieceStart = index + separator.length;
      index += separator.length - 1;
    }
  }
  spans.push(trimSpan(source, pieceStart, end));
  return spans;
}

function unsupported(message: string, span: PriorityRuleSourceSpan): never {
  throw new PriorityRuleLanguageError(message, span);
}

function namedSignal(
  locale: Locale,
  text: string,
): { signal: string; rest: string } | undefined {
  const entries = Object.entries(signalNames[locale]).sort((a, b) => b[0].length - a[0].length);
  for (const [name, signal] of entries) {
    if (text === name || text.startsWith(`${name} `)) {
      return { signal, rest: text.slice(name.length).trimStart() };
    }
  }
  return undefined;
}

function parseQuotedValues(text: string, span: PriorityRuleSourceSpan): string[] {
  const values: string[] = [];
  let rest = text.trim();
  while (rest !== "") {
    const match = /^"([A-Za-zА-Яа-яЁё0-9 /._:\-]{1,256})"(?:\s*,\s*|$)/u.exec(rest);
    if (match === null) unsupported("Expected a comma-separated quoted EN/RU value", span);
    values.push(match[1]!);
    rest = rest.slice(match[0].length);
  }
  if (values.length < 1 || values.length > 100 || new Set(values).size !== values.length) {
    unsupported("A string condition requires 1..100 unique quoted values", span);
  }
  return [...values].sort();
}

function numericValue(
  signal: string,
  text: string,
  span: PriorityRuleSourceSpan,
): number {
  const match = /^(-?\d+(?:\.\d+)?)(?:\s+(ms|s|min|h|d|мс|с|мин|ч|д))?$/u.exec(text);
  if (match === null) unsupported("Expected a bounded number and optional unit", span);
  const raw = Number(match[1]);
  if (!Number.isFinite(raw) || raw < 0) unsupported("Numeric values must be non-negative", span);
  const unit = match[2];
  if (unit !== undefined && !durationSignals.has(signal)) {
    unsupported("Units are supported only for 30-day time signals", span);
  }
  const factors: Record<string, number> = {
    ms: 1, мс: 1, s: 1_000, с: 1_000, min: 60_000, мин: 60_000,
    h: 3_600_000, ч: 3_600_000, d: 86_400_000, д: 86_400_000,
  };
  const value = raw * (unit === undefined ? 1 : factors[unit]!);
  if (unit !== undefined && !Number.isSafeInteger(value)) {
    unsupported("Numeric value is outside the supported range", span);
  }
  if (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER) {
    unsupported("Numeric value is outside the supported range", span);
  }
  return value;
}

function parseCondition(locale: Locale, source: string, span: PriorityRuleSourceSpan): Condition {
  const text = source.slice(span.start, span.end).replace(/\s+/gu, " ").trim();
  const named = namedSignal(locale, text);
  if (named === undefined) unsupported("Unknown priority signal", span);
  const signal = named.signal;
  if (booleanSignals.has(signal)) {
    const match = locale === "en"
      ? /^equals\s+(true|false)$/u.exec(named.rest)
      : /^равно\s+(да|нет)$/u.exec(named.rest);
    if (match === null) unsupported("Boolean signals require an exact boolean equality", span);
    return {
      signal: signal as Extract<Condition, { operator: "eq" }>['signal'],
      operator: "eq",
      value: match[1] === "true" || match[1] === "да",
    } as Condition;
  }
  if (numericSignals.has(signal)) {
    const operators = locale === "en"
      ? [["equals", "eq"], ["at least", "gte"], ["at most", "lte"]] as const
      : [["равно", "eq"], ["не менее", "gte"], ["не более", "lte"]] as const;
    const operator = operators.find(([word]) =>
      named.rest === word || named.rest.startsWith(`${word} `));
    if (operator === undefined) unsupported("Numeric signal requires equals/at least/at most", span);
    return {
      signal: signal as Extract<Condition, { operator: "gte" }>['signal'],
      operator: operator[1],
      value: numericValue(signal, named.rest.slice(operator[0].length).trim(), span),
    } as Condition;
  }
  const keyword = locale === "en" ? "in" : "входит";
  if (!(named.rest === keyword || named.rest.startsWith(`${keyword} `))) {
    unsupported("String-set signals require an in condition", span);
  }
  return {
    signal: signal as Extract<Condition, { operator: "in" }>['signal'],
    operator: "in",
    value: parseQuotedValues(named.rest.slice(keyword.length), span),
  };
}

function parseEffect(locale: Locale, source: string, span: PriorityRuleSourceSpan): Effect {
  const text = source.slice(span.start, span.end).replace(/\s+/gu, " ").trim();
  const names = effectNames[locale];
  const patterns = [
    [new RegExp(`^${escapedPattern(names.scoreDelta)} (-?\\d+)$`, "u"), "scoreDelta"],
    [new RegExp(`^${escapedPattern(names.confidenceDelta)} (-?(?:\\d+(?:\\.\\d+)?|\\.\\d+))$`, "u"), "confidenceDelta"],
    [new RegExp(`^${escapedPattern(names.scoreFloor)} (\\d+)$`, "u"), "scoreFloor"],
    [new RegExp(`^${escapedPattern(names.scoreCap)} (\\d+)$`, "u"), "scoreCap"],
  ] as const;
  for (const [pattern, field] of patterns) {
    const match = pattern.exec(text);
    if (match !== null) return { [field]: Number(match[1]) };
  }
  const review = locale === "en"
    ? new RegExp(`^${escapedPattern(names.needsReview)} (true|false)$`, "u").exec(text)
    : new RegExp(`^${escapedPattern(names.needsReview)} (да|нет)$`, "u").exec(text);
  if (review !== null) return { needsReview: review[1] === "true" || review[1] === "да" };
  const exclusion = locale === "en"
    ? new RegExp(`^${escapedPattern(names.exclusionReason)} (user|policy)$`, "u").exec(text)
    : new RegExp(`^${escapedPattern(names.exclusionReason)} (лично|политика)$`, "u").exec(text);
  if (exclusion !== null) {
    return { exclusionReason: exclusion[1] === "user" || exclusion[1] === "лично"
      ? "user_excluded" : "policy_excluded" };
  }
  unsupported("Unknown priority effect", span);
}

function mergeEffects(effects: readonly Effect[], span: PriorityRuleSourceSpan): Effect {
  const result: Record<string, unknown> = {};
  for (const effect of effects) {
    for (const [field, value] of Object.entries(effect)) {
      if (Object.hasOwn(result, field)) unsupported(`Duplicate effect ${field}`, span);
      result[field] = value;
    }
  }
  return result as Effect;
}

const readableSignals: Record<string, { en: string; ru: string }> = {
  has_shareable_next_action: { en: "has next action", ru: "есть следующий шаг" },
  has_shareable_project_context: { en: "has project context", ru: "есть контекст проекта" },
  has_current_project_membership: {
    en: "current project membership",
    ru: "участие в текущем проекте",
  },
  is_pinned: { en: "pinned", ru: "закреплена" },
  is_open: { en: "open", ru: "открыта" },
  has_captured_content: { en: "captured content", ru: "сохранённый контент" },
  has_current_summary: { en: "current summary", ru: "актуальное резюме" },
  has_current_research_report: {
    en: "current research report",
    ru: "актуальное исследование",
  },
  relation_count: { en: "relation count", ru: "число связей" },
  active_use_30d_ms: { en: "30-day active use (ms)", ru: "активное использование за 30 дней (мс)" },
  on_screen_30d_ms: { en: "30-day on-screen time (ms)", ru: "время на экране за 30 дней (мс)" },
  age_days: { en: "age in days", ru: "возраст в днях" },
  last_seen_days: { en: "days since last seen", ru: "дней с последнего просмотра" },
  duplicate_physical_count: { en: "open copy count", ru: "число открытых копий" },
  resource_page_count: { en: "resource page count", ru: "число страниц ресурса" },
  resource_captured_page_count: {
    en: "captured resource page count",
    ru: "число сохранённых страниц ресурса",
  },
  topic_paths: { en: "topic path", ru: "тема" },
  workspace_names: { en: "workspace name", ru: "рабочее пространство" },
  status: { en: "status", ru: "статус" },
};

function readableValue(value: boolean | number | readonly string[], locale: Locale): string {
  if (typeof value === "boolean") return locale === "en"
    ? String(value) : value ? "да" : "нет";
  if (typeof value === "number") return String(value);
  return value.map((entry) => `"${entry}"`).join(", ");
}

function readableRule(rule: PersonalPriorityRule): PriorityRuleReadableSentence {
  const subjects = {
    page: { en: "pages", ru: "страниц" },
    resource: { en: "resources", ru: "ресурсов" },
    both: { en: "pages and resources", ru: "страниц и ресурсов" },
  }[rule.appliesTo];
  const operator = {
    eq: { en: "equals", ru: "равно" },
    gte: { en: "is at least", ru: "не менее" },
    lte: { en: "is at most", ru: "не более" },
    in: { en: "is in", ru: "входит в" },
  } as const;
  const conditions = rule.when.all.map((condition) => ({
    en: `${readableSignals[condition.signal]!.en} ${operator[condition.operator].en} ${readableValue(condition.value, "en")}`,
    ru: `${readableSignals[condition.signal]!.ru} ${operator[condition.operator].ru} ${readableValue(condition.value, "ru")}`,
  }));
  const effects: Array<{ en: string; ru: string }> = [];
  if (rule.effect.scoreDelta !== undefined) effects.push({
    en: `add ${rule.effect.scoreDelta} to score`,
    ru: `изменить оценку на ${rule.effect.scoreDelta}`,
  });
  if (rule.effect.confidenceDelta !== undefined) effects.push({
    en: `add ${rule.effect.confidenceDelta} to confidence`,
    ru: `изменить уверенность на ${rule.effect.confidenceDelta}`,
  });
  if (rule.effect.scoreFloor !== undefined) effects.push({
    en: `set score floor ${rule.effect.scoreFloor}`,
    ru: `установить минимум оценки ${rule.effect.scoreFloor}`,
  });
  if (rule.effect.scoreCap !== undefined) effects.push({
    en: `set score cap ${rule.effect.scoreCap}`,
    ru: `установить максимум оценки ${rule.effect.scoreCap}`,
  });
  if (rule.effect.needsReview !== undefined) effects.push({
    en: `set review ${rule.effect.needsReview}`,
    ru: `установить проверку ${rule.effect.needsReview ? "да" : "нет"}`,
  });
  if (rule.effect.exclusionReason !== undefined) effects.push({
    en: `exclude as ${rule.effect.exclusionReason}`,
    ru: `исключить как ${rule.effect.exclusionReason}`,
  });
  return {
    ruleKey: rule.ruleKey,
    en: `For ${subjects.en}, when ${conditions.map((item) => item.en).join(" and ")}, ${effects.map((item) => item.en).join(" and ")}.`,
    ru: `Для ${subjects.ru}: если ${conditions.map((item) => item.ru).join(" и ")}, ${effects.map((item) => item.ru).join(" и ")}.`,
  };
}

export function renderPriorityRulesReadable(
  additions: readonly PersonalPriorityRule[],
): readonly PriorityRuleReadableSentence[] {
  return additions.map(readableRule);
}

function splitRules(source: string): PriorityRuleSourceSpan[] {
  const spans: PriorityRuleSourceSpan[] = [];
  let start = 0;
  for (let index = 0; index <= source.length; index += 1) {
    if (index === source.length || source[index] === ";" || source[index] === "\n") {
      const span = trimSpan(source, start, index);
      if (span.end > span.start) spans.push(span);
      else if (source[index] === ";") unsupported("Empty rule", { start, end: index + 1 });
      start = index + 1;
    }
  }
  return spans;
}

export function compilePriorityRuleNaturalLanguageV1(input: {
  readonly locale: Locale;
  readonly source: string;
}): PriorityRuleCompilerResult {
  const sourceLength = [...input.source].length;
  if (sourceLength < 1 || sourceLength >
      personalPriorityNaturalLanguageGrammarV1.limits.maxSourceCodePoints) {
    unsupported("Natural-language source must contain 1..4,000 Unicode characters", {
      start: 0,
      end: Math.max(1, sourceLength),
    });
  }
  const invalidCharacter = /[^A-Za-zА-Яа-яЁё0-9\s"+,.;:_\-]/u.exec(input.source);
  if (invalidCharacter?.index !== undefined) {
    const start = codePointOffset(input.source, invalidCharacter.index);
    unsupported("Natural-language source contains an unsupported character", {
      start,
      end: start + [...invalidCharacter[0]].length,
    });
  }
  if (Buffer.byteLength(input.source, "utf8") >
      personalPriorityNaturalLanguageGrammarV1.limits.maxSourceUtf8Bytes) {
    unsupported("Natural-language source exceeds durable UTF-8 storage", {
      start: 0,
      end: sourceLength,
    });
  }
  const rules = splitRules(input.source);
  if (rules.length < 1 || rules.length >
      personalPriorityNaturalLanguageGrammarV1.limits.maxPersonalRules) {
    unsupported("Natural-language source must compile to 1..92 rules", {
      start: 0,
      end: input.source.length,
    });
  }

  const additions: PersonalPriorityRule[] = [];
  const sourceSpans: CompiledPriorityRuleSpan[] = [];
  const syntax = input.locale === "en"
    ? /^(pages|resources|both)\s+when\s+(.+?)\s+then\s+(.+)$/u
    : /^(страницы|ресурсы|все)\s+когда\s+(.+?)\s+тогда\s+(.+)$/u;
  const conjunction = personalPriorityNaturalLanguageGrammarV1
    .locales[input.locale].conjunction;
  for (const [index, ruleSpan] of rules.entries()) {
    const raw = input.source.slice(ruleSpan.start, ruleSpan.end);
    const match = syntax.exec(raw);
    if (match === null) unsupported("Expected '<subject> when/когда ... then/тогда ...'", ruleSpan);
    const conditionText = match[2]!;
    const effectText = match[3]!;
    const conditionOffset = ruleSpan.start + raw.indexOf(conditionText);
    const effectOffset = ruleSpan.start + raw.lastIndexOf(effectText);
    const conditionSpans = splitOutsideQuotes(
      input.source,
      conditionOffset,
      conditionOffset + conditionText.length,
      conjunction,
    );
    const effectSpans = splitOutsideQuotes(
      input.source,
      effectOffset,
      effectOffset + effectText.length,
      conjunction,
    );
    if (conditionSpans.some((span) => span.start === span.end) ||
        effectSpans.some((span) => span.start === span.end)) {
      unsupported("A condition or effect is incomplete", ruleSpan);
    }
    const conditionPairs = conditionSpans.map((span) => ({
      span,
      condition: parseCondition(input.locale, input.source, span),
    })).sort((left, right) =>
      canonicalJson(left.condition).localeCompare(canonicalJson(right.condition)));
    const conditions = conditionPairs.map((item) => item.condition);
    const effect = mergeEffects(
      effectSpans.map((span) => parseEffect(input.locale, input.source, span)),
      ruleSpan,
    );
    const subject = subjectNames[input.locale][match[1]!];
    if (subject === undefined) unsupported("Unknown priority subject", ruleSpan);
    const identity = { appliesTo: subject, when: { all: conditions }, effect };
    const key = `personal.nl.${sha256(canonicalJson(identity)).slice(0, 16)}.${index + 1}`;
    let rule: PersonalPriorityRule;
    try {
      rule = personalPriorityRuleSchema.parse({
        ruleKey: key,
        priority: 500,
        label: `Personal rule ${index + 1}`,
        ...identity,
      });
    } catch {
      unsupported("Compiled rule violates the closed priority AST", ruleSpan);
    }
    additions.push(rule);
    sourceSpans.push({
      ruleKey: key,
      rule: ruleSpan,
      conditions: conditionPairs.map((item) => item.span),
      effects: effectSpans,
    });
  }
  return {
    compilerVersion: personalPriorityCompilerVersion,
    additions,
    sourceSpans,
    readableRules: renderPriorityRulesReadable(additions),
  };
}
