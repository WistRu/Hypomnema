export function clampPage(
  page: number,
  total: number,
  pageSize: number,
): number {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return Math.min(Math.max(1, page), totalPages);
}

export function isTrulyEmptyPage(value: {
  items: readonly unknown[];
  total: number;
}): boolean {
  return value.total === 0;
}
