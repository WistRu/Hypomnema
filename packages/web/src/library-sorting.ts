import type { SortDirection, TabSortField } from "@tabhub/shared";

export interface LibrarySort {
  sortBy: TabSortField;
  sortDirection: SortDirection;
}

const defaultDirections: Record<TabSortField, SortDirection> = {
  title: "asc",
  topics: "asc",
  browser: "asc",
  activity: "desc",
  status: "asc",
  importance: "desc",
  state: "desc",
  age: "asc",
};

const fieldsByColumnId: Record<string, TabSortField | undefined> = {
  title: "title",
  tagPaths: "topics",
  browser: "browser",
  activity: "activity",
  status: "status",
  importance: "importance",
  isOpen: "state",
  age: "age",
};

export function defaultLibrarySortDirection(
  sortBy: TabSortField,
): SortDirection {
  return defaultDirections[sortBy];
}

export function librarySortFieldForColumn(
  columnId: string,
): TabSortField | undefined {
  return fieldsByColumnId[columnId];
}

export function libraryColumnAriaSort(
  sort: LibrarySort | null,
  columnId: string,
): "ascending" | "descending" | undefined {
  const sortBy = librarySortFieldForColumn(columnId);
  if (sortBy === undefined) return undefined;
  if (sort?.sortBy !== sortBy) return undefined;
  return sort.sortDirection === "asc" ? "ascending" : "descending";
}

export function nextLibrarySort(
  current: LibrarySort | null,
  sortBy: TabSortField,
): LibrarySort | null {
  const preferredDirection = defaultLibrarySortDirection(sortBy);
  if (current?.sortBy !== sortBy) {
    return { sortBy, sortDirection: preferredDirection };
  }
  if (current.sortDirection === preferredDirection) {
    return {
      sortBy,
      sortDirection: preferredDirection === "asc" ? "desc" : "asc",
    };
  }
  return null;
}
