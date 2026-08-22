import { createHash } from "node:crypto";
import { isIP } from "node:net";

import ipaddr from "ipaddr.js";
import { parse } from "parse5";

import { classifyResourceUrlForResearch } from "./resource-catalog.js";

const credentialTokens = new Set([
  "account", "accounts", "admin", "auth", "authorization", "login", "signin",
  "oauth", "oauth2", "sso", "token", "session", "sessionid", "signature",
  "apikey", "secret", "password", "passwd", "jwt", "bearer", "credential",
  "credentials",
]);
const credentialSequences = [
  ["sign", "in"], ["access", "token"], ["refresh", "token"], ["api", "key"],
  ["x", "amz", "signature"], ["x", "goog", "signature"],
  ["x", "amz", "credential"], ["x", "goog", "credential"],
] as const;
const credentialConcatAtoms = [
  "access", "refresh", "auth", "authorization", "oauth", "oauth2", "sso",
  "session", "bearer", "api", "client", "private", "secret", "account",
  "login", "sign", "in", "x", "amz", "goog", "saml", "security", "token",
  "id", "key", "code", "signature", "credential", "credentials", "password",
  "passwd", "assertion", "response", "jwt", "callback", "redirect",
] as const;
const queryNameTokens = new Set(["sid", "sig", "key", "code", "assertion", "samlresponse"]);
const forbiddenControl = /[\u0000-\u001f\u007f\\]/u;
const residualEscape = /%[0-9a-f]{2}/iu;
const invalidEscape = /%(?![0-9a-f]{2})/iu;

