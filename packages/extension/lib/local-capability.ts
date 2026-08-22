import {
  localCredentialResponseSchema,
  localExtensionOriginHeaderName,
} from "@tabhub/shared";
import { browser } from "wxt/browser";

import {
  LOCAL_PAIRING_CONSUME_ENDPOINT,
  SERVER_ORIGIN,
  STORAGE_KEYS,
} from "./constants";
import { isInstallationId } from "./storage";

type LocalCredentialResponse = ReturnType<
  typeof localCredentialResponseSchema.parse
>;

export interface StoredLocalCapability extends LocalCredentialResponse {
  installationId: string;
}

export class PairingRequiredError extends Error {
  constructor() {
    super("Pairing required");
    this.name = "PairingRequiredError";
  }
}

let trustedStorageOperation: Promise<void> | undefined;

export async function restrictLocalStorageToTrustedContexts(): Promise<void> {
  if (trustedStorageOperation !== undefined) return trustedStorageOperation;
  const storageArea = browser.storage.local as typeof browser.storage.local & {
    setAccessLevel?: (options: {
      accessLevel: "TRUSTED_CONTEXTS";
    }) => Promise<void>;
  };
  if (storageArea.setAccessLevel === undefined) {
    throw new Error("Secure extension storage is unavailable");
  }
  trustedStorageOperation = storageArea
    .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    .catch((error: unknown) => {
      trustedStorageOperation = undefined;
      throw error;
    });
  return trustedStorageOperation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseStoredLocalCapability(
  value: unknown,
): StoredLocalCapability | undefined {
  if (!isRecord(value) || !isInstallationId(value.installationId)) {
    return undefined;
  }
  const parsed = localCredentialResponseSchema.safeParse({
    credential: value.credential,
    credentialVersion: value.credentialVersion,
  });
  return parsed.success
    ? { ...parsed.data, installationId: value.installationId }
    : undefined;
}

export async function readLocalCapability(): Promise<
  StoredLocalCapability | undefined
> {
  await restrictLocalStorageToTrustedContexts();
  const stored = await browser.storage.local.get(STORAGE_KEYS.localCapability);
  return parseStoredLocalCapability(stored[STORAGE_KEYS.localCapability]);
}

export async function clearLocalCapability(
  expected?: StoredLocalCapability,
): Promise<void> {
  await restrictLocalStorageToTrustedContexts();
  if (expected !== undefined) {
    const current = await readLocalCapability();
    if (
      current?.credential !== expected.credential ||
      current.credentialVersion !== expected.credentialVersion
    ) {
      return;
    }
  }
  await browser.storage.local.remove(STORAGE_KEYS.localCapability);
}

export async function consumePairingChallenge(input: {
  challengeId: string;
  code: string;
  installationId: string;
}): Promise<StoredLocalCapability> {
  await restrictLocalStorageToTrustedContexts();
  const response = await fetch(LOCAL_PAIRING_CONSUME_ENDPOINT, {
    body: JSON.stringify(input),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok) throw new PairingRequiredError();
  const parsed = localCredentialResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new PairingRequiredError();
  const capability = { ...parsed.data, installationId: input.installationId };
  await browser.storage.local.set({
    [STORAGE_KEYS.localCapability]: capability,
  });
  return capability;
}

export async function localCapabilityFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const capability = await readLocalCapability();
  if (capability === undefined) throw new PairingRequiredError();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${capability.credential}`);
  headers.set("x-tabhub-installation-id", capability.installationId);
  headers.set(
    localExtensionOriginHeaderName,
    `chrome-extension://${browser.runtime.id}`,
  );
  const response = await fetch(`${SERVER_ORIGIN}${path}`, { ...init, headers });
  if (response.status === 401) {
    await clearLocalCapability(capability);
    throw new PairingRequiredError();
  }
  return response;
}
