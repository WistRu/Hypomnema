import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  classifyLiveAcquisitionUrl,
  classifyPublicDnsAnswers,
  evaluatePublicContent,
  isRobotsPathAllowed,
  parseRetryAfter,
  parseRobotsPolicy,
} from "../src/live-acquisition-policy.js";

describe("live acquisition URL policy", () => {
  it("rejects encoded, camel-case, concatenated, and double-encoded credentials before acquisition", () => {
    for (const url of [
      "https://www.cloudflare.com/%74oken",
      "https://www.cloudflare.com/accessToken",
      "https://www.cloudflare.com/authtoken",
      "https://www.cloudflare.com/?xAmzSecurityToken=value",
      "https://www.cloudflare.com/%2574oken",
      "https://www.cloudflare.com/?continue=https%3A%2F%2Fwww.cloudflare.com",
    ]) {
      expect(classifyLiveAcquisitionUrl(url)).toEqual({
        kind: "blocked",
        code: "SENSITIVE_URL_CAPTURE_REQUIRED",
      });
    }
    expect(classifyLiveAcquisitionUrl("https://www.cloudflare.com/tokenization"))
      .toMatchObject({ kind: "allowed" });
    expect(classifyLiveAcquisitionUrl("https://www.cloudflare.com/signaturedesign?q=ordinary"))
      .toMatchObject({ kind: "allowed" });
  });

  it("rejects the frozen credential grammar in host, path, and query names but not ordinary values", () => {
    const exactTokens = [
      "account", "accounts", "admin", "auth", "authorization", "login", "signin",
      "oauth", "oauth2", "sso", "token", "session", "sessionid", "signature",
      "apikey", "secret", "password", "passwd", "jwt", "bearer", "credential",
      "credentials",
    ];
    const exactSequences = [
      "sign-in", "access-token", "refresh-token", "api-key", "x-amz-signature",
      "x-goog-signature", "x-amz-credential", "x-goog-credential",
    ];
    for (const marker of [...exactTokens, ...exactSequences, "oauth2Token", "xamzsecuritytoken"]) {
      for (const url of [
        `https://${marker}.cloudflare.com/`,
        `https://www.cloudflare.com/${marker}`,
        `https://www.cloudflare.com/?${marker}=ordinary`,
      ]) {
        expect(classifyLiveAcquisitionUrl(url), url).toEqual({
          kind: "blocked",
          code: "SENSITIVE_URL_CAPTURE_REQUIRED",
        });
      }
    }
    for (const queryName of ["sid", "sig", "key", "code", "assertion", "samlresponse"]) {
      expect(classifyLiveAcquisitionUrl(`https://www.cloudflare.com/?${queryName}=ordinary`))
        .toEqual({ kind: "blocked", code: "SENSITIVE_URL_CAPTURE_REQUIRED" });
    }
    expect(classifyLiveAcquisitionUrl("https://www.cloudflare.com/?note=token"))
      .toMatchObject({ kind: "allowed" });
    expect(classifyLiveAcquisitionUrl("https://www.cloudflare.com/?next=ordinary%3Avalue"))
      .toEqual({ kind: "blocked", code: "SENSITIVE_URL_CAPTURE_REQUIRED" });
  });
});

describe("RFC9309 robots policy", () => {
  it("combines exact product groups, honors wildcard/end anchors, and lets Allow win ties", () => {
    const parsed = parseRobotsPolicy(`
      Sitemap: https://www.cloudflare.com/sitemap.xml
      User-agent: OtherBot
      Disallow: /
      User-agent: TabHubResearch
      Disallow: /private*
      Allow: /private/public$
      User-agent: tabhubresearch
      Disallow: /encoded/%2A
      Crawl-delay: 1
      User-agent: *
      Disallow: /fallback
    `);
    expect(parsed).toMatchObject({ kind: "parsed", crawlDelayMs: 2_000 });
    if (parsed.kind !== "parsed") throw new Error("robots parse failed");
    expect(isRobotsPathAllowed(parsed, "https://www.cloudflare.com/private/other")).toBe(false);
    expect(isRobotsPathAllowed(parsed, "https://www.cloudflare.com/private/public")).toBe(true);
    expect(isRobotsPathAllowed(parsed, "https://www.cloudflare.com/private/public/more")).toBe(false);
    expect(isRobotsPathAllowed(parsed, "https://www.cloudflare.com/encoded/*")).toBe(false);
    expect(isRobotsPathAllowed(parsed, "https://www.cloudflare.com/fallback")).toBe(true);
    expect(parseRobotsPolicy("User-agent: TabHubResearch\nCrawl-delay: 1\nCrawl-delay: 2"))
      .toEqual({ kind: "blocked", code: "POLICY_BLOCKED" });
  });

  it("measures specificity in normalized octets rather than percent-escape characters", () => {
    const parsed = parseRobotsPolicy(`
      User-agent: TabHubResearch
      Disallow: /%2F*
      Allow: /*ab
    `);
    if (parsed.kind !== "parsed") throw new Error("robots parse failed");
    expect(isRobotsPathAllowed(parsed, "https://www.cloudflare.com/%2Fab")).toBe(true);
  });
});

