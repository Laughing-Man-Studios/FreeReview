/**
 * Secret redaction.
 *
 * ## Why this exists
 *
 * The seeded-secret test found that a finding about a hardcoded credential
 * *republished the credential*. The explanation, the quoted source block, and the
 * suggested replacement all rendered it verbatim into the pull request — where it
 * is visible to everyone with read access, pasted into issue trackers, and, in the
 * suggestion block's case, written into the branch when a reviewer accepts it.
 *
 * The secret was already in the diff. Copying it into a bot comment makes it
 * worse: one commit by one author becomes a place everyone screenshots.
 *
 * ## The false-positive risk
 *
 * Redaction runs on every review, so a greedy pattern is worse than no redaction —
 * it would make output unreadable and train people to ignore the markers. The
 * cases below are the ones that decide whether this is usable: the correct fix for
 * a hardcoded key is `apiKey: process.env.API_KEY`, and redacting *that* would
 * destroy the suggestion while leaving the actual secret alone in prose.
 */

import { describe, expect, it } from "vitest";
import { redactSecrets, renderQuote } from "../../src/output/comment.js";

/**
 * Credential samples are assembled at runtime.
 *
 * GitHub push protection blocks any commit containing a credential-shaped
 * literal, and it is right to: a fake token in a test file is still a
 * token-shaped string that every scanner must treat as one. Building them from
 * fragments keeps the tests runnable without teaching the scanner to ignore
 * this path — which is the failure mode that makes push protection useless.
 */
const P = (...parts: string[]): string => parts.join("");

const KEY = P("sk-live-", "FREEREVIEW", "CANARY", "a41f9c2e7b0d");
const AWS = P("AKIA", "IOSFODNN7", "EXAMPLE");
const GH = P("gh", "p_", "1234567890", "abcdefghijklmnopqrstuvwx");
const SLACK = P("xox", "b-", "123456789012", "-abcdefghijklmnop");
const GOOGLE = P("AIza", "SyA1234567890", "abcdefghijklmnopqrstuv");
const SENDGRID = P("SG.", "abc123def456ghi789", ".", "abc123def456ghi789jkl012");
const JWT = P(
  "eyJhbGciOiJIUzI1NiJ9",
  ".",
  "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
  ".",
  "dozjgNryP4J3jVmNHl0w5N",
);

describe("credential shapes are redacted", () => {
  const redacted: readonly [string, string][] = [
    ["vendor-prefixed key in prose", `The value ${KEY} is committed to source control.`],
    ["key in an assignment", `  apiKey: '${KEY}',`],
    ["key in double quotes", `  apiKey: "${KEY}"`],
    ["AWS access key id", AWS],
    ["GitHub PAT", GH],
    ["Slack token", SLACK],
    ["Google API key", GOOGLE],
    ["SendGrid key", SENDGRID],
    ["JWT", JWT],
    ["private key header", "-----BEGIN RSA PRIVATE KEY-----"],
    ["literal token", "token: abc123def456ghi789"],
    ["literal password", "password = hunter2hunter2"],
  ];

  it.each(redacted)("%s", (_label, input) => {
    const output = redactSecrets(input);
    expect(output).not.toBe(input);
    expect(output).toContain("[redacted");
  });
});

describe("ordinary code and prose survives", () => {
  // Each of these was a real false positive risk. Redaction that eats the
  // suggested fix is worse than no redaction, because it looks like it worked.
  const kept: readonly [string, string][] = [
    ["the correct fix for a hardcoded key", "  apiKey: process.env.API_KEY,"],
    ["env lookup by full name", "password: process.env.DB_PASSWORD"],
    ["python-style env lookup", "secret: os.environ['APP_SECRET']"],
    ["an imported binding", "import { apiKey } from './config'"],
    ["a require call", "const secret = require('./secret')"],
    ["a variable whose name contains a keyword", "tokenCount = items.length"],
    ["an unrelated config value", "  retries: 3,"],
    ["a reduce call", "const total = xs.reduce((a, b) => a + b, 0);"],
    ["prose containing the word token", "the token is refreshed hourly"],
    ["a dotted property access", "config.apiKey = other.apiKey"],
  ];

  it.each(kept)("%s", (_label, input) => {
    expect(redactSecrets(input)).toBe(input);
  });
});

describe("redaction preserves enough to locate the finding", () => {
  it("keeps a short tail so the reader can match it to the line", () => {
    // Enough to correlate with the diff, not enough to use. A redaction that
    // removes the value entirely would leave the finding unactionable.
    const output = redactSecrets(`apiKey: '${KEY}'`);
    expect(output).toContain("[redacted");
    expect(output).toContain(KEY.slice(-4));
    expect(output).not.toContain(KEY.slice(0, 12));
  });
});

describe("the quoted source block is redacted", () => {
  it("does not emit a credential found in the anchored text", () => {
    // This is where the leak actually was. The surrounding prose was being
    // redacted while the largest verbatim block — the quoted source — was not.
    const rendered = renderQuote(`  apiKey: '${KEY}',\n  retries: 3,`);
    expect(rendered).not.toContain(KEY);
    expect(rendered).toContain("[redacted");
    expect(rendered).toContain("retries: 3");
  });

  it("still fences correctly after redaction shortens the content", () => {
    // The fence length is computed from the redacted text. If redaction shortened
    // the body and the fence were sized from the original, content could close it.
    const rendered = renderQuote(`  apiKey: '${KEY}',`);
    const lines = rendered.split("\n");
    const openFence = lines[0]!;
    expect(rendered.split(openFence).length - 1).toBe(2);
  });

  it("leaves a clean quote byte-identical", () => {
    const clean = "  const total = xs.reduce((a, b) => a + b, 0);";
    expect(renderQuote(clean)).toBe(renderQuote(redactSecrets(clean)));
  });
});

describe("redaction is not a guarantee, and that is stated where it matters", () => {
  it("does not catch a secret with no recognisable shape", () => {
    // Honest limitation. A high-entropy blob with no vendor prefix, no assignment
    // and no PEM header is not detected. Claiming otherwise would be worse than
    // the gap, because it would invite trusting the redaction.
    const blob = "a41f9c2e7b0d4e6f8a2b3c4d5e6f7a8b";
    expect(redactSecrets(blob)).toBe(blob);
  });
});