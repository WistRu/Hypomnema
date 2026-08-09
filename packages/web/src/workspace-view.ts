export type WorkspaceView = "open" | "library" | "graph";

export function shouldRefreshLibrary(
  current: WorkspaceView,
  next: WorkspaceView,
): boolean {
  return current !== "library" && next === "library";
}
