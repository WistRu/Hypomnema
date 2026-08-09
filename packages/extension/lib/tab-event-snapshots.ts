type SnapshotRegistrar = (listener: () => void) => void;

export interface TabEventSnapshotRegistrars {
  activated?: SnapshotRegistrar;
  attached?: SnapshotRegistrar;
  created?: SnapshotRegistrar;
  detached?: SnapshotRegistrar;
  moved?: SnapshotRegistrar;
  removed?: SnapshotRegistrar;
  replaced?: SnapshotRegistrar;
  updated?: SnapshotRegistrar;
}

const EVENT_ORDER: readonly (keyof TabEventSnapshotRegistrars)[] = [
  "created",
  "updated",
  "removed",
  "replaced",
  "activated",
  "moved",
  "attached",
  "detached",
];

export function registerTabEventSnapshots(
  schedule: () => void,
  registrars: TabEventSnapshotRegistrars,
): void {
  for (const eventName of EVENT_ORDER) {
    registrars[eventName]?.(schedule);
  }
}
