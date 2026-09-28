/**
 * JSON extraction tests.
 *
 * Free models wrap JSON in prose and markdown constantly, so the extractor runs
 * on nearly every `PROMPT_JSON` response. That makes its failure modes worth
 * pinning: each case below is a way the obvious implementation produces
 * *confident garbage* — valid JSON with the wrong shape — rather than an honest
 * failure.
 */

import { describe, expect, it } from "vitest";
import { braceCandidates, extractJson, stripCodeFence } from "../../src/parse/extract.js";

describe("a clean response", () => {
  it("parses directly", () => {
    const result = extractJson('{"findings":[]}');
    expect(result?.strategy).toBe("direct");
    expect(result?.value).toEqual({ findings: [] });
  });

  it("tolerates surrounding whitespace", () => {
    expect(extractJson('\n\n  {"findings":[]}  \n')?.value).toEqual({ findings: [] });
  });

  it("returns null for empty input", () => {
    expect(extractJson("")).toBeNull();
    expect(extractJson("   \n  ")).toBeNull();
  });

  it("returns null for prose with no object", () => {
    expect(extractJson("I found no issues in this diff.")).toBeNull();
  });
});

describe("markdown fences", () => {
  it("unwraps a labelled json fence", () => {
    const result = extractJson('```json\n{"findings":[]}\n```');
    expect(result?.strategy).toBe("unfenced");
    expect(result?.value).toEqual({ findings: [] });
  });

  it("unwraps a bare fence", () => {
    expect(extractJson('```\n{"findings":[]}\n```')?.value).toEqual({ findings: [] });
  });

  it("unwraps a fence with trailing prose inside the closing marker", () => {
    expect(extractJson('```json\n{"a":1}\n```')?.value).toEqual({ a: 1 });
  });

  it("unwraps an unclosed fence", () => {
    // Models truncate mid-fence often enough that requiring closure would
    // discard an otherwise-valid answer.
    expect(extractJson('```json\n{"findings":[]}')?.value).toEqual({ findings: [] });
  });

  it("handles a long fence", () => {
    const fence = "`".repeat(5);
    expect(extractJson(`${fence}json\n{"a":1}\n${fence}`)?.value).toEqual({ a: 1 });
  });

  it("leaves text without a fence untouched", () => {
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
  });
});

describe("prose around the JSON", () => {
  it("extracts the object from a preamble and a postamble", () => {
    const result = extractJson(
      'I reviewed the diff. Here are my findings:\n\n{"findings":[]}\n\nLet me know if you want detail.',
    );
    expect(result?.value).toEqual({ findings: [] });
    expect(result?.strategy).toBe("extracted");
  });

  it("extracts through a fence embedded in prose", () => {
    const result = extractJson('Sure!\n\n```json\n{"findings":[{"path":"a.ts"}]}\n```\n\nDone.');
    expect(result?.value).toEqual({ findings: [{ path: "a.ts" }] });
  });
});

describe("braces inside strings do not confuse the scanner", () => {
  // The reason this is a scanner and not a regex: a naive `/\{[\s\S]*\}/`
  // matches from the first brace to the last, joining a preamble example object
  // with the real one into something syntactically valid and semantically wrong.
  it("does not open a scope on a brace inside a string", () => {
    const result = extractJson('{"explanation":"the loop uses i < items.length and j > 0"}');
    expect(result?.value).toEqual({ explanation: "the loop uses i < items.length and j > 0" });
  });

  it("handles an escaped quote inside a string", () => {
    const result = extractJson('{"explanation":"use \\"escaped\\" quotes here"}');
    expect((result?.value as { explanation: string }).explanation).toBe('use "escaped" quotes here');
  });

  it("handles an escaped backslash before a quote", () => {
    const result = extractJson('{"explanation":"a backslash \\\\ then a quote \\" and a brace }"}');
    expect((result?.value as { explanation: string }).explanation).toContain("}");
  });

  it("does not merge a preamble example object with the real one", () => {
    // A naive first-brace-to-last-brace regex joins these into one syntactically
    // valid object with the wrong shape, which then fails schema validation and
    // costs a repair request. Balanced scanning finds them separately.
    const text = 'Example: {"findings": []}\n\nActual: {"findings": [{"path": "real.ts"}]}';
    const result = extractJson(text);

    expect(result?.strategy).toBe("extracted");
    // The longest candidate that parses wins. Neither merged object is valid
    // JSON, so one of the two real ones is chosen and it is well-formed.
    expect(result?.value).toEqual({ findings: [{ path: "real.ts" }] });
  });
});

describe("multiple objects", () => {
  it("prefers the longest balanced candidate", () => {
    const text = '{"note":"short"}\n{"findings":[{"path":"a.ts","explanation":"x"}]}';
    const result = extractJson(text);
    expect((result?.value as { findings?: unknown[] }).findings).toHaveLength(1);
  });

  it("tries candidates in longest-first order", () => {
    // Longest first matters: a whole-response object beats a nested `findings`
    // object, and both beat a fragment in the preamble.
    const candidates = [...braceCandidates('{"a":1} and {"bbbb":2} and {"c":3}')];
    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toBe('{"bbbb":2}');
    for (let i = 1; i < candidates.length; i += 1) {
      expect(candidates[i - 1]?.length).toBeGreaterThanOrEqual(candidates[i]?.length ?? 0);
    }
  });

  it("finds the object after an unbalanced prefix", () => {
    const result = extractJson('Here is my analysis: { oops\n\n{"findings":[]}');
    expect(result?.value).toEqual({ findings: [] });
  });
});

describe("structurally broken JSON", () => {
  it("repairs trailing commas", () => {
    const result = extractJson('{"findings":[{"path":"a.ts"},]}');
    expect(result?.value).toEqual({ findings: [{ path: "a.ts" }] });
  });

  it("repairs single quotes", () => {
    const result = extractJson("{'findings': []}");
    expect(result?.value).toEqual({ findings: [] });
  });

  it("repairs a truncated object", () => {
    const result = extractJson('{"findings":[{"path":"a.ts","explanation":"unfinis');
    expect(result?.value).toBeDefined();
  });

  it("reports the repair strategy so it is visible in diagnostics", () => {
    // A locally repaired response is less trustworthy than a clean one, and the
    // step summary needs to be able to say so.
    const result = extractJson('{"findings":[{"path":"a.ts"},]}');
    expect(result?.strategy).toBe("repaired");
  });
});

describe("input that cannot be recovered", () => {
  it("returns null for pure prose", () => {
    expect(extractJson("The code looks fine to me overall.")).toBeNull();
  });

  it("returns null rather than throwing on deeply broken input", () => {
    expect(() => extractJson("{{{[[[}}]]]")).not.toThrow();
    expect(extractJson("{{{[[[}}]]]")).toBeNull();
  });

  it("does not hang on a very large unparseable response", () => {
    const huge = "x".repeat(50_000) + "{ not json";
    const started = Date.now();
    expect(extractJson(huge)).toBeNull();
    // Bounded work: a quadratic scan on 50k of noise would blow this.
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("JSON scalars are not mistaken for the response", () => {
  it("does not extract a bare number", () => {
    expect(extractJson("42")).toBeNull();
  });

  it("does not extract a bare string", () => {
    expect(extractJson('"all good"')).toBeNull();
  });
});
