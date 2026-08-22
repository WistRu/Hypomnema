import { localExtensionOriginHeaderName } from "@tabhub/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";

const localAuthorityPattern = /^(?:127\.0\.0\.1|localhost)(?::([1-9]\d{0,4}))?$/i;
const extensionOriginPattern = /^chrome-extension:\/\/[a-z0-9_-]+$/i;

function hasValidOptionalPort(match: RegExpExecArray): boolean {
  const port = match[1];
  return port === undefined || Number(port) <= 65_535;
}

export function isAllowedLocalHostHeader(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const match = localAuthorityPattern.exec(value);
  return match !== null && hasValidOptionalPort(match);
}

export function isAllowedBrowserOrigin(value: string): boolean {
  if (extensionOriginPattern.test(value)) {
    return true;
  }

  const prefix = "http://";
  if (!value.toLowerCase().startsWith(prefix)) {
    return false;
  }

  return isAllowedLocalHostHeader(value.slice(prefix.length));
}

export function isExtensionOrigin(value: string | undefined): boolean {
  return value !== undefined && extensionOriginPattern.test(value);
}

export function resolveExtensionOrigin(
  headers: FastifyRequest["headers"],
): string | undefined {
  const browserOriginHeader = headers.origin;
  const extensionOriginHeader = headers[localExtensionOriginHeaderName];
  if (
    (browserOriginHeader !== undefined &&
      typeof browserOriginHeader !== "string") ||
    (extensionOriginHeader !== undefined &&
      typeof extensionOriginHeader !== "string")
  ) {
    return undefined;
  }
  const browserOrigin = browserOriginHeader?.toLowerCase();
  const extensionOrigin = extensionOriginHeader?.toLowerCase();
  if (
    (browserOrigin !== undefined && !isExtensionOrigin(browserOrigin)) ||
    (extensionOrigin !== undefined && !isExtensionOrigin(extensionOrigin)) ||
    (browserOrigin !== undefined &&
      extensionOrigin !== undefined &&
      browserOrigin !== extensionOrigin)
  ) {
    return undefined;
  }
  return extensionOrigin ?? browserOrigin;
}

export function isTopLevelAppNavigation(request: FastifyRequest): boolean {
  const pathname = request.url.split("?", 1)[0] ?? request.url;
  const targetsApp = pathname === "/app" || pathname.startsWith("/app/");

  return (
    (request.method === "GET" || request.method === "HEAD") &&
    targetsApp &&
    request.headers["sec-fetch-mode"] === "navigate" &&
    request.headers["sec-fetch-dest"] === "document"
  );
}

export function registerRequestSecurity(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Content-Security-Policy", "frame-ancestors 'none'");
    reply.header("X-Frame-Options", "DENY");

    if (!isAllowedLocalHostHeader(request.headers.host)) {
      return reply.code(421).send({ error: "UNTRUSTED_HOST" });
    }

    const origin = request.headers.origin;
    if (origin !== undefined && !isAllowedBrowserOrigin(origin)) {
      return reply.code(403).send({ error: "UNTRUSTED_ORIGIN" });
    }

    if (
      request.headers["sec-fetch-site"] === "cross-site" &&
      resolveExtensionOrigin(request.headers) === undefined &&
      !isTopLevelAppNavigation(request)
    ) {
      return reply.code(403).send({ error: "CROSS_SITE_REQUEST_BLOCKED" });
    }
  });
}
