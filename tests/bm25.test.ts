import { describe, expect, it } from "vitest";
import { BM25Index, tokenize } from "../src/bm25.js";

describe("tokenize", () => {
  it("lowercases and strips punctuation", () => {
    expect(tokenize("Read-File, (Contents)!")).toEqual(["read", "file", "contents"]);
  });

  it("splits snake_case and camelCase identifiers", () => {
    expect(tokenize("list_open_issues")).toEqual(["list", "open", "issues"]);
    expect(tokenize("createPullRequest")).toEqual(["create", "pull", "request"]);
  });

  it("filters common and technical stop-words", () => {
    expect(tokenize("Use the tool to search for a string in the API")).toEqual(["search"]);
  });

  it("keeps action verbs so developer tool queries still match", () => {
    expect(tokenize("get set fetch list read create")).toEqual(["get", "set", "fetch", "list", "read", "create"]);
  });

  it("keeps digits and unicode letters", () => {
    expect(tokenize("http2 café")).toEqual(["http2", "café"]);
  });

  it("returns empty for empty or punctuation-only input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("!!! ---")).toEqual([]);
  });
});

describe("BM25Index", () => {
  const build = () => {
    const idx = new BM25Index();
    idx.addDocument("read_file", "Read the contents of a file from disk");
    idx.addDocument("write_file", "Write contents to a file on disk");
    idx.addDocument("list_issues", "List open issues in a GitHub repository");
    idx.addDocument("send_email", "Send an email message to a recipient");
    return idx;
  };

  it("ranks the most relevant document first", () => {
    const idx = build();
    expect(idx.search("github issues")[0]?.id).toBe("list_issues");
    expect(idx.search("email")[0]?.id).toBe("send_email");
  });

  it("scores rarer terms higher than common ones", () => {
    const idx = build();
    const res = idx.search("file issues");
    expect(res[0]?.id).toBe("list_issues");
  });

  it("returns scores in descending order", () => {
    const res = build().search("file disk contents");
    for (let i = 1; i < res.length; i++) expect(res[i - 1]!.score).toBeGreaterThanOrEqual(res[i]!.score);
    expect(res.map((r) => r.id).sort()).toEqual(["read_file", "write_file"]);
  });

  it("respects the limit", () => {
    expect(build().search("file", 1)).toHaveLength(1);
    expect(build().search("file", 0)).toEqual([]);
  });

  it("returns nothing for unknown terms, stop-word-only, or empty queries", () => {
    const idx = build();
    expect(idx.search("zebra")).toEqual([]);
    expect(idx.search("the of a")).toEqual([]);
    expect(idx.search("")).toEqual([]);
  });

  it("returns nothing on an empty index", () => {
    expect(new BM25Index().search("anything")).toEqual([]);
  });

  it("matches the Okapi BM25 formula (k1=1.2, b=0.75)", () => {
    const idx = new BM25Index();
    idx.addDocument("a", "apple banana");
    idx.addDocument("b", "banana cherry cherry");
    // N=2, avgdl=2.5. "apple": n=1, tf=1, dl=2 in doc a.
    const idf = Math.log(1 + (2 - 1 + 0.5) / (1 + 0.5));
    const expected = (idf * 2.2) / (1 + 1.2 * (1 - 0.75 + (0.75 * 2) / 2.5));
    const [hit] = idx.search("apple");
    expect(hit?.id).toBe("a");
    expect(hit?.score).toBeCloseTo(expected, 10);
  });

  it("applies term-frequency saturation and length normalization", () => {
    const idx = new BM25Index();
    idx.addDocument("short", "deploy");
    idx.addDocument("long", "deploy " + "filler ".repeat(30));
    idx.addDocument("other", "unrelated words here");
    expect(idx.search("deploy")[0]?.id).toBe("short");
  });

  it("replaces a document when the id is re-added", () => {
    const idx = build();
    idx.addDocument("send_email", "Delete a calendar event");
    expect(idx.size).toBe(4);
    expect(idx.search("email")).toEqual([]);
    expect(idx.search("calendar")[0]?.id).toBe("send_email");
  });

  it("removes documents and cleans up the index", () => {
    const idx = build();
    expect(idx.removeDocument("list_issues")).toBe(true);
    expect(idx.removeDocument("list_issues")).toBe(false);
    expect(idx.search("issues")).toEqual([]);
    expect(idx.size).toBe(3);
  });

  it("clear() empties the index", () => {
    const idx = build();
    idx.clear();
    expect(idx.size).toBe(0);
    expect(idx.search("file")).toEqual([]);
  });

  it("breaks score ties deterministically by id", () => {
    const idx = new BM25Index();
    idx.addDocument("b", "ping");
    idx.addDocument("a", "ping");
    expect(idx.search("ping").map((r) => r.id)).toEqual(["a", "b"]);
  });

  describe("benchmark", () => {
    const verbs = ["create", "delete", "list", "update", "fetch", "search", "send", "read", "write", "archive"];
    const nouns = ["issue", "file", "email", "branch", "commit", "calendar", "message", "database", "table", "user"];

    it("searches 150 mock tools in under 5ms", () => {
      const idx = new BM25Index();
      for (let i = 0; i < 150; i++) {
        const verb = verbs[i % verbs.length]!;
        const noun = nouns[Math.floor(i / verbs.length) % nouns.length]!;
        idx.addDocument(
          `${verb}_${noun}_${i}`,
          `${verb} ${noun}: ${verb} a ${noun} in the remote service. Accepts identifier ${i}, filters and pagination options.`,
        );
      }
      expect(idx.size).toBe(150);

      for (let i = 0; i < 50; i++) idx.search("create github issue"); // warm up JIT

      const runs = 20;
      const durations: number[] = [];
      for (let i = 0; i < runs; i++) {
        const start = performance.now();
        const res = idx.search("delete calendar event message", 10);
        durations.push(performance.now() - start);
        expect(res.length).toBeGreaterThan(0);
      }
      durations.sort((a, b) => a - b);
      const median = durations[Math.floor(runs / 2)]!;
      // Median, not max: a single GC pause or noisy CI neighbour shouldn't fail the build.
      expect(median).toBeLessThan(5);
    });
  });
});
