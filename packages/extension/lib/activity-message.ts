export interface ActivityHeartbeatSignal {
  kind: "heartbeat";
  type: "tabhub:activity-signal";
  url: string;
}

export interface ActivityInteractionSignal {
  kind: "interaction";
  type: "tabhub:activity-signal";
}

export type ActivitySignal =
  | ActivityHeartbeatSignal
  | ActivityInteractionSignal;

export const activityContentScriptPing = {
  type: "tabhub:activity-ping",
} as const;

export const activityContentScriptPong = {
  type: "tabhub:activity-pong",
} as const;

function isStrictRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function isActivityContentScriptPing(value: unknown): boolean {
  return (
    isStrictRecord(value, ["type"]) &&
    value.type === activityContentScriptPing.type
  );
}

export function isActivityContentScriptPong(value: unknown): boolean {
  return (
    isStrictRecord(value, ["type"]) &&
    value.type === activityContentScriptPong.type
  );
}

export function parseActivitySignal(value: unknown): ActivitySignal | undefined {
  if (!isStrictRecord(value, ["kind", "type"])) {
    if (!isStrictRecord(value, ["kind", "type", "url"])) return undefined;
  }
  if (value.type !== "tabhub:activity-signal") return undefined;

  if (value.kind === "interaction") {
    return Object.keys(value).length === 2
      ? { kind: "interaction", type: "tabhub:activity-signal" }
      : undefined;
  }
  if (
    value.kind !== "heartbeat" ||
    Object.keys(value).length !== 3 ||
    typeof value.url !== "string" ||
    !URL.canParse(value.url)
  ) {
    return undefined;
  }

  const protocol = new URL(value.url).protocol;
  return protocol === "http:" || protocol === "https:"
    ? {
        kind: "heartbeat",
        type: "tabhub:activity-signal",
        url: value.url,
      }
    : undefined;
}
