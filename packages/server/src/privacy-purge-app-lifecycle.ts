export interface StartableRuntime { start(): void }
export interface WakeableRuntime { wake(): void }
export interface StoppableRuntime { stop(): Promise<void> }

export function startRuntimeStack(
  advanceRuntimeEpoch: () => void,
  privacyRuntime: StartableRuntime | undefined,
  aiRuntime: StartableRuntime | undefined,
): void {
  advanceRuntimeEpoch();
  privacyRuntime?.start();
  aiRuntime?.start();
}

export function wakeAfterC90Settlement(
  privacyRuntime: WakeableRuntime | undefined,
  aiRuntime: WakeableRuntime | undefined,
): void {
  privacyRuntime?.wake();
  aiRuntime?.wake();
}

export async function stopRuntimeStack(
  privacyRuntime: StoppableRuntime | undefined,
  aiRuntime: StoppableRuntime | undefined,
  closeDatabase: () => void,
): Promise<void> {
  await privacyRuntime?.stop();
  await aiRuntime?.stop();
  closeDatabase();
}

