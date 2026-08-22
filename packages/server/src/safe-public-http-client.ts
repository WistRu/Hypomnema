import { lookup as nodeLookup } from "node:dns/promises";
import { Agent, request as httpsRequest } from "node:https";
import { checkServerIdentity, connect as tlsConnect } from "node:tls";

import {
  classifyLiveAcquisitionUrl,
  classifyPublicDnsAnswers,
  evaluatePublicContent,
  type DnsAddressAnswer,
  type PublicContentUsabilityResult,
} from "./live-acquisition-policy.js";

export interface SafePublicHttpRequest {
  readonly version: "safe_public_http_request:v1";
  readonly actionKind: "page" | "robots";
  readonly url: string;
  readonly expiresAt: string;
  readonly signal?: AbortSignal;
}

export interface SafePublicHttpCounters {
  readonly dnsCalls: number;
  readonly connectAttempts: number;
  readonly httpApplicationBytes: number;
}

export type SafePublicHttpResult =
  | {
      readonly kind: "success";
      readonly status: 200 | 404 | 410;
      readonly counters: SafePublicHttpCounters;
      readonly selectedIpv4: string;
      readonly answerSetDigest: string;
      readonly body: Uint8Array;
      readonly contentType: string | null;
      readonly retryAfter: string | null;
      readonly usability: PublicContentUsabilityResult | null;
    }
  | {
      readonly kind: "blocked";
      readonly code: "POLICY_BLOCKED" | "SENSITIVE_URL_CAPTURE_REQUIRED" |
        "IPV4_REQUIRED_V1" | "CONSENT_EXPIRED_IN_FLIGHT" |
        "TRANSPORT_DNS_FAILURE" | "TRANSPORT_CONNECT_FAILURE" |
        "TRANSPORT_TLS_FAILURE" | "TRANSPORT_TIMEOUT" | "PARTIAL_RESPONSE" |
        "HTTP_INFORMATIONAL" | "HTTP_REDIRECT" | "HTTP_CLIENT_ERROR" |
        "HTTP_SERVER_ERROR" | "RESPONSE_SIZE_LIMIT" | "INVALID_UTF8" |
        "META_REFRESH" | "AUTH_REQUIRED" | "CHALLENGE_PAGE" | "SPA_SHELL" |
        "INSUFFICIENT_PUBLIC_TEXT";
      readonly counters: SafePublicHttpCounters;
      readonly retryAfter?: string | null;
    };

interface WireResponse {
  readonly statusCode: number;
  readonly rawHeaders: readonly string[];
  readonly rawTrailers: readonly string[];
  readonly body: Uint8Array;
  readonly applicationBytes: number;
}

interface PinnedConnectInput {
  readonly actionKind: "page" | "robots";
  readonly canonicalUrl: string;
  readonly hostname: string;
  readonly pinnedIpv4: string;
  readonly startedAt: number;
  readonly connectDeadlineAt: number;
  readonly headersDeadlineAt: number;
  readonly deadlineAt: number;
  readonly deadlineCode: "SAFE_CONSENT_EXPIRED" | "SAFE_TIMEOUT";
  readonly bodyIdleTimeoutMs: 3_000;
  readonly signal?: AbortSignal;
}

interface SafePublicHttpClientDependencies {
  readonly clock?: () => Date;
  readonly lookup?: (hostname: string, options: { all: true; verbatim: true }) =>
    Promise<readonly DnsAddressAnswer[]>;
  readonly connect?: (input: PinnedConnectInput) => Promise<WireResponse>;
  /** Narrow transport dial seam used only by deterministic socket-level tests. */
  readonly tlsConnect?: typeof tlsConnect;
}

export interface SafePublicHttpClient {
  resolve(request: Omit<SafePublicHttpRequest, "actionKind">): Promise<SafePublicResolutionResult>;
  request(request: SafePinnedHttpRequest): Promise<SafePublicHttpResult>;
  acquire(request: SafePublicHttpRequest): Promise<SafePublicHttpResult>;
}