describe("Retry-After policy", () => {
  it("accepts only nonnegative seconds or canonical IMF-fixdate and clamps to consent expiry", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    const expiresAt = new Date("2026-08-14T12:01:00.000Z");
    expect(parseRetryAfter("10", now, expiresAt)?.toISOString())
      .toBe("2026-08-14T12:00:10.000Z");
    expect(parseRetryAfter("Fri, 14 Aug 2026 12:00:30 GMT", now, expiresAt)?.toISOString())
      .toBe("2026-08-14T12:00:30.000Z");
    expect(parseRetryAfter("999", now, expiresAt)?.toISOString()).toBe(expiresAt.toISOString());
    for (const malformed of ["-1", "1.5", "2026-08-14", "Thu, 14 Aug 2026 12:00:30 GMT"]) {
      expect(parseRetryAfter(malformed, now, expiresAt), malformed).toBeUndefined();
    }
  });
});

describe("public content usability v1", () => {
  it("digests the exact response bytes instead of a re-encoded binary string", () => {
    const body = new TextEncoder().encode(
      "Public café research contains concrete evidence and independently verifiable facts. ".repeat(8),
    );
    const result = evaluatePublicContent(body, "text/plain", "https://www.cloudflare.com/");
    expect(result).toMatchObject({
      kind: "usable",
      contentDigest: createHash("sha256").update(body).digest("hex"),
    });
  });

  it("uses chrome-pruned primary content and fails closed on shell/auth/challenge documents", () => {
    const long = "Useful public research material with concrete facts and evidence. ".repeat(8);
    expect(evaluatePublicContent(
      new TextEncoder().encode(`<html><body><nav>${long}</nav><main>${long}<a href="/next">Next</a></main></body></html>`),
      "text/html; charset=utf-8",
      "https://www.cloudflare.com/start",
    )).toMatchObject({ kind: "usable", primaryText: expect.stringContaining("Useful public") });
    expect(evaluatePublicContent(
      new TextEncoder().encode(`<html><body><nav>${long}</nav><main><div id="root"></div></main></body></html>`),
      "text/html",
      "https://www.cloudflare.com/start",
    )).toEqual({ kind: "blocked", code: "SPA_SHELL" });
    expect(evaluatePublicContent(
      new TextEncoder().encode(`<html><body><main>${long}<input type="password"></main></body></html>`),
      "text/html",
      "https://www.cloudflare.com/start",
    )).toEqual({ kind: "blocked", code: "AUTH_REQUIRED" });
    expect(evaluatePublicContent(
      new TextEncoder().encode(`<html><body><main>${long} Verify you are human</main></body></html>`),
      "text/html",
      "https://www.cloudflare.com/start",
    )).toEqual({ kind: "blocked", code: "CHALLENGE_PAGE" });
  });

  it("never promotes a primary root beneath hidden or chrome ancestors", () => {
    const long = "Useful public research material with concrete facts and evidence. ".repeat(8);
    for (const ancestor of ["nav", "div hidden", "div aria-hidden=\"true\""]) {
      const tag = ancestor.split(" ")[0];
      const attributes = ancestor.slice(tag!.length);
      const body = new TextEncoder().encode(
        `<html><body><nav>${long}</nav><${tag}${attributes}><main>${long}</main></${tag}></body></html>`,
      );
      expect(evaluatePublicContent(body, "text/html", "https://www.cloudflare.com/start"))
        .toEqual({ kind: "blocked", code: "SPA_SHELL" });
    }
  });

  it("inspects exactly 5,000 anchors, canonical-dedupes, byte-sorts, and admits 200", () => {
    const prose = "Useful public research material with concrete facts and evidence. ".repeat(8);
    const anchors = Array.from({ length: 5_001 }, (_, index) =>
      `<a href=/x${(index % 201).toString(36)}>`);
    anchors[0] = '<a href=/x0#first>';
    anchors[1] = '<a href=/x0#second>';
    anchors[4_999] = '<a href=/boundary-n>';
    anchors[5_000] = '<a href=/boundary-n-plus-one>';
    const result = evaluatePublicContent(
      new TextEncoder().encode(`<html><body><main>${prose}${anchors.join("")}</main></body></html>`),
      "text/html",
      "https://www.cloudflare.com/start",
    );
    expect(result.kind).toBe("usable");
    if (result.kind !== "usable") throw new Error("content unexpectedly blocked");
    expect(result.links).toHaveLength(200);
    expect(result.links.filter((link) => link === "https://www.cloudflare.com/x0"))
      .toHaveLength(1);
    expect(result.links).toEqual([...result.links].sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))));
    expect(result.links).not.toContain("https://www.cloudflare.com/boundary-n-plus-one");
    expect(result.links).toContain("https://www.cloudflare.com/boundary-n");
  });

  it("produces the same canonical byte-ordered links for adversarial DOM order", () => {
    const prose = "Useful public research material with concrete facts and evidence. ".repeat(8);
    const hrefs = ["/z", "/%7Euser", "/a#fragment", "/a", "/%E2%98%83"];
    const extract = (values: readonly string[]) => evaluatePublicContent(
      new TextEncoder().encode(`<html><body><main>${prose}${values.map((href) =>
        `<a href="${href}">link</a>`).join("")}</main></body></html>`),
      "text/html",
      "https://www.cloudflare.com/start",
    );
    const forward = extract(hrefs);
    const reverse = extract([...hrefs].reverse());
    expect(forward.kind).toBe("usable");
    expect(reverse.kind).toBe("usable");
    if (forward.kind !== "usable" || reverse.kind !== "usable") return;
    expect(forward.links).toEqual(reverse.links);
    expect(forward.links).toHaveLength(4);
  });
});

