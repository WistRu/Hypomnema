import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type Database from "better-sqlite3";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isExtensionOrigin, resolveExtensionOrigin } from "./request-security.js";

const sessionCookieName = "tabhub_local_session";
const sessionLifetimeMs = 8 * 60 * 60 * 1_000;
const challengeLifetimeMs = 5 * 60 * 1_000;
const maxChallengeAttempts = 5;
/**
 * A person pairs a browser once. The loop this bounds is a script inside the
 * app page minting challenges to rotate the legitimate extension's credential
 * over and over — a nuisance rather than a theft, but an unbounded one. Ten a
 * minute is far beyond any human use and ends the loop immediately.
 *
 * Held per installation and in memory: the server is single-process and local,
 * and a restart forgiving the counter is the right trade for a nuisance limit.
 */
const maxChallengesPerWindow = 10;
const challengeWindowMs = 60 * 1_000;

export class PairingRateLimitedError extends Error {
  constructor() {
    super("PAIRING_RATE_LIMITED");
    this.name = "PairingRateLimitedError";
  }
}

export const localAuthError = Object.freeze({
  error: "LOCAL_CAPABILITY_REQUIRED",
  message: "A valid local capability is required",
});

interface CapabilityRow {
  installation_id: string;
  extension_origin: string;
  credential_hash: Buffer | null;
  credential_version: number;
  revoked_at: string | null;
}

interface ChallengeRow {
  challenge_id: string;
  installation_id: string;
  extension_origin: string;
  code_salt: Buffer;
  code_hash: Buffer;
  expires_at: string;
  consumed_at: string | null;
  failed_attempts: number;
}

export interface LocalCapabilityIdentity {
  kind: "web" | "extension";
  installationId: string | null;
}

export interface LocalCapabilityService {
  authenticate(request: FastifyRequest): LocalCapabilityIdentity | null;
  createPairingChallenge(input: {
    extensionOrigin: string;
    installationId: string;
  }): { challengeId: string; code: string; expiresAt: string };
  consumePairingChallenge(input: {
    challengeId: string;
    code: string;
    extensionOrigin: string | undefined;
    installationId: string;
  }): { credential: string; credentialVersion: number } | null;
  issueWebSession(reply: FastifyReply): void;
  revoke(installationId: string): boolean;
}

