export interface WorkspaceRestoreLock {
  run(operation: () => Promise<void>): Promise<boolean>;
}

export function createWorkspaceRestoreLock(): WorkspaceRestoreLock {
  let running = false;

  return {
    async run(operation) {
      if (running) return false;

      running = true;
      try {
        await operation();
        return true;
      } finally {
        running = false;
      }
    },
  };
}
