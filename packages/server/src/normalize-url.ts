export function normalizeUrl(input: string): string {
  const url = new URL(input);
  const retainedParameters = [...url.searchParams.entries()]
    .filter(([key]) => !key.toLowerCase().startsWith("utm_"));

  url.search = "";

  for (const [key, value] of retainedParameters) {
    url.searchParams.append(key, value);
  }

  return url.toString();
}