function digest(parts: readonly (string | Buffer)[]): Buffer {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function sameDigest(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function opaqueSecret(): string {
  return randomBytes(32).toString("base64url");
}

function cookieValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers.cookie;
  if (raw === undefined) return undefined;
  for (const segment of raw.split(";")) {
    const [key, ...value] = segment.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length);
  return token.length >= 40 && token.length <= 128 ? token : undefined;
}

export function createLocalCapabilityService(
  connection: Database.Database,
  options: { now?: () => Date } = {},
): LocalCapabilityService {
  const now = options.now ?? (() => new Date());
  const sessions = new Map<string, number>();
  const challengeMints = new Map<string, number[]>();
  const selectCapabilityByInstallation = connection.prepare(`
    SELECT installation_id, extension_origin, credential_hash,
      credential_version, revoked_at
    FROM local_installation_capabilities
    WHERE installation_id = ?
  `);
  const selectCapabilitiesByHash = connection.prepare(`
    SELECT installation_id, extension_origin, credential_hash,
      credential_version, revoked_at
    FROM local_installation_capabilities
    WHERE credential_hash = ? AND revoked_at IS NULL
  `);
  const selectChallenge = connection.prepare(`
    SELECT challenge_id, installation_id, extension_origin, code_salt,
      code_hash, expires_at, consumed_at, failed_attempts
    FROM local_pairing_challenges
    WHERE challenge_id = ?
  `);
  const invalidateChallenges = connection.prepare(`
    UPDATE local_pairing_challenges
    SET failed_attempts = ${maxChallengeAttempts}
    WHERE installation_id = @installationId AND consumed_at IS NULL
  `);
  const insertCapability = connection.prepare(`
    INSERT INTO local_installation_capabilities (
      installation_id, extension_origin, credential_hash, credential_version,
      created_at, rotated_at, revoked_at, last_used_at
    ) VALUES (@installationId, @extensionOrigin, NULL, 0, @at, NULL, NULL, NULL)
  `);
  const insertChallenge = connection.prepare(`
    INSERT INTO local_pairing_challenges (
      challenge_id, installation_id, extension_origin, code_salt, code_hash,
      created_at, expires_at, consumed_at, failed_attempts
    ) VALUES (
      @challengeId, @installationId, @extensionOrigin, @codeSalt, @codeHash,
      @createdAt, @expiresAt, NULL, 0
    )
  `);
  const failChallenge = connection.prepare(`
    UPDATE local_pairing_challenges
    SET failed_attempts = MIN(failed_attempts + 1, ${maxChallengeAttempts})
    WHERE challenge_id = ? AND consumed_at IS NULL
  `);
  const consumeChallenge = connection.prepare(`
    UPDATE local_pairing_challenges
    SET consumed_at = @at
    WHERE challenge_id = @challengeId AND consumed_at IS NULL
      AND failed_attempts < ${maxChallengeAttempts}
  `);
  const rotateCapability = connection.prepare(`
    UPDATE local_installation_capabilities
    SET credential_hash = @credentialHash,
      credential_version = credential_version + 1,
      rotated_at = CASE WHEN credential_version > 0 THEN @at ELSE rotated_at END,
      revoked_at = NULL,
      last_used_at = NULL
    WHERE installation_id = @installationId
      AND extension_origin = @extensionOrigin
  `);
  const markUsed = connection.prepare(`
    UPDATE local_installation_capabilities
    SET last_used_at = ?
    WHERE installation_id = ? AND revoked_at IS NULL
  `);
  const revokeCapability = connection.prepare(`
    UPDATE local_installation_capabilities
    SET revoked_at = ?
    WHERE installation_id = ? AND revoked_at IS NULL
  `);
  const revoke = connection.transaction((installationId: string): boolean => {
    const capability = selectCapabilityByInstallation.get(installationId) as
      | CapabilityRow
      | undefined;
    if (capability === undefined) return false;

    invalidateChallenges.run({ installationId });
    if (capability.credential_version > 0 && capability.revoked_at === null) {
      revokeCapability.run(now().toISOString(), installationId);
    }
    return true;
  });

  const createPairingChallenge = connection.transaction(
    (input: { extensionOrigin: string; installationId: string }) => {
      const extensionOrigin = input.extensionOrigin.toLowerCase();
      if (!isExtensionOrigin(extensionOrigin)) throw new Error("PAIRING_FAILED");
      const timestamp = now();
      const windowStart = timestamp.getTime() - challengeWindowMs;
      const recent = (challengeMints.get(input.installationId) ?? [])
        .filter((mintedAt) => mintedAt > windowStart);
      if (recent.length >= maxChallengesPerWindow) {
        challengeMints.set(input.installationId, recent);
        throw new PairingRateLimitedError();
      }
      challengeMints.set(input.installationId, [...recent, timestamp.getTime()]);
      const at = timestamp.toISOString();
      const existing = selectCapabilityByInstallation.get(
        input.installationId,
      ) as CapabilityRow | undefined;
      if (
        existing !== undefined &&
        existing.extension_origin !== extensionOrigin
      ) {
        throw new Error("PAIRING_FAILED");
      }
      if (existing === undefined) {
        insertCapability.run({
          installationId: input.installationId,
          extensionOrigin,
          at,
        });
      }
      invalidateChallenges.run({ installationId: input.installationId });
      const challengeId = randomUUID();
      const code = opaqueSecret();
      const codeSalt = randomBytes(32);
      const expiresAt = new Date(
        timestamp.getTime() + challengeLifetimeMs,
      ).toISOString();
      insertChallenge.run({
        challengeId,
        installationId: input.installationId,
        extensionOrigin,
        codeSalt,
        codeHash: digest([codeSalt, code]),
        createdAt: at,
        expiresAt,
      });
      return { challengeId, code, expiresAt };
    },
  );

  const consumePairingChallenge = connection.transaction(
    (input: {
      challengeId: string;
      code: string;
      extensionOrigin: string | undefined;
      installationId: string;
    }) => {
      const challenge = selectChallenge.get(input.challengeId) as
        | ChallengeRow
        | undefined;
      const origin = input.extensionOrigin?.toLowerCase();
      const valid =
        challenge !== undefined &&
        challenge.consumed_at === null &&
        challenge.failed_attempts < maxChallengeAttempts &&
        challenge.expires_at > now().toISOString() &&
        challenge.installation_id === input.installationId &&
        challenge.extension_origin === origin &&
        sameDigest(challenge.code_hash, digest([challenge.code_salt, input.code]));
      if (!valid) {
        if (challenge !== undefined) failChallenge.run(input.challengeId);
        return null;
      }
      const credential = opaqueSecret();
      const at = now().toISOString();
      if (
        rotateCapability.run({
          credentialHash: digest([credential]),
          at,
          installationId: challenge.installation_id,
          extensionOrigin: challenge.extension_origin,
        }).changes !== 1 ||
        consumeChallenge.run({ challengeId: challenge.challenge_id, at })
          .changes !== 1
      ) {
        throw new Error("PAIRING_FAILED");
      }
      const capability = selectCapabilityByInstallation.get(
        challenge.installation_id,
      ) as CapabilityRow;
      return {
        credential,
        credentialVersion: capability.credential_version,
      };
    },
  );

  return {
    authenticate(request) {
      const session = cookieValue(request, sessionCookieName);
      if (
        session !== undefined &&
        request.headers["sec-fetch-site"] === "same-origin"
      ) {
        const sessionHash = digest([session]).toString("hex");
        const expiresAt = sessions.get(sessionHash);
        if (expiresAt !== undefined && expiresAt > now().getTime()) {
          return { kind: "web", installationId: null };
        }
        sessions.delete(sessionHash);
      }

      const token = bearer(request);
      const installationId = request.headers["x-tabhub-installation-id"];
      if (
        token === undefined ||
        typeof installationId !== "string"
      ) {
        return null;
      }
      const boundOrigin = resolveExtensionOrigin(request.headers);
      if (boundOrigin === undefined) return null;
      const matches = selectCapabilitiesByHash.all(
        digest([token]),
      ) as CapabilityRow[];
      if (matches.length !== 1) return null;
      const row = matches[0]!;
      if (
        row === undefined ||
        row.installation_id !== installationId ||
        row.extension_origin !== boundOrigin
      ) {
        return null;
      }
      markUsed.run(now().toISOString(), row.installation_id);
      return { kind: "extension", installationId: row.installation_id };
    },
    createPairingChallenge,
    consumePairingChallenge,
    issueWebSession(reply) {
      const session = opaqueSecret();
      sessions.set(digest([session]).toString("hex"), now().getTime() + sessionLifetimeMs);
      reply.header("Set-Cookie", [
        `${sessionCookieName}=${session}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${Math.floor(sessionLifetimeMs / 1_000)}`,
        `${sessionCookieName}=; HttpOnly; SameSite=Strict; Path=/api/local; Max-Age=0`,
      ]);
    },
    revoke,
  };
}

export function safeEqualSecret(
  candidate: string | undefined,
  expected: string | undefined,
): boolean {
  if (candidate === undefined || expected === undefined) return false;
  return sameDigest(digest([candidate]), digest([expected]));
}
