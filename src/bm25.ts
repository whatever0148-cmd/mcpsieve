export interface SearchResult {
  id: string;
  score: number;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "for", "from", "has",
  "have", "if", "in", "into", "is", "it", "its", "of", "on", "or", "that", "the",
  "this", "to", "was", "when", "will", "with", "you", "your",
  "use", "used", "using", "tool", "tools", "returns", "return",
  "param", "params", "parameter", "parameters", "optional", "string", "number",
  "boolean", "object", "array", "type", "json", "api",
]);

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
}

export class BM25Index {
  private readonly postings = new Map<string, Map<string, number>>();
  private readonly docTerms = new Map<string, Map<string, number>>();
  private readonly docLengths = new Map<string, number>();
  private totalLength = 0;

  constructor(
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {}

  get size(): number {
    return this.docLengths.size;
  }

  addDocument(id: string, text: string): void {
    if (this.docLengths.has(id)) this.removeDocument(id);

    const tokens = tokenize(text);
    const freqs = new Map<string, number>();
    for (const t of tokens) freqs.set(t, (freqs.get(t) ?? 0) + 1);

    for (const [term, tf] of freqs) {
      let posting = this.postings.get(term);
      if (!posting) this.postings.set(term, (posting = new Map()));
      posting.set(id, tf);
    }
    this.docTerms.set(id, freqs);
    this.docLengths.set(id, tokens.length);
    this.totalLength += tokens.length;
  }

  removeDocument(id: string): boolean {
    const freqs = this.docTerms.get(id);
    if (!freqs) return false;
    for (const term of freqs.keys()) {
      const posting = this.postings.get(term);
      posting?.delete(id);
      if (posting?.size === 0) this.postings.delete(term);
    }
    this.totalLength -= this.docLengths.get(id) ?? 0;
    this.docTerms.delete(id);
    this.docLengths.delete(id);
    return true;
  }

  clear(): void {
    this.postings.clear();
    this.docTerms.clear();
    this.docLengths.clear();
    this.totalLength = 0;
  }

  search(query: string, limit = 10): SearchResult[] {
    const n = this.docLengths.size;
    if (n === 0 || limit <= 0) return [];

    const avgLength = this.totalLength / n || 1;
    const scores = new Map<string, number>();

    for (const term of new Set(tokenize(query))) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const idf = Math.log(1 + (n - posting.size + 0.5) / (posting.size + 0.5));
      for (const [id, tf] of posting) {
        const len = this.docLengths.get(id) ?? 0;
        const norm = tf + this.k1 * (1 - this.b + (this.b * len) / avgLength);
        const score = (idf * tf * (this.k1 + 1)) / norm;
        scores.set(id, (scores.get(id) ?? 0) + score);
      }
    }

    return [...scores]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      .slice(0, limit);
  }
}