export type LiveAcquisitionUrlPolicyResult =
  | {
      readonly kind: "allowed";
      readonly canonicalFetchUrl: string;
      readonly canonicalOrigin: string;
      readonly hostname: string;
      readonly urlFingerprint: string;
    }
  | { readonly kind: "blocked"; readonly code: "SENSITIVE_URL_CAPTURE_REQUIRED" | "POLICY_BLOCKED" };

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeComponentOnce(value: string): string | undefined {
  if (invalidEscape.test(value)) return undefined;
  try {
    const decoded = decodeURIComponent(value).normalize("NFKC");
    if (forbiddenControl.test(decoded) || residualEscape.test(decoded)) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

function componentTokens(value: string): string[] {
  const withCamelBoundaries = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return withCamelBoundaries.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
}

function isCredentialConcatenation(token: string): boolean {
  const reachable = new Map<number, number>([[0, 0]]);
  for (let offset = 0; offset < token.length; offset += 1) {
    const atomCount = reachable.get(offset);
    if (atomCount === undefined) continue;
    for (const atom of credentialConcatAtoms) {
      if (!token.startsWith(atom, offset)) continue;
      const end = offset + atom.length;
      reachable.set(end, Math.max(reachable.get(end) ?? -1, atomCount + 1));
    }
  }
  return (reachable.get(token.length) ?? 0) >= 2;
}

function hasCredentialGrammar(value: string, queryName = false): boolean {
  const tokens = componentTokens(value);
  if (tokens.some((token) => credentialTokens.has(token) ||
      isCredentialConcatenation(token) || (queryName && queryNameTokens.has(token)))) {
    return true;
  }
  return credentialSequences.some((sequence) => {
    if (sequence.length > tokens.length) return false;
    return tokens.some((_, index) =>
      sequence.every((token, part) => tokens[index + part] === token));
  });
}

function parseQuery(rawQuery: string): Array<{ name: string; value: string }> | undefined {
  if (rawQuery === "") return [];
  const fields = rawQuery.split("&");
  const result: Array<{ name: string; value: string }> = [];
  for (const field of fields) {
    const separator = field.indexOf("=");
    const rawName = separator === -1 ? field : field.slice(0, separator);
    const rawValue = separator === -1 ? "" : field.slice(separator + 1);
    const name = decodeComponentOnce(rawName.replace(/\+/g, "%20"));
    const value = decodeComponentOnce(rawValue.replace(/\+/g, "%20"));
    if (name === undefined || value === undefined || /[&#=/?@:]/u.test(name) ||
        /[&#=/?@:]/u.test(value)) {
      return undefined;
    }
    result.push({ name, value });
  }
  return result;
}

/** Closed v1 seed/traversal policy. It deliberately returns no rejected URL. */
export function classifyLiveAcquisitionUrl(rawUrl: string): LiveAcquisitionUrlPolicyResult {
  const blocked = (code: "SENSITIVE_URL_CAPTURE_REQUIRED" | "POLICY_BLOCKED" = "POLICY_BLOCKED") =>
    ({ kind: "blocked", code } as const);
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > 8192 ||
      forbiddenControl.test(rawUrl) || invalidEscape.test(rawUrl)) return blocked();
  const resourcePolicy = classifyResourceUrlForResearch(rawUrl);
  if (resourcePolicy.kind !== "eligible") {
    return blocked(resourcePolicy.reason === "weak_sensitive_signal" ||
        resourcePolicy.reason === "embedded_credentials"
      ? "SENSITIVE_URL_CAPTURE_REQUIRED"
      : "POLICY_BLOCKED");
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return blocked();
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" ||
      parsed.port !== "" || parsed.hostname === "" || parsed.hostname.endsWith(".") ||
      parsed.hostname.includes("..") || isIP(parsed.hostname.replace(/^\[|\]$/g, "")) !== 0) {
    return blocked();
  }

  const decodedHostnameLabels = parsed.hostname.split(".").map(decodeComponentOnce);
  const decodedPath = parsed.pathname.split("/").map(decodeComponentOnce);
  const query = parseQuery(parsed.search.slice(1));
  if (decodedHostnameLabels.some((value) => value === undefined || /[.:/?#@]/u.test(value)) ||
      decodedPath.some((value) => value === undefined || /[/?#]/u.test(value)) || query === undefined) {
    return blocked("SENSITIVE_URL_CAPTURE_REQUIRED");
  }
  if (decodedHostnameLabels.some((value) => hasCredentialGrammar(value!)) ||
      decodedPath.some((value) => hasCredentialGrammar(value!)) ||
      query.some(({ name }) => hasCredentialGrammar(name, true)) ||
      query.some(({ value }) => /(^|\s)bearer(?:\s|$)/iu.test(value) ||
        /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value))) {
    return blocked("SENSITIVE_URL_CAPTURE_REQUIRED");
  }

  parsed.hash = "";
  const canonicalFetchUrl = parsed.toString();
  return {
    kind: "allowed",
    canonicalFetchUrl,
    canonicalOrigin: parsed.origin,
    hostname: parsed.hostname.toLowerCase(),
    urlFingerprint: digest(canonicalFetchUrl),
  };
}

const deniedIpv4Cidrs = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
  "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
  "192.31.196.0/24", "192.52.193.0/24", "192.88.99.0/24", "192.168.0.0/16",
  "192.175.48.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
  "224.0.0.0/4", "240.0.0.0/4",
].map((cidr) => ipaddr.parseCIDR(cidr));
const allowedIpv6 = ipaddr.parseCIDR("2000::/3");
const deniedIpv6Cidrs = [
  "2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20",
  "64:ff9b::/96", "64:ff9b:1::/48",
].map((cidr) => ipaddr.parseCIDR(cidr));

export interface DnsAddressAnswer {
  readonly address: string;
  readonly family?: 4 | 6;
}

export type PublicDnsAnswerPolicyResult =
  | {
      readonly kind: "allowed";
      readonly normalizedAnswers: readonly string[];
      readonly answerSetDigest: string;
      readonly selectedIpv4: string;
      readonly selectedIpv4Digest: string;
    }
  | { readonly kind: "blocked"; readonly code: "POLICY_BLOCKED" | "IPV4_REQUIRED_V1" };

/** Audits the complete resolver answer set before selecting one IPv4 transport. */
export function classifyPublicDnsAnswers(
  answers: readonly DnsAddressAnswer[],
): PublicDnsAnswerPolicyResult {
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > 16) {
    return { kind: "blocked", code: "POLICY_BLOCKED" };
  }
  const normalized = new Map<string, { family: 4 | 6; address: string; bytes: number[] }>();
  for (const answer of answers) {
    if (answer === null || typeof answer !== "object" || typeof answer.address !== "string" ||
        !ipaddr.isValid(answer.address)) {
      return { kind: "blocked", code: "POLICY_BLOCKED" };
    }
    const parsed = ipaddr.parse(answer.address);
    const family = parsed.kind() === "ipv4" ? 4 : 6;
    if (answer.family !== undefined && answer.family !== family) {
      return { kind: "blocked", code: "POLICY_BLOCKED" };
    }
    if (family === 4) {
      if (deniedIpv4Cidrs.some((range) => parsed.match(range))) {
        return { kind: "blocked", code: "POLICY_BLOCKED" };
      }
    } else {
      const ipv6 = parsed as ipaddr.IPv6;
      if (ipv6.isIPv4MappedAddress() || !ipv6.match(allowedIpv6) ||
          deniedIpv6Cidrs.some((range) => ipv6.match(range))) {
        return { kind: "blocked", code: "POLICY_BLOCKED" };
      }
    }
    const address = parsed.toString();
    normalized.set(`${family}:${address}`, { family, address, bytes: parsed.toByteArray() });
  }
  const sorted = [...normalized.values()].sort((left, right) => {
    if (left.family !== right.family) return left.family - right.family;
    for (let index = 0; index < left.bytes.length; index += 1) {
      const difference = (left.bytes[index] ?? 0) - (right.bytes[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  });
  const selected = sorted.find(({ family }) => family === 4);
  if (selected === undefined) return { kind: "blocked", code: "IPV4_REQUIRED_V1" };
  const normalizedAnswers = sorted.map(({ address }) => address);
  return {
    kind: "allowed",
    normalizedAnswers,
    answerSetDigest: digest(sorted.map(({ family, address }) => `${family}:${address}`).join("\n")),
    selectedIpv4: selected.address,
    selectedIpv4Digest: digest(selected.address),
  };
}

type HtmlNode = {
  readonly nodeName?: string;
  readonly tagName?: string;
  readonly value?: string;
  readonly attrs?: readonly { readonly name: string; readonly value: string }[];
  readonly childNodes?: readonly HtmlNode[];
  readonly parentNode?: HtmlNode;
};

export type PublicContentUsabilityResult =
  | {
      readonly kind: "usable";
      readonly mediaType: "html" | "text";
      readonly allVisibleText: string;
      readonly primaryText: string;
      readonly links: readonly string[];
      readonly contentDigest: string;
    }
  | {
      readonly kind: "blocked";
      readonly code: "INVALID_UTF8" | "POLICY_BLOCKED" | "META_REFRESH" |
        "AUTH_REQUIRED" | "CHALLENGE_PAGE" | "SPA_SHELL" |
        "INSUFFICIENT_PUBLIC_TEXT";
    };

const hiddenTextTags = new Set(["script", "style", "noscript", "template", "svg", "canvas"]);
const chromeTags = new Set(["nav", "header", "footer", "aside", "form", "dialog", "menu", "button"]);

function attribute(node: HtmlNode, name: string): string | undefined {
  return node.attrs?.find((item) => item.name.toLowerCase() === name)?.value;
}

function isHidden(node: HtmlNode): boolean {
  const tag = node.tagName?.toLowerCase();
  return tag !== undefined && (hiddenTextTags.has(tag) || attribute(node, "hidden") !== undefined ||
    attribute(node, "aria-hidden")?.toLowerCase() === "true");
}

function normalizeVisibleText(parts: readonly string[]): string {
  return parts.join(" ").normalize("NFKC").replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ").replace(/ *\n+ */g, "\n").trim();
}

function collectText(node: HtmlNode, pruneChrome: boolean, output: string[]): void {
  if (isHidden(node)) return;
  const tag = node.tagName?.toLowerCase();
  if (pruneChrome && tag !== undefined && chromeTags.has(tag)) return;
  if (node.nodeName === "#text" && typeof node.value === "string") output.push(node.value);
  for (const child of node.childNodes ?? []) collectText(child, pruneChrome, output);
}

function walk(node: HtmlNode, visit: (node: HtmlNode) => void): void {
  visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
}

function isExcludedPrimaryRoot(node: HtmlNode): boolean {
  if (isHidden(node)) return true;
  let parent = node.parentNode;
  while (parent !== undefined) {
    if (isHidden(parent) ||
        (parent.tagName !== undefined && chromeTags.has(parent.tagName.toLowerCase()))) return true;
    parent = parent.parentNode;
  }
  return false;
}

function parseSupportedContentType(value: string): "html" | "text" | undefined {
  const parts = value.split(";").map((part) => part.trim());
  const mediaType = parts.shift()?.toLowerCase();
  let charsetSeen = false;
  for (const parameter of parts) {
    const [rawName, ...rawValue] = parameter.split("=");
    if (rawName?.trim().toLowerCase() !== "charset" || charsetSeen ||
        rawValue.join("=").trim().replace(/^"|"$/g, "").toLowerCase() !== "utf-8") {
      return undefined;
    }
    charsetSeen = true;
  }
  if (mediaType === "text/plain") return "text";
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") return "html";
  return undefined;
}

function meetsTextThreshold(value: string): boolean {
  return Buffer.byteLength(value, "utf8") >= 256 && value.replace(/\s/gu, "").length >= 160;
}

/** Parses inert bytes only; scripts and browser subresources are never executed. */
export function evaluatePublicContent(
  body: Uint8Array,
  contentType: string,
  baseUrl: string,
): PublicContentUsabilityResult {
  if (!(body instanceof Uint8Array) || body.byteLength > 65_536) {
    return { kind: "blocked", code: "POLICY_BLOCKED" };
  }
  const mediaType = parseSupportedContentType(contentType);
  if (mediaType === undefined) return { kind: "blocked", code: "POLICY_BLOCKED" };
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return { kind: "blocked", code: "INVALID_UTF8" };
  }
  if (mediaType === "text") {
    const text = normalizeVisibleText([decoded]);
    if (!meetsTextThreshold(text)) return { kind: "blocked", code: "INSUFFICIENT_PUBLIC_TEXT" };
    return {
      kind: "usable", mediaType, allVisibleText: text, primaryText: text, links: [],
      contentDigest: digest(body),
    };
  }

  const document = parse(decoded) as unknown as HtmlNode;
  const allParts: string[] = [];
  collectText(document, false, allParts);
  const allVisibleText = normalizeVisibleText(allParts);
  let metaRefresh = false;
  let auth = false;
  let challenge = false;
  const primaryRoots: HtmlNode[] = [];
  const links = new Set<string>();
  let anchorCount = 0;
  walk(document, (node) => {
    const tag = node.tagName?.toLowerCase();
    if (tag === "meta" && attribute(node, "http-equiv")?.trim().toLowerCase() === "refresh") {
      metaRefresh = true;
    }
    if (tag === "input" && attribute(node, "type")?.trim().toLowerCase() === "password") auth = true;
    if (tag === "form" && ["action", "id", "name"].some((name) => {
      const value = attribute(node, name);
      return value !== undefined && hasCredentialGrammar(value);
    })) auth = true;
    const markerMaterial = [attribute(node, "id"), attribute(node, "class")]
      .filter((value): value is string => value !== undefined).join(" ").toLowerCase();
    if (/g-recaptcha|h-captcha|cf-chl-|challenge-platform/u.test(markerMaterial)) challenge = true;
    if (tag === "article" || tag === "main" || attribute(node, "role")?.toLowerCase() === "main") {
      if (!isExcludedPrimaryRoot(node) && !primaryRoots.some((root) => {
        let parent = node.parentNode;
        while (parent !== undefined) {
          if (parent === root) return true;
          parent = parent.parentNode;
        }
        return false;
      })) primaryRoots.push(node);
    }
    if (tag === "a" && anchorCount < 5_000) {
      anchorCount += 1;
      const href = attribute(node, "href");
      if (href !== undefined) {
        try {
          const candidate = classifyLiveAcquisitionUrl(new URL(href, baseUrl).toString());
          if (candidate.kind === "allowed") links.add(candidate.canonicalFetchUrl);
        } catch {
          // An invalid or unsupported link is inert traversal input.
        }
      }
    }
  });
  if (/verify you are human|checking your browser/iu.test(allVisibleText)) challenge = true;
  if (metaRefresh) return { kind: "blocked", code: "META_REFRESH" };
  if (auth) return { kind: "blocked", code: "AUTH_REQUIRED" };
  if (challenge) return { kind: "blocked", code: "CHALLENGE_PAGE" };
  const primaryParts: string[] = [];
  if (primaryRoots.length > 0) {
    for (const root of primaryRoots) collectText(root, true, primaryParts);
  } else {
    const bodyNode: { value?: HtmlNode } = {};
    walk(document, (node) => { if (node.tagName?.toLowerCase() === "body" && bodyNode.value === undefined) bodyNode.value = node; });
    collectText(bodyNode.value ?? document, true, primaryParts);
  }
  const primaryText = normalizeVisibleText(primaryParts);
  if (!meetsTextThreshold(allVisibleText)) {
    return { kind: "blocked", code: "INSUFFICIENT_PUBLIC_TEXT" };
  }
  if (!meetsTextThreshold(primaryText)) return { kind: "blocked", code: "SPA_SHELL" };
  return {
    kind: "usable", mediaType, allVisibleText, primaryText,
    links: [...links].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))).slice(0, 200),
    contentDigest: digest(body),
  };
}

interface RobotsRule {
  readonly allow: boolean;
  readonly pattern: string;
  readonly endAnchored: boolean;
  readonly specificity: number;
}

export type ParsedRobotsPolicy = {
  readonly kind: "parsed";
  readonly rules: readonly RobotsRule[];
  readonly crawlDelayMs: number;
  readonly policyDigest: string;
};

export type RobotsPolicyResult = ParsedRobotsPolicy |
  { readonly kind: "blocked"; readonly code: "POLICY_BLOCKED" };

function normalizeRobotsOctets(value: string, permitPatternOperators: boolean): string | undefined {
  if (forbiddenControl.test(value) || invalidEscape.test(value)) return undefined;
  let output = "";
  for (let index = 0; index < value.length;) {
    const character = value[index]!;
    if (character === "%") {
      const octet = Number.parseInt(value.slice(index + 1, index + 3), 16);
      const decoded = String.fromCharCode(octet);
      output += /[A-Za-z0-9._~-]/u.test(decoded)
        ? decoded
        : `%${octet.toString(16).toUpperCase().padStart(2, "0")}`;
      index += 3;
      continue;
    }
    if (permitPatternOperators && (character === "*" || character === "$")) {
      output += character;
      index += 1;
      continue;
    }
    const codePoint = value.codePointAt(index)!;
    const raw = String.fromCodePoint(codePoint);
    if (/^[A-Za-z0-9._~!$&'()+,;=:@/?-]$/u.test(raw)) output += raw;
    else {
      for (const byte of new TextEncoder().encode(raw)) {
        output += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    }
    index += raw.length;
  }
  return output;
}

function compileRobotsRule(raw: string, allow: boolean): RobotsRule | undefined {
  if (raw === "" && !allow) return undefined;
  const normalized = normalizeRobotsOctets(raw, true);
  if (normalized === undefined) throw new TypeError("invalid robots rule");
  const endAnchored = normalized.endsWith("$");
  const pattern = endAnchored ? normalized.slice(0, -1) : normalized;
  let specificity = 0;
  for (let index = 0; index < pattern.length;) {
    if (pattern[index] === "*") {
      index += 1;
    } else if (pattern[index] === "%") {
      specificity += 1;
      index += 3;
    } else {
      specificity += 1;
      index += 1;
    }
  }
  return {
    allow,
    pattern,
    endAnchored,
    specificity,
  };
}

/** Strict, closed robots parser for the TabHubResearch RFC9309 product token. */
export function parseRobotsPolicy(text: string): RobotsPolicyResult {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 65_536 ||
      forbiddenControl.test(text.replace(/[\r\n\t]/g, ""))) {
    return { kind: "blocked", code: "POLICY_BLOCKED" };
  }
  type Group = { agents: string[]; rules: RobotsRule[]; delays: number[]; hasRule: boolean };
  const groups: Group[] = [];
  let group: Group | undefined;
  try {
    for (const rawLine of text.split(/\r?\n/u)) {
      const line = rawLine.replace(/#.*$/u, "").trim();
      if (line === "") continue;
      const separator = line.indexOf(":");
      if (separator < 1) continue;
      const name = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();
      if (name === "user-agent") {
        if (!(value === "*" || /^[A-Za-z][A-Za-z0-9_-]*$/u.test(value))) {
          throw new TypeError("invalid user agent");
        }
        if (group === undefined || group.hasRule) {
          group = { agents: [], rules: [], delays: [], hasRule: false };
          groups.push(group);
        }
        group.agents.push(value.toLowerCase());
        continue;
      }
      if (name === "allow" || name === "disallow") {
        if (group === undefined) continue;
        const rule = compileRobotsRule(value, name === "allow");
        if (rule !== undefined) group.rules.push(rule);
        group.hasRule = true;
        continue;
      }
      if (name === "crawl-delay") {
        if (group === undefined || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
          throw new TypeError("invalid crawl delay");
        }
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30) {
          throw new TypeError("invalid crawl delay");
        }
        group.delays.push(seconds);
        group.hasRule = true;
      }
      // Unknown records deliberately do not end the current group.
    }
  } catch {
    return { kind: "blocked", code: "POLICY_BLOCKED" };
  }
  const exact = groups.filter(({ agents }) => agents.includes("tabhubresearch"));
  const selected = exact.length > 0 ? exact : groups.filter(({ agents }) => agents.includes("*"));
  const delays = selected.flatMap(({ delays: values }) => values);
  if (delays.length > 1) return { kind: "blocked", code: "POLICY_BLOCKED" };
  const rules = selected.flatMap(({ rules: values }) => values);
  return {
    kind: "parsed",
    rules,
    crawlDelayMs: Math.max(2_000, Math.round((delays[0] ?? 0) * 1_000)),
    policyDigest: digest(JSON.stringify({
      product: "TabHubResearch",
      rules,
      crawlDelayMs: Math.max(2_000, Math.round((delays[0] ?? 0) * 1_000)),
    })),
  };
}

function robotsPatternMatches(rule: RobotsRule, target: string): boolean {
  let source = "^";
  for (const character of rule.pattern) {
    source += character === "*" ? ".*" : character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  if (rule.endAnchored) source += "$";
  return new RegExp(source, "u").test(target);
}

export function isRobotsPathAllowed(policy: ParsedRobotsPolicy, urlText: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlText);
  } catch {
    return false;
  }
  const target = normalizeRobotsOctets(`${parsed.pathname}${parsed.search}`, false);
  if (target === undefined) return false;
  const matching = policy.rules.filter((rule) => robotsPatternMatches(rule, target));
  if (matching.length === 0) return true;
  matching.sort((left, right) => right.specificity - left.specificity ||
    Number(right.allow) - Number(left.allow));
  return matching[0]!.allow;
}

export function parseRetryAfter(value: string | undefined, now: Date, expiresAt: Date): Date | undefined {
  if (value === undefined || !Number.isFinite(now.getTime()) || !Number.isFinite(expiresAt.getTime())) {
    return undefined;
  }
  const normalized = value.trim();
  let candidate: number;
  if (/^(?:0|[1-9]\d*)$/u.test(normalized)) {
    candidate = now.getTime() + Number(normalized) * 1_000;
  } else {
    if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d GMT$/u.test(normalized)) {
      return undefined;
    }
    candidate = Date.parse(normalized);
    if (!Number.isFinite(candidate) || new Date(candidate).toUTCString() !== normalized) return undefined;
  }
  if (!Number.isFinite(candidate) || candidate < now.getTime()) return undefined;
  return new Date(Math.min(candidate, expiresAt.getTime()));
}