export type SafePublicResolutionResult =
  | {
      readonly kind: "resolved";
      readonly canonicalUrl: string;
      readonly canonicalOrigin: string;
      readonly hostname: string;
      readonly selectedIpv4: string;
      readonly selectedIpv4Digest: string;
      readonly normalizedAnswers: readonly string[];
      readonly answerSetDigest: string;
      readonly counters: SafePublicHttpCounters;
    }
  | Extract<SafePublicHttpResult, { readonly kind: "blocked" }>;

export interface SafePinnedHttpRequest {
  readonly version: "safe_public_http_request:v1";
  readonly actionKind: "page" | "robots";
  readonly canonicalUrl: string;
  readonly canonicalOrigin: string;
  readonly hostname: string;
  readonly pinnedIpv4: string;
  readonly answerSetDigest: string;
  readonly expiresAt: string;
  readonly signal?: AbortSignal;
}

function createPinnedAgent(
  hostname: string,
  pinnedIpv4: string,
  connectDeadlineAt: number,
  signal?: AbortSignal,
  dialTls: typeof tlsConnect = tlsConnect,
): Agent {
  const agent = new Agent({ keepAlive: false, maxSockets: 1, maxFreeSockets: 0 });
  agent.createConnection = ((_options, callback) => {
    if (callback === undefined) return undefined;
    const socket = dialTls({
      host: pinnedIpv4,
      port: 443,
      servername: hostname,
      rejectUnauthorized: true,
    });
    let settled = false;
    const connectTimer = setTimeout(
      () => fail(new Error("SAFE_TIMEOUT")),
      Math.max(0, connectDeadlineAt - Date.now()),
    );
    const abort = () => fail(new Error("SAFE_ABORTED"));
    const cleanup = () => {
      clearTimeout(connectTimer);
      signal?.removeEventListener("abort", abort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      callback(error, socket);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) {
      abort();
      return undefined;
    }
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      if (settled) return;
      const peer = socket.remoteAddress;
      const identityError = checkServerIdentity(hostname, socket.getPeerCertificate(true));
      if (!socket.authorized || identityError !== undefined || peer !== pinnedIpv4) {
        fail(new Error("SAFE_TLS_PEER_REJECTED"));
        return;
      }
      settled = true;
      cleanup();
      socket.removeListener("error", fail);
      callback(null, socket);
    });
    return undefined;
  }) satisfies Agent["createConnection"];
  return agent;
}

function fixedHeaders(actionKind: "page" | "robots"): Readonly<Record<string, string>> {
  return Object.freeze({
    Accept: actionKind === "robots"
      ? "text/plain"
      : "text/html, application/xhtml+xml, text/plain",
    "Accept-Encoding": "identity",
    "User-Agent": "TabHubResearch/1.0",
    Connection: "close",
  });
}

