import { VectorSearchResult } from "./types.js";

export type VectorIndexItem<T> = {
  id: string;
  text: string;
  vector?: number[];
  item: T;
};

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/u)
      .filter((part) => part.length > 2),
  );
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) {
    return 0;
  }

  let dot = 0;
  let leftMag = 0;
  let rightMag = 0;
  for (let i = 0; i < length; i += 1) {
    dot += left[i] * right[i];
    leftMag += left[i] * left[i];
    rightMag += right[i] * right[i];
  }

  if (leftMag === 0 || rightMag === 0) {
    return 0;
  }

  return dot / Math.sqrt(leftMag * rightMag);
}

function lexicalScore(query: string, text: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) {
    return 0;
  }

  const textTokens = tokenize(text);
  let matches = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) {
      matches += 1;
    }
  }

  return matches / queryTokens.size;
}

export class VectorIndex<T> {
  private readonly items = new Map<string, VectorIndexItem<T>>();

  upsert(item: VectorIndexItem<T>): void {
    this.items.set(item.id, item);
  }

  delete(id: string): void {
    this.items.delete(id);
  }

  search(query: string, options: { vector?: number[]; limit?: number } = {}): VectorSearchResult<T>[] {
    const limit = Math.max(1, options.limit ?? 5);
    return [...this.items.values()]
      .map((item) => {
        const semantic =
          options.vector && item.vector
            ? cosineSimilarity(options.vector, item.vector)
            : 0;
        const lexical = lexicalScore(query, item.text);
        return {
          item: item.item,
          score: Math.max(semantic, lexical),
        };
      })
      .filter((result) => result.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  values(): T[] {
    return [...this.items.values()].map((entry) => entry.item);
  }
}