describe("public IP policy v1", () => {
  it("pins the lowest safe IPv4, audits native AAAA, and rejects the whole mixed set", () => {
    expect(classifyPublicDnsAnswers([
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "104.16.133.229", family: 4 },
      { address: "104.16.132.229", family: 4 },
    ])).toMatchObject({
      kind: "allowed",
      selectedIpv4: "104.16.132.229",
      normalizedAnswers: ["104.16.132.229", "104.16.133.229", "2606:4700:4700::1111"],
    });
    expect(classifyPublicDnsAnswers([
      { address: "104.16.132.229", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ])).toEqual({ kind: "blocked", code: "POLICY_BLOCKED" });
    expect(classifyPublicDnsAnswers([
      { address: "2606:4700:4700::1111", family: 6 },
    ])).toEqual({ kind: "blocked", code: "IPV4_REQUIRED_V1" });
    for (const address of [
      "::ffff:127.0.0.1",
      "64:ff9b::c000:201",
      "64:ff9b:1::c000:201",
      "2002:c000:0201::",
      "2001:0000:4136:e378:8000:63bf:3fff:fdd2",
    ]) {
      expect(classifyPublicDnsAnswers([{ address, family: 6 }]))
        .toEqual({ kind: "blocked", code: "POLICY_BLOCKED" });
    }
  });

  it("enforces the frozen IPv4 deny table and the raw-answer cap before deduplication", () => {
    for (const address of [
      "0.1.2.3", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.1.1",
      "172.16.0.1", "192.0.0.1", "192.0.2.1", "192.31.196.1", "192.52.193.1",
      "192.88.99.1", "192.168.1.1", "192.175.48.1", "198.18.0.1",
      "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1",
    ]) {
      expect(classifyPublicDnsAnswers([{ address, family: 4 }]), address)
        .toEqual({ kind: "blocked", code: "POLICY_BLOCKED" });
    }
    expect(classifyPublicDnsAnswers(Array.from({ length: 17 }, () => ({
      address: "104.16.132.229",
      family: 4 as const,
    })))).toEqual({ kind: "blocked", code: "POLICY_BLOCKED" });
    expect(classifyPublicDnsAnswers([])).toEqual({ kind: "blocked", code: "POLICY_BLOCKED" });
    expect(classifyPublicDnsAnswers([{ address: "104.16.132.229", family: 6 }]))
      .toEqual({ kind: "blocked", code: "POLICY_BLOCKED" });
  });
});