function performPinnedHttpsGet(
  input: PinnedConnectInput,
  dialTls: typeof tlsConnect = tlsConnect,
): Promise<WireResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(input.canonicalUrl);
    const agent = createPinnedAgent(
      input.hostname,
      input.pinnedIpv4,
      input.connectDeadlineAt,
      input.signal,
      dialTls,
    );
    let settled = false;
    let applicationBytes = 0;
    let bodyIdleTimer: ReturnType<typeof setTimeout> | undefined;
    const remaining = Math.max(0, input.deadlineAt - Date.now());
    if (remaining === 0) {
      agent.destroy();
      reject(new Error(input.deadlineCode));
      return;
    }
    const request = httpsRequest({
      protocol: "https:",
      hostname: input.hostname,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: fixedHeaders(input.actionKind),
      agent,
      maxHeaderSize: 16_384,
      signal: input.signal,
    });
    const timer = setTimeout(() => request.destroy(new Error(input.deadlineCode)), remaining);
    const headersTimer = setTimeout(
      () => request.destroy(new Error("SAFE_TIMEOUT")),
      Math.max(0, input.headersDeadlineAt - Date.now()),
    );
    request.once("finish", () => {
      applicationBytes = Buffer.byteLength(
        `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${input.hostname}\r\n`,
      );
    });
    request.once("response", (response) => {
      clearTimeout(headersTimer);
      const chunks: Buffer[] = [];
      let length = 0;
      let responseFailed = false;
      const failPartialResponse = () => {
        if (responseFailed || settled) return;
        responseFailed = true;
        if (bodyIdleTimer !== undefined) clearTimeout(bodyIdleTimer);
        request.destroy(new Error("SAFE_PARTIAL_RESPONSE"));
      };
      const resetIdle = () => {
        if (bodyIdleTimer !== undefined) clearTimeout(bodyIdleTimer);
        bodyIdleTimer = setTimeout(
          () => request.destroy(new Error("SAFE_TIMEOUT")),
          input.bodyIdleTimeoutMs,
        );
      };
      resetIdle();
      response.once("aborted", failPartialResponse);
      response.once("error", failPartialResponse);
      response.on("data", (chunk: Buffer) => {
        resetIdle();
        length += chunk.byteLength;
        if (length > 65_536) {
          request.destroy(new Error("SAFE_BODY_LIMIT"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => {
        if (bodyIdleTimer !== undefined) clearTimeout(bodyIdleTimer);
        if (settled) return;
        if (!response.complete) {
          failPartialResponse();
          return;
        }
        settled = true;
        clearTimeout(timer);
        agent.destroy();
        resolve({
          statusCode: response.statusCode ?? 0,
          rawHeaders: response.rawHeaders,
          rawTrailers: response.rawTrailers,
          body: Buffer.concat(chunks),
          applicationBytes,
        });
      });
    });
    request.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(headersTimer);
      if (bodyIdleTimer !== undefined) clearTimeout(bodyIdleTimer);
      agent.destroy();
      const wrapped = new Error(error.message);
      Object.defineProperty(wrapped, "applicationBytes", { value: applicationBytes });
      reject(wrapped);
    });
    request.end();
  });
}

function lowerHeaderMap(rawHeaders: readonly string[]): Map<string, string[]> | undefined {
  if (rawHeaders.length % 2 !== 0 || rawHeaders.length / 2 > 100) return undefined;
  const map = new Map<string, string[]>();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!.toLowerCase();
    const value = rawHeaders[index + 1]!;
    const values = map.get(name) ?? [];
    values.push(value);
    map.set(name, values);
  }
  for (const name of ["content-type", "content-encoding", "content-length", "transfer-encoding"]) {
    if ((map.get(name)?.length ?? 0) > 1) return undefined;
  }
  return map;
}

type SafePublicHttpBlockedCode = Extract<SafePublicHttpResult, { kind: "blocked" }>["code"];

function statusCode(code: number): SafePublicHttpBlockedCode {
  if (code >= 100 && code < 200) return "HTTP_INFORMATIONAL";
  if (code === 206) return "PARTIAL_RESPONSE";
  if (code >= 300 && code < 400) return "HTTP_REDIRECT";
  if (code >= 400 && code < 500) return "HTTP_CLIENT_ERROR";
  return "HTTP_SERVER_ERROR";
}

function failureCode(error: unknown): SafePublicHttpBlockedCode {
  const message = error instanceof Error ? error.message : "";
  if (message === "SAFE_BODY_LIMIT") return "RESPONSE_SIZE_LIMIT";
  if (message === "SAFE_PARTIAL_RESPONSE") return "PARTIAL_RESPONSE";
  if (message === "SAFE_CONSENT_EXPIRED") return "CONSENT_EXPIRED_IN_FLIGHT";
  if (message === "SAFE_TIMEOUT" || message === "SAFE_ABORTED" ||
      message.toLowerCase().includes("aborted")) return "TRANSPORT_TIMEOUT";
  if (message.includes("TLS") || message.includes("certificate") || message.includes("CERT")) {
    return "TRANSPORT_TLS_FAILURE";
  }
  return "TRANSPORT_CONNECT_FAILURE";
}

