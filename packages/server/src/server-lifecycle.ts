export interface ServerListenOptions {
  host: string;
  port: number;
}

export interface ServerLifecycleTarget {
  close(): Promise<void>;
  listen(options: ServerListenOptions): Promise<unknown>;
}

export async function listenWithCleanup(
  app: ServerLifecycleTarget,
  options: ServerListenOptions,
  reportCleanupError: (error: unknown) => void = () => undefined,
): Promise<void> {
  try {
    await app.listen(options);
  } catch (listenError) {
    try {
      await app.close();
    } catch (closeError) {
      reportCleanupError(closeError);
    }

    throw listenError;
  }
}
