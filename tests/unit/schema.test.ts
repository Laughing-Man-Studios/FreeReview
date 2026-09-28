/**
 * Schema validation tests.
 *
 * The schema is the boundary between "text a model produced" and "a finding that
 * will be anchored and published". Validation here is what stops a confidently
 * wrong finding from becoming a confidently wrong comment, so the tests are
 * mostly about what is *rejected*.
 *
 * The two design decisions these pin down:
 *
 *  - **Non-coercion.** `severity: "high"` is rejected, not mapped. A repair
 *    would have to ask the model, and a local guess would publish a severity the
 *    model never claimed.
 *  - **Whole-object rejection.** A finding with one bad field does not become a
 *    finding with that field dropped. Partial interpretation is how a malformed
 *    response produces a plausible-looking comment.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_EXPLANATION_LENGTH,
  MAX_FINDINGS_PER_RESPONSE,
  MAX_PATH_LENGTH,
  MAX_QUOTE_LENGTH,
  SEVERITIES,
  describeSchema,
  validateFinding,
  validateFindingsResponse,
} from "../../src/schema/finding.js";

function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: "src/loop.ts",
    buggyCodeQuote: "return values.length - 1;",
    explanation: "Drops the last element, so the total is always one short.",
    severity: "warning",
    suggestedCode: null,
    ...overrides,
  };
}

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { findings: [finding()], ...overrides };
}

describe("a well-formed response", () => {
  it("accepts a single finding", () => {
    const result = validateFindingsResponse(response());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings).toHaveLength(1);
    expect(result.value.findings[0]?.severity).toBe("warning");
  });

  it("accepts an empty findings array as a clean review", () => {
    // The distinction that matters most: [] means "reviewed, found nothing",
    // which is a genuinely useful answer, not a failure.
    const result = validateFindingsResponse({ findings: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings).toHaveLength(0);
  });

  it("accepts every declared severity", () => {
    for (const severity of SEVERITIES) {
      const result = validateFindingsResponse(response({ findings: [finding({ severity })] }));
      expect(result.ok, `severity ${severity} should be accepted`).toBe(true);
    }
  });
});

describe("findings is required, not defaulted", () => {
  it("rejects a response with no findings key", () => {
    // Ambiguous between "no findings" and "malformed". Those mean opposite
    // things, so only an explicit [] counts as a clean review.
    const result = validateFindingsResponse({});
    expect(result.ok).toBe(false);
  });

  it("rejects a null findings value", () => {
    expect(validateFindingsResponse({ findings: null }).ok).toBe(false);
  });

  it("rejects findings that is not an array", () => {
    expect(validateFindingsResponse({ findings: "none" }).ok).toBe(false);
  });

  it("rejects a bare finding object at the top level", () => {
    expect(validateFindingsResponse(finding()).ok).toBe(false);
  });
});

describe("severity is never coerced", () => {
  // The single most important behaviour here. Mapping "high" to "critical"
  // would publish a severity the model never claimed, and the reviewer would
  // have no way to know.
  it.each(["high", "HIGH", "error", "blocker", "minor", "medium", "", "critical "])(
    "rejects severity %o",
    (severity) => {
      const result = validateFinding(finding({ severity }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.some((i) => i.path === "severity")).toBe(true);
    },
  );

  it("rejects a numeric severity", () => {
    expect(validateFinding(finding({ severity: 1 })).ok).toBe(false);
  });

  it("names the allowed values in the issue message", () => {
    const result = validateFinding(finding({ severity: "high" }));
    if (result.ok) throw new Error("expected rejection");
    expect(result.issues[0]?.message).toMatch(/critical/);
  });
});

describe("required fields are required", () => {
  it.each(["path", "buggyCodeQuote", "explanation", "severity"])("rejects a finding with no %s", (field) => {
    const incomplete = finding();
    delete incomplete[field];
    const result = validateFinding(incomplete);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path === field)).toBe(true);
  });

  it("rejects an empty quote, which cannot be anchored", () => {
    expect(validateFinding(finding({ buggyCodeQuote: "" })).ok).toBe(false);
  });

  it("rejects a whitespace-only quote", () => {
    expect(validateFinding(finding({ buggyCodeQuote: "   \n  " })).ok).toBe(false);
  });

  it("rejects a whitespace-only explanation", () => {
    expect(validateFinding(finding({ explanation: "\t" })).ok).toBe(false);
  });
});

describe("suggestedCode is optional, and emptiness means none", () => {
  it("defaults a missing suggestedCode to null", () => {
    const noSuggestion = finding();
    delete noSuggestion["suggestedCode"];
    const result = validateFinding(noSuggestion);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestedCode).toBeNull();
  });

  it("treats an empty string as no suggestion", () => {
    // Publishing a zero-length replacement block is worse than publishing none.
    const result = validateFinding(finding({ suggestedCode: "" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestedCode).toBeNull();
  });

  it("trims a whitespace-only suggestion to null", () => {
    const result = validateFinding(finding({ suggestedCode: "  \n " }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestedCode).toBeNull();
  });

  it("keeps a real suggestion, trimmed", () => {
    const result = validateFinding(finding({ suggestedCode: "  return values.length;  " }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestedCode).toBe("return values.length;");
  });
});

describe("length bounds are enforced", () => {
  it("rejects a quote beyond the maximum", () => {
    const result = validateFinding(finding({ buggyCodeQuote: "x".repeat(MAX_QUOTE_LENGTH + 1) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.message).toMatch(new RegExp(String(MAX_QUOTE_LENGTH)));
  });

  it("accepts a quote exactly at the maximum", () => {
    const result = validateFinding(finding({ buggyCodeQuote: "x".repeat(MAX_QUOTE_LENGTH) }));
    expect(result.ok).toBe(true);
  });

  it("rejects an explanation beyond the maximum", () => {
    expect(validateFinding(finding({ explanation: "x".repeat(MAX_EXPLANATION_LENGTH + 1) })).ok).toBe(false);
  });

  it("rejects a suggestion beyond the maximum", () => {
    expect(validateFinding(finding({ suggestedCode: "x".repeat(2001) })).ok).toBe(false);
  });

  it("rejects a path beyond the maximum", () => {
    expect(validateFinding(finding({ path: "a".repeat(MAX_PATH_LENGTH + 1) })).ok).toBe(false);
  });

  it("rejects more findings than the per-response maximum", () => {
    const many = Array.from({ length: MAX_FINDINGS_PER_RESPONSE + 1 }, () => finding());
    const result = validateFindingsResponse({ findings: many });
    expect(result.ok).toBe(false);
  });

  it("accepts exactly the maximum number of findings", () => {
    const many = Array.from({ length: MAX_FINDINGS_PER_RESPONSE }, () => finding());
    expect(validateFindingsResponse({ findings: many }).ok).toBe(true);
  });
});

describe("a malformed finding is rejected whole, not partially interpreted", () => {
  it("does not drop the bad field and keep the rest", () => {
    // Partial interpretation is how a model returning prose ends up producing a
    // confident-looking comment anchored to the wrong line.
    const result = validateFinding(finding({ severity: "high" }));
    expect(result.ok).toBe(false);
  });

  it("rejects the whole response when one finding is malformed", () => {
    const result = validateFindingsResponse({
      findings: [finding(), finding({ severity: "nope" })],
    });
    expect(result.ok).toBe(false);
  });
});

describe("unexpected keys are rejected", () => {
  // A model that returned a `lineNumber` is a model trying to place the comment
  // itself. Silently dropping the field would hide that, and the whole point of
  // the anchoring ladder is that placement is decided locally.
  it("rejects a finding carrying a line number", () => {
    const result = validateFinding(finding({ lineNumber: 42 }));
    expect(result.ok).toBe(false);
  });

  it("rejects a finding carrying an anchor", () => {
    expect(validateFinding(finding({ anchor: { line: 1, side: "RIGHT" } })).ok).toBe(false);
  });

  it("rejects a top-level summary key", () => {
    expect(validateFindingsResponse({ findings: [], summary: "looks good" }).ok).toBe(false);
  });

  it("rejects a NO_BUGS_FOUND sentinel instead of an empty array", () => {
    // The plan requires an explicit empty array. A sentinel is ambiguous.
    expect(validateFindingsResponse({ NO_BUGS_FOUND: true }).ok).toBe(false);
  });
});

describe("path hygiene", () => {
  it("rejects a path containing a newline", () => {
    // A newline in a path could break out of a fenced block in a review
    // comment and impersonate structure to whoever reads it.
    expect(validateFinding(finding({ path: "src/a.ts\nFile: src/b.ts" })).ok).toBe(false);
  });

  it("rejects a path containing a null byte", () => {
    expect(validateFinding(finding({ path: "src/a.ts\u0000" })).ok).toBe(false);
  });

  it("rejects a path with surrounding whitespace", () => {
    expect(validateFinding(finding({ path: " src/a.ts " })).ok).toBe(false);
  });

  it("accepts an ordinary path with directories", () => {
    expect(validateFinding(finding({ path: "packages/core/src/deep/module.ts" })).ok).toBe(true);
  });
});

describe("the quote is trimmed, not rejected", () => {
  it("accepts a quote wrapped in newlines", () => {
    // Models routinely wrap a quote. The trim cannot change which source text
    // matches beyond stripping the wrapper.
    const result = validateFinding(finding({ buggyCodeQuote: "\n  return x - 1;\n" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.buggyCodeQuote).toBe("return x - 1;");
  });
});

describe("all issues are reported, not just the first", () => {
  // Failing on the first problem means the repair prompt addresses one issue,
  // the model fixes it, and the next attempt trips the second — turning one
  // request into three against a 50/day budget.
  it("reports every problem in a finding", () => {
    const result = validateFinding({
      path: "",
      buggyCodeQuote: "",
      explanation: "",
      severity: "high",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThanOrEqual(4);
  });

  it("locates the offending finding by index, in JS accessor form", () => {
    // Zod 4 emits `findings.1.severity`. These paths are quoted back at the
    // model in the repair prompt, and a small model reasoning about
    // `findings[1].severity` gets there faster than one reasoning about
    // `findings.1.severity` — if it gets there at all.
    const result = validateFindingsResponse({
      findings: [finding(), finding({ severity: "high" })],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((i) => i.path === "findings[1].severity")).toBe(true);
  });
});

describe("describeSchema stays in step with the validator", () => {
  it("names every required field", () => {
    const text = describeSchema();
    for (const field of ["path", "buggyCodeQuote", "explanation", "severity", "suggestedCode"]) {
      expect(text, `describeSchema should mention ${field}`).toContain(field);
    }
  });

  it("shows one valid severity value, not the whole vocabulary", () => {
    // The example carries a single concrete value so it stays valid JSON; the
    // full vocabulary with definitions is in the system prompt's severity guide.
    // Listing all three inside the example would be invalid JSON.
    const example = JSON.parse(describeSchema()) as { findings: { severity: string }[] };
    expect(SEVERITIES).toContain(example.findings[0]?.severity);
  });

  it("is itself valid JSON, so the prompt cannot teach bad syntax", () => {
    // This caught a real defect: the description originally used bare
    // `<placeholder>` tokens, which is invalid JSON. In PROMPT_JSON mode nothing
    // enforces the shape, so a prompt that teaches invalid JSON is the most
    // expensive mistake available — every such response costs a repair request
    // out of 50/day.
    const text = describeSchema();
    const parsed = JSON.parse(text) as { findings: Record<string, unknown>[] };
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(Object.keys(parsed.findings[0] ?? {}).sort()).toEqual(
      ["buggyCodeQuote", "explanation", "path", "severity", "suggestedCode"].sort(),
    );
  });

  it("shows an example that passes the real validator", () => {
    // The strongest form of the check: the shape the prompt teaches must be
    // accepted by the schema it describes, or a compliant model is punished.
    const example = JSON.parse(describeSchema());
    expect(validateFindingsResponse(example).ok).toBe(true);
  });

});