function errorApplicationBytes(error: unknown): number {
  if (error === null || typeof error !== "object") return 0;
  const value = Reflect.get(error, "applicationBytes");
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

export function createSafePublicHttpClient(
  dependencies: SafePublicHttpClientDependencies = {},
): SafePublicHttpClient {
  const clock = dependencies.clock ?? (() => new Date());
  const lookup = dependencies.lookup ?? (async (hostname, options) =>
    nodeLookup(hostname, options) as Promise<readonly DnsAddressAnswer[]>);
  const connect = dependencies.connect ?? ((input: PinnedConnectInput) =>
    performPinnedHttpsGet(input, dependencies.tlsConnect ?? tlsConnect));

  async function resolve(
    input: Omit<SafePublicHttpRequest, "actionKind">,
  ): Promise<SafePublicResolutionResult> {
      const zero = { dnsCalls: 0, connectAttempts: 0, httpApplicationBytes: 0 } as const;
      const classified = classifyLiveAcquisitionUrl(input.url);
      if (classified.kind === "blocked") return { ...classified, counters: zero };
      const now = clock().getTime();
      const expiresAt = Date.parse(input.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        return { kind: "blocked", code: "CONSENT_EXPIRED_IN_FLIGHT", counters: zero };
      }
      let answers: readonly DnsAddressAnswer[];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        answers = await Promise.race([
          lookup(classified.hostname, { all: true, verbatim: true }),
          new Promise<never>((_resolve, reject) =>
            { timer = setTimeout(() => reject(new Error("SAFE_DNS_TIMEOUT")),
              Math.min(3_000, expiresAt - now)); }),
        ]);
      } catch {
        return {
          kind: "blocked", code: "TRANSPORT_DNS_FAILURE",
          counters: { ...zero, dnsCalls: 1 },
        };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      const dns = classifyPublicDnsAnswers(answers);
      if (dns.kind === "blocked") {
        return { ...dns, counters: { ...zero, dnsCalls: 1 } };
      }
      return {
        kind: "resolved",
        canonicalUrl: classified.canonicalFetchUrl,
        canonicalOrigin: classified.canonicalOrigin,
        hostname: classified.hostname,
        selectedIpv4: dns.selectedIpv4,
        selectedIpv4Digest: dns.selectedIpv4Digest,
        normalizedAnswers: dns.normalizedAnswers,
        answerSetDigest: dns.answerSetDigest,
        counters: { ...zero, dnsCalls: 1 },
      };
  }

  async function requestPinned(
    input: SafePinnedHttpRequest,
    dnsCalls = 0,
  ): Promise<SafePublicHttpResult> {
      const zero = { dnsCalls, connectAttempts: 0, httpApplicationBytes: 0 } as const;
      const classified = classifyLiveAcquisitionUrl(input.canonicalUrl);
      if (classified.kind === "blocked" || classified.canonicalFetchUrl !== input.canonicalUrl ||
          classified.canonicalOrigin !== input.canonicalOrigin || classified.hostname !== input.hostname) {
        return { kind: "blocked", code: "POLICY_BLOCKED", counters: zero };
      }
      const expiresAt = Date.parse(input.expiresAt);
      const startedAt = clock().getTime();
      if (!Number.isFinite(expiresAt) || expiresAt <= startedAt) {
        return { kind: "blocked", code: "CONSENT_EXPIRED_IN_FLIGHT", counters: zero };
      }
      const pinned = classifyPublicDnsAnswers([{ address: input.pinnedIpv4, family: 4 }]);
      if (pinned.kind === "blocked" || !/^[0-9a-f]{64}$/u.test(input.answerSetDigest)) {
        return { kind: "blocked", code: "POLICY_BLOCKED", counters: zero };
      }
      const totalDeadlineAt = startedAt + 15_000;
      const deadlineAt = Math.min(expiresAt, totalDeadlineAt);
      let response: WireResponse;
      try {
        response = await connect({
          actionKind: input.actionKind,
          canonicalUrl: input.canonicalUrl,
          hostname: input.hostname,
          pinnedIpv4: input.pinnedIpv4,
          startedAt,
          connectDeadlineAt: Math.min(deadlineAt, startedAt + 5_000),
          headersDeadlineAt: Math.min(deadlineAt, startedAt + 8_000),
          deadlineAt,
          deadlineCode: expiresAt <= totalDeadlineAt ? "SAFE_CONSENT_EXPIRED" : "SAFE_TIMEOUT",
          bodyIdleTimeoutMs: 3_000,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch (error) {
        const classifiedFailure = failureCode(error);
        const expired = classifiedFailure === "CONSENT_EXPIRED_IN_FLIGHT" ||
          clock().getTime() >= expiresAt;
        return {
          kind: "blocked",
          code: expired ? "CONSENT_EXPIRED_IN_FLIGHT" : classifiedFailure,
          counters: {
            dnsCalls,
            connectAttempts: 1,
            httpApplicationBytes: errorApplicationBytes(error),
          },
        };
      }
      const counters = {
        dnsCalls,
        connectAttempts: 1,
        httpApplicationBytes: response.applicationBytes,
      } as const;
      if (clock().getTime() >= expiresAt) {
        return { kind: "blocked", code: "CONSENT_EXPIRED_IN_FLIGHT", counters };
      }
      if (response.body.byteLength > 65_536) {
        return { kind: "blocked", code: "RESPONSE_SIZE_LIMIT", counters };
      }
      const headers = lowerHeaderMap(response.rawHeaders);
      if (headers === undefined || response.rawTrailers.length !== 0) {
        return { kind: "blocked", code: "POLICY_BLOCKED", counters };
      }
      const encoding = headers.get("content-encoding")?.[0]?.trim().toLowerCase();
      const contentLength = headers.get("content-length")?.[0];
      const transferEncoding = headers.get("transfer-encoding")?.[0];
      if ((encoding !== undefined && encoding !== "identity") ||
          (contentLength !== undefined && transferEncoding !== undefined) ||
          (contentLength !== undefined && (!/^\d+$/u.test(contentLength) ||
            Number(contentLength) !== response.body.byteLength))) {
        return { kind: "blocked", code: "POLICY_BLOCKED", counters };
      }
      const contentType = headers.get("content-type")?.[0] ?? null;
      const retryAfter = headers.get("retry-after")?.[0] ?? null;
      if (input.actionKind === "robots" && (response.statusCode === 404 || response.statusCode === 410)) {
        return {
          kind: "success", status: response.statusCode, counters,
          selectedIpv4: input.pinnedIpv4, answerSetDigest: input.answerSetDigest,
          body: new Uint8Array(), contentType: null, retryAfter, usability: null,
        };
      }
      if (response.statusCode !== 200) {
        return { kind: "blocked", code: statusCode(response.statusCode), counters, retryAfter };
      }
      if (contentType === null || (input.actionKind === "robots" &&
          !/^text\/plain(?:\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8))?\s*$/iu.test(contentType))) {
        return { kind: "blocked", code: "POLICY_BLOCKED", counters };
      }
      if (input.actionKind === "robots") {
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(response.body);
        } catch {
          return { kind: "blocked", code: "INVALID_UTF8", counters };
        }
        return {
          kind: "success", status: 200, counters,
          selectedIpv4: input.pinnedIpv4, answerSetDigest: input.answerSetDigest,
          body: response.body, contentType, retryAfter, usability: null,
        };
      }
      const usability = evaluatePublicContent(response.body, contentType, input.canonicalUrl);
      if (usability.kind === "blocked") return { ...usability, counters };
      return {
        kind: "success", status: 200, counters,
        selectedIpv4: input.pinnedIpv4, answerSetDigest: input.answerSetDigest,
        body: response.body, contentType, retryAfter, usability,
      };
  }

  return Object.freeze({
    resolve,
    request: (input: SafePinnedHttpRequest) => requestPinned(input),
    async acquire(input: SafePublicHttpRequest): Promise<SafePublicHttpResult> {
      const resolution = await resolve({
        version: input.version,
        url: input.url,
        expiresAt: input.expiresAt,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (resolution.kind === "blocked") return resolution;
      return requestPinned({
        version: input.version,
        actionKind: input.actionKind,
        canonicalUrl: resolution.canonicalUrl,
        canonicalOrigin: resolution.canonicalOrigin,
        hostname: resolution.hostname,
        pinnedIpv4: resolution.selectedIpv4,
        answerSetDigest: resolution.answerSetDigest,
        expiresAt: input.expiresAt,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }, 1);
    },
  });
}
