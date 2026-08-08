import type { InboxCluster } from "@tabhub/shared";

export interface ClusterableInboxTab {
  id: number;
  title: string | null;
  text: string;
  embedding: Float32Array;
}

type InboxTextRow = Pick<ClusterableInboxTab, "id" | "title" | "text">;
type ProjectedInboxRow = InboxTextRow & { vector: Float32Array };
type PreparedInboxRow = ProjectedInboxRow & {
  titleTokens: string[];
  textTokens: string[];
};

const PROJECTED_DIMENSIONS = 32;
const MAX_TRAINING_ROWS = 2_000;
const MAX_ITERATIONS = 12;

const stopWords = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "article",
  "been",
  "before",
  "being",
  "between",
  "can",
  "for",
  "from",
  "guide",
  "have",
  "into",
  "notes",
  "page",
  "that",
  "the",
  "their",
  "this",
  "through",
  "using",
  "with",
  "your",
  "без",
  "для",
  "его",
  "или",
  "как",
  "над",
  "под",
  "при",
  "про",
  "это",
]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalized(vector: Float32Array): Float32Array {
  let squaredNorm = 0;
  for (const value of vector) squaredNorm += value * value;
  if (!Number.isFinite(squaredNorm) || squaredNorm === 0) {
    const fallback = new Float32Array(vector.length);
    fallback[0] = 1;
    return fallback;
  }
  const norm = Math.sqrt(squaredNorm);
  return Float32Array.from(vector, (value) => value / norm);
}

function projected(vector: Float32Array): Float32Array {
  const result = new Float32Array(PROJECTED_DIMENSIONS);
  const energy = new Float32Array(PROJECTED_DIMENSIONS);
  for (let index = 0; index < vector.length; index += 1) {
    const bucket = index % PROJECTED_DIMENSIONS;
    const hash = Math.imul(index + 1, -1_640_531_527) ^ (index >>> 1);
    const sign = (hash & 1) === 0 ? 1 : -1;
    result[bucket] = result[bucket]! + sign * vector[index]!;
    energy[bucket] = energy[bucket]! + vector[index]! * vector[index]!;
  }
  if (result.every((value) => value === 0)) {
    for (let index = 0; index < result.length; index += 1) {
      result[index] = Math.sqrt(energy[index]!);
    }
  }
  return normalized(result);
}

function similarity(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
  }
  return dot;
}

function initialCentroids(
  rows: ProjectedInboxRow[],
  count: number,
): Float32Array[] {
  const selected = [0];
  while (selected.length < count) {
    let bestIndex = -1;
    let bestDistance = -1;
    for (let index = 0; index < rows.length; index += 1) {
      if (selected.includes(index)) continue;
      const distance = Math.min(
        ...selected.map(
          (selectedIndex) =>
            1 - similarity(rows[index]!.vector, rows[selectedIndex]!.vector),
        ),
      );
      if (
        distance > bestDistance ||
        (distance === bestDistance &&
          (bestIndex === -1 || rows[index]!.id < rows[bestIndex]!.id))
      ) {
        bestIndex = index;
        bestDistance = distance;
      }
    }
    if (bestIndex === -1) break;
    selected.push(bestIndex);
  }
  return selected.map((index) => rows[index]!.vector.slice());
}

function nearestCluster(
  row: ProjectedInboxRow,
  centroids: Float32Array[],
): number {
  let bestCluster = 0;
  let bestSimilarity = Number.NEGATIVE_INFINITY;
  for (const [cluster, centroid] of centroids.entries()) {
    const score = similarity(row.vector, centroid);
    if (score > bestSimilarity) {
      bestCluster = cluster;
      bestSimilarity = score;
    }
  }
  return bestCluster;
}

function trainingSample(rows: ProjectedInboxRow[]): ProjectedInboxRow[] {
  if (rows.length <= MAX_TRAINING_ROWS) return rows;

  return Array.from({ length: MAX_TRAINING_ROWS }, (_, index) =>
    rows[
      Math.round((index * (rows.length - 1)) / (MAX_TRAINING_ROWS - 1))
    ]!,
  );
}

