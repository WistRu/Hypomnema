const loopbackHost = "127.0.0.1";

export function resolveServerHost(value: string | undefined): string {
  const host = value?.trim() || loopbackHost;

  if (host !== loopbackHost) {
    throw new Error(
      `TABHUB_HOST must be ${loopbackHost}; TabHub v1 has no authentication and cannot listen on a network interface`,
    );
  }

  return host;
}
