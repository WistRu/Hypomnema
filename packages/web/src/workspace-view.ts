export type WorkspaceView = "library" | "graph";

export function shouldRefreshLibrary(
  current: WorkspaceView,
  next: WorkspaceView,
): boolean {
  return current !== "library" && next === "library";
}