function fittedCentroids(
  rows: ProjectedInboxRow[],
  clusterCount: number,
): Float32Array[] {
  let centroids = initialCentroids(rows, clusterCount);
  let assignments = rows.map(() => -1);

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
    const nextAssignments = rows.map((row) => nearestCluster(row, centroids));
    if (nextAssignments.every((value, index) => value === assignments[index])) {
      return centroids;
    }
    assignments = nextAssignments;

    centroids = centroids.map((previous, cluster) => {
      const members = rows.filter((_, index) => assignments[index] === cluster);
      if (members.length === 0) return previous;
      const mean = new Float32Array(previous.length);
      for (const member of members) {
        for (let index = 0; index < mean.length; index += 1) {
          mean[index] = mean[index]! + member.vector[index]!;
        }
      }
      return normalized(mean);
    });
  }

  return centroids;
}

function assignClusters(
  rows: ProjectedInboxRow[],
  clusterCount: number,
): number[] {
  const centroids = fittedCentroids(trainingSample(rows), clusterCount);
  return rows.map((row) => nearestCluster(row, centroids));
}

function tokens(value: string): string[] {
  return (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (token) => token.length >= 3 && !stopWords.has(token),
  );
}

function labelCluster(
  members: PreparedInboxRow[],
  documentFrequency: Map<string, number>,
  totalDocuments: number,
  fallbackIndex: number,
): { name: string; keywords: string[] } {
  const weights = new Map<string, number>();
  for (const row of members) {
    for (const token of row.titleTokens) {
      weights.set(token, (weights.get(token) ?? 0) + 3);
    }
    for (const token of row.textTokens) {
      weights.set(token, (weights.get(token) ?? 0) + 1);
    }
  }

  const keywords = [...weights]
    .map(([token, weight]) => ({
      token,
      score:
        weight *
        (1 +
          Math.log(
            (totalDocuments + 1) /
              ((documentFrequency.get(token) ?? 0) + 1),
          )),
    }))
    .sort(
      (left, right) =>
        right.score - left.score || compareText(left.token, right.token),
    )
    .slice(0, 3)
    .map(({ token }) => token);
  const name =
    keywords.length === 0
      ? `Inbox cluster ${fallbackIndex + 1}`
      : keywords
          .slice(0, 2)
          .map((keyword) => keyword[0]!.toUpperCase() + keyword.slice(1))
          .join(" · ");

  return { name, keywords };
}

export function clusterInboxRows(
  inputRows: ClusterableInboxTab[],
  maxClusters: number,
): InboxCluster[] {
  if (inputRows.length === 0) return [];

  const rows = [...inputRows]
    .sort((left, right) => left.id - right.id)
    .map(({ id, title, text, embedding }) => ({
      id,
      title,
      text,
      vector: projected(embedding),
      titleTokens: tokens(title ?? ""),
      textTokens: tokens(text),
    }));
  const clusterCount = Math.min(
    maxClusters,
    rows.length,
    Math.ceil(Math.sqrt(rows.length)),
  );
  const assignments = assignClusters(rows, clusterCount);
  const groups = Array.from(
    { length: clusterCount },
    (): PreparedInboxRow[] => [],
  );
  for (const [index, cluster] of assignments.entries()) {
    groups[cluster]!.push(rows[index]!);
  }
  const populatedGroups = groups
    .filter((members) => members.length > 0)
    .sort((left, right) => left[0]!.id - right[0]!.id);
  const documentFrequency = new Map<string, number>();
  for (const row of rows) {
    for (const token of new Set([...row.titleTokens, ...row.textTokens])) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  return populatedGroups.map((members, index) => {
    const { name, keywords } = labelCluster(
      members,
      documentFrequency,
      rows.length,
      index,
    );
    const tabIds = members.map(({ id }) => id).sort((left, right) => left - right);
    return { name, keywords, tabIds, size: tabIds.length };
  });
}
