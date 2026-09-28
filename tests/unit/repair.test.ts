/**
 * Parse-and-repair tests.
 *
 * The property under test throughout: **a semantically wrong response is
 * rejected, never silently corrected.** The tempting alternative — mapping
 * `severity: "high"` to `critical`, or dropping a finding that has no quote — is
 * what turns a model mistake into a confident published comment that no human
 * can trace back to what the model actually said.
 *
 * The two repairs that *are* performed are exactly the ones with a single
 * faithful answer: a bare array, and a single finding object.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_REPAIRS,
  buildRepairMessage,
  parseFindingsResponse,
} from "../../src/parse/repair.js";

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: "src/loop.ts",
    buggyCodeQuote: "return values.length - 1;",
    explanation: "Drops the last element.",
    severity: "warning",
    suggestedCode: null,
    ...overrides,
  };
}

describe("a compliant response", () => {
  it("parses a clean structured response", () => {
    const result = parseFindingsResponse("", { findings: [body()] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategy).toBe("structured");
    expect(result.value.findings).toHaveLength(1);
  });

  it("prefers the API-parsed value over the raw text", () => {
    // An API-enforced schema is more trustworthy than anything recovered from
    // prose, so when both are available the structured one wins.
    const result = parseFindingsResponse(
      "total garbage that is not json",
      { findings: [] },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategy).toBe("structured");
  });

  it("parses an empty response as a clean review", () => {
    const result = parseFindingsResponse('{"findings":[]}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings).toHaveLength(0);
    // An empty result is a real answer, not a failure.
    expect(result.strategy).toBe("direct");
  });

  it("parses a JSON_OBJECT-mode response with prose around it", () => {
    const result = parseFindingsResponse(
      'Here you go:\n```json\n{"findings":[]}\n```\nHope that helps.',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategy).toBe("extracted");
  });
});

describe("unparseable output", () => {
  it("reports prose as unparseable rather than as a shape error", () => {
    // jsonrepair would happily wrap this into a JSON string. Without the
    // object-shape guard it would be reported as a schema failure, and the
    // repair message would tell the model to fix field shapes it never emitted.
    const result = parseFindingsResponse("I found no issues in this diff.");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unparseable).toBe(true);
  });

  it("marks prose as repairable, because the model can be asked again", () => {
    const result = parseFindingsResponse("Looks good to me!");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.repairable).toBe(true);
  });

  it("reports an empty response as unparseable", () => {
    const result = parseFindingsResponse("");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unparseable).toBe(true);
  });
});

describe("the two faithful local repairs", () => {
  // Both cases have exactly one correct interpretation, so repairing costs
  // nothing in fidelity. Anything ambiguous goes back to the model instead.

  it("wraps a bare findings array", () => {
    const result = parseFindingsResponse("[{\"path\":\"a.ts\",\"buggyCodeQuote\":\"x\",\"explanation\":\"y\",\"severity\":\"info\"}]");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.strategy).toBe("repaired_locally");
    expect(result.value.findings).toHaveLength(1);
    expect(result.notes.join(" ")).toMatch(/bare findings array/);
  });

  it("wraps a single finding object", () => {
    const result = parseFindingsResponse(
      '{"path":"a.ts","buggyCodeQuote":"x","explanation":"y","severity":"info"}',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings).toHaveLength(1);
  });

  it("records that a repair happened, so the summary can report it", () => {
    // A locally repaired response is less trustworthy than a clean one and the
    // step summary needs to be able to say so.
    const result = parseFindingsResponse("[]");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.notes.length).toBeGreaterThan(0);
  });
});

describe("semantic errors are rejected, never coerced", () => {
  it("rejects an unknown severity rather than mapping it", () => {
    const result = parseFindingsResponse(
      '{"findings":[{"path":"a.ts","buggyCodeQuote":"x","explanation":"y","severity":"high"}]}',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path === "findings[0].severity")).toBe(true);
  });

  it("rejects a finding with no quote, which cannot be anchored", () => {
    const result = parseFindingsResponse(
      '{"findings":[{"path":"a.ts","explanation":"y","severity":"info"}]}',
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a model-supplied line number rather than ignoring it", () => {
    // Silently dropping `lineNumber` would hide that the model was trying to
    // place the comment itself, which is the thing the anchoring ladder exists
    // to prevent.
    const result = parseFindingsResponse(
      '{"findings":[{"path":"a.ts","buggyCodeQuote":"x","explanation":"y","severity":"info","lineNumber":42}]}',
    );
    expect(result.ok).toBe(false);
  });

  it("rejects the whole response when one finding is malformed", () => {
    const result = parseFindingsResponse(
      '{"findings":[{"path":"a.ts","buggyCodeQuote":"x","explanation":"y","severity":"info"},' +
        '{"path":"b.ts","buggyCodeQuote":"z","explanation":"w","severity":"nope"}]}',
    );
    expect(result.ok).toBe(false);
  });
});

describe("the repair message", () => {
  it("lists the specific problems with their paths", () => {
    const failed = parseFindingsResponse(
      '{"findings":[{"path":"a.ts","buggyCodeQuote":"x","explanation":"y","severity":"high"}]}',
    );
    if (failed.ok) throw new Error("expected failure");
    const message = buildRepairMessage(failed);

    expect(message).toContain("findings[0].severity");
    expect(message).toMatch(/critical/);
  });

  it("tells a prose response it was not valid JSON", () => {
    const failed = parseFindingsResponse("Looks fine to me.");
    if (failed.ok) throw new Error("expected failure");
    expect(buildRepairMessage(failed)).toMatch(/not valid JSON/);
  });

  it("bounds how many issues it lists, and says how many were withheld", () => {
    // A model shown forty errors will not fix any of them.
    const many = {
      findings: Array.from({ length: 15 }, () => ({ path: "", buggyCodeQuote: "", severity: "bad" })),
    };
    const failed = parseFindingsResponse(JSON.stringify(many));
    if (failed.ok) throw new Error("expected failure");
    const message = buildRepairMessage(failed, 3);

    expect(message).toMatch(/and \d+ more/);
  });

  it("carries no repository content", () => {
    // The repair message is sent to the same untrusted third party, and it must
    // not become a channel for diff content to travel outside the chunk.
    const failed = parseFindingsResponse('{"findings":"SECRET_DIFF_CONTENT"}');
    if (failed.ok) throw new Error("expected failure");
    expect(buildRepairMessage(failed)).not.toContain("SECRET_DIFF_CONTENT");
  });

  it("repeats the exact severity vocabulary, since that is what went wrong", () => {
    const failed = parseFindingsResponse(
      '{"findings":[{"path":"a.ts","buggyCodeQuote":"x","explanation":"y","severity":"high"}]}',
    );
    if (failed.ok) throw new Error("expected failure");
    const message = buildRepairMessage(failed);

    for (const severity of ["critical", "warning", "info"]) {
      expect(message, `repair message should offer ${severity}`).toContain(severity);
    }
    expect(message).toMatch(/no other value is accepted/);
  });
});

describe("the repair budget is bounded", () => {
  it("allows exactly one repair request", () => {
    // Each repair is one of 50 daily requests. An unbounded loop would let a
    // misbehaving model consume the day's entire allowance.
    expect(MAX_REPAIRS).toBe(1);
  });
});

describe("a locally repaired response still goes through the real validator", () => {
  it("rejects a wrapped array whose contents are invalid", () => {
    const result = parseFindingsResponse('[{"path":"a.ts","severity":"high"}]');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The wrap succeeded; the contents did not. Both problems are reported.
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("rejects a wrapped single object whose contents are invalid", () => {
    const result = parseFindingsResponse('{"path":"a.ts","explanation":"y"}');
    expect(result.ok).toBe(false);
  });
});
