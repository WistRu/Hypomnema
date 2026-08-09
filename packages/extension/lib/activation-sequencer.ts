export interface ActivationSequencer {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * Keep browser-focus side effects in request order without putting them behind
 * network synchronization. The tail always settles so one failed switch does
 * not block later user intent.
 */
export function createActivationSequencer(): ActivationSequencer {
  let tail: Promise<void> = Promise.resolve();

  return {
    run<T>(operation: () => Promise<T>): Promise<T> {
      const result = tail.then(operation, operation);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
