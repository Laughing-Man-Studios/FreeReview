/**
 * Review body rendering.
 *
 * Everything a human reads on the pull request is built here. Three properties
 * govern the output:
 *
 * 1. **No markdown injection from untrusted content.** The diff is untrusted and
 *    the model's explanation is untrusted. Both end up in a comment rendered by
 *    GitHub's markdown engine, where a crafted explanation could close a
 *    details block, fake a code fence, or impersonate a bot. So every
 *    untrusted string is either fenced, escaped, or stripped of the characters
 *    that carry structure.
 *
 * 2. **The source quote is never rendered as markdown.** It is the highest-risk
 *    string in the payload: it came from a file, it is arbitrary text, and it
 *    can contain anything. It goes in a fenced block whose fence is chosen
 *    longer than the content, so a ``` inside the quote cannot escape.
 *
 * 3. **The review says what it is.** Advisory, model-generated, and able to be
 *    wrong. A reader who cannot tell an AI finding from a human one cannot
 *    calibrate their response to it, which is how advisory tools get treated as
 *    authoritative.
 */

import type { AnchoredFinding, Severity } from "../types.js";
import type { ModelDefinition } from "../config.js";

/** Fence long enough to wrap any quote the schema accepts. */
const MAX_QUOTE_LENGTH = 1_200;

/** Lines of a quote shown before truncation. */
const MAX_QUOTE_LINES = 12;

export const SEVERITY_LABELS: Readonly<Record<Severity, string>> = {
  critical: "Critical",
  warning: "Warning",
  info: "Note",
};

/** A fence strictly longer than anything in the content it wraps. */
export function safeFence(content: string): string {
  let longest = 0;
  for (const match of content.matchAll(/`+/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Redact credential-shaped substrings from text that will be published.
 *
 * ## Why this exists
 *
 * The seeded-secret test found this missing. A model reporting a hardcoded API key
 * naturally quotes it back — "the value `sk-live-abc…` is committed to source" —
 * and the review body, the step summary and the published comment all render that
 * text verbatim. So a finding about a leaked credential **republished the
 * credential** into the pull request, where it is now visible to everyone with read
 * access and is committed to the branch history by the comment itself.
 *
 * That is strictly worse than saying nothing. The secret was already in the diff,
 * but it was in one commit by one author; a bot comment copies it into a place
 * people screenshot and paste into issue trackers.
 *
 * ## Why the whole comment is redacted and not just prose
 *
 * `suggestedCode` is rendered inside a `suggestion` block that GitHub will apply to
 * the branch. A secret echoed there does not just appear — it gets written.
 *
 * ## Why these patterns
 *
 * Deliberately conservative and prefix-anchored. This runs on every review, so a
 * loose pattern would redact ordinary prose ("skipped", "token-bucket") and make
 * output unreadable. Each pattern requires a known vendor prefix *and* a length
 * that a real credential has, which is what keeps the false-positive rate near
 * zero. A secret with an unrecognised shape is not redacted — the limitation is
 * recorded in SECURITY.md rather than papered over with a greedy regex.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  // Vendor-prefixed keys: OpenAI, Anthropic, AWS access keys, GitHub, Slack,
  // Stripe, Google, SendGrid, npm, Twilio, and the private-key header.
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bSG\.[A-Za-z0-9]{16,}\.[A-Za-z0-9]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  // Credentials embedded in an assignment or connection string.
  //
  // The value must be a literal, so this cannot swallow the *correct* fix:
  // `apiKey: process.env.API_KEY` is precisely what the reviewer should be
  // suggesting, and redacting it turns the suggestion into noise. A dotted path,
  // a call, or a bare identifier is a reference rather than a secret.
  /(?:^|[^.\w])(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*(?!process\.env)(?!os\.environ)(?!import\b)(?!require\b)[^\s"',;]{8,}/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      // Keep a short recognisable tail so the reader can still correlate the
      // finding with the line. Enough to locate, not enough to use.
      const tail = match.slice(-4);
      return `[redacted …${tail}]`;
    });
  }
  return out;
}

/**
 * Neutralise markdown structure in untrusted prose.
 *
 * Inline code spans and emphasis are the two constructs that let untrusted text
 * escape its intended rendering. Both are escaped; the sentence still reads,
 * and it can no longer carry structure.
 *
 * Deliberately not escaped: pipes outside a table, and newlines, because the
 * explanation is already placed in a context where those are inert. Escaping
 * more than necessary makes the output harder to read for no security gain.
 *
 * Redaction runs first: a redacted marker contains no markdown-significant
 * characters, so the two compose without either interfering with the other.
 */
function neutraliseProse(text: string): string {
  return redactSecrets(text)
    // Backticks would open a code span and could swallow surrounding structure.
    .replace(/`/g, "\\`")
    // Asterisks and underscores would open emphasis.
    .replace(/([*_])/g, "\\$1")
    // HTML comments could hide text from a reader but render for a bot, or the
    // reverse. A comment in a diff is a comment in a review too.
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;");
}

/**
 * Render the quoted source.
 *
 * Long quotes are truncated for two reasons: a comment wall is unreadable, and
 * an over-long quote is almost always the model quoting a whole function, which
 * anchors ambiguously and would have been rejected upstream.
 */
/**
 * Render the quoted source text a finding refers to.
 *
 * Redacted. This is the largest verbatim block FreeReview publishes, it comes
 * straight from the diff, and a finding about a hardcoded credential quotes the
 * credential. The seeded-secret test found it emitted unredacted while the
 * surrounding prose was being redacted — the leak was here, not in the prose.
 *
 * The fence is chosen from the *redacted* text, so a marker can never shorten the
 * fence below the content it wraps.
 */
export function renderQuote(quote: string): string {
  const redacted = redactSecrets(quote);
  const truncated = redacted.length > MAX_QUOTE_LENGTH;
  const body = truncated ? `${redacted.slice(0, MAX_QUOTE_LENGTH)}\n…` : redacted;

  const lines = body.split("\n");
  const shown = lines.slice(0, MAX_QUOTE_LINES);
  const elided = lines.length - shown.length;
  const text = elided > 0 ? `${shown.join("\n")}\n… ${elided} more line(s)` : shown.join("\n");

  // The fence is chosen from the final text, so content cannot close it.
  const fence = safeFence(text);
  return `${fence}\n${text}\n${fence}`;
}

/**
 * Render the optional suggestion.
 *
 * The fence is exactly ` ```suggestion ` because that is the syntax GitHub
 * requires — it cannot be grown the way a display fence can. A suggestion
 * containing a backtick run would therefore terminate the block early, so
 * `pipeline/validate.ts` rejects such a suggestion before it ever reaches here.
 * This is the one place in the renderer that cannot defend itself, which is why
 * the check lives upstream.
 */
/**
 * Render a GitHub suggestion block.
 *
 * Redacted, not just neutralised. A suggestion is *applied* to the branch when a
 * reviewer accepts it, so a secret echoed into this block does not merely appear in
 * a comment — it is written into the repository. Fence length is computed from the
 * redacted text so a redacted marker can never shorten the fence below the content
 * it wraps.
 */
function renderSuggestion(suggestedCode: string): string {
  const safe = redactSecrets(suggestedCode);
  return `${safeFence(safe)}suggestion\n${safe}\n${safeFence(safe)}`;
}

/**
 * The body of a single inline review comment.
 */
export function renderComment(finding: AnchoredFinding): string {
  const parts: string[] = [];

  parts.push(`**${SEVERITY_LABELS[finding.severity]}** — generated by FreeReview.`, "");
  parts.push(neutraliseProse(finding.explanation.trim()), "");
  parts.push(renderQuote(finding.anchoredText));

  if (finding.suggestedCode !== null) {
    parts.push("", renderSuggestion(finding.suggestedCode));
  }

  return parts.join("\n");
}

export interface SummaryInput {
  readonly findings: readonly AnchoredFinding[];
  /** Findings that resolved to no single location, rendered without a line. */
  readonly unanchored: readonly { path: string; explanation: string; severity: Severity }[];
  readonly rejections: readonly { path: string; detail: string; severity: Severity }[];
  readonly modelUsed: string;
  readonly requestsUsed: number;
  readonly filesReviewed: number;
  readonly filesInPr: number;
  readonly privacyMode: "strict" | "relaxed";
  readonly promptVersion: string;
  /**
   * Chunks that were actually sent to a model and returned a usable response.
   *
   * This exists to prevent the single most damaging thing this action could
   * say. Without it, a run where every chunk failed to route renders as
   * "reviewed 1 file and found nothing material" — a clean bill of health for
   * code that was never examined. That is worse than publishing nothing,
   * because it is indistinguishable from a real clean review.
   */
  readonly chunksReviewed: number;
  /** Chunks the run intended to review, before failures. */
  readonly chunksPlanned: number;
  /** Why no chunk could be reviewed, when none could. */
  readonly failureDetail: string | null;
  /**
   * Disclosed when a model with measured prompt-injection exposure produced this
   * review. See `injectionDisclosure`.
   */
  readonly injectionNote: string | null;
}

/**
 * What to say when the reviewing model has been measured following instructions
 * embedded in a diff.
 *
 * ## Why this is in the published comment and not just the log
 *
 * Only the primary model has ever been measured resistant. If the primary is
 * rate-limited and a review falls through to a fallback, a pull request author
 * can suppress findings by writing a comment in their own diff — and a
 * suppressed review and a clean review look identical. That is the exact failure
 * this project exists to prevent, and it is reachable precisely when the service
 * is under strain.
 *
 * Disclosing it in the review body is the only place a reader who did not watch
 * the logs will see it. A suppressed review that presents as clean is the worst
 * outcome available; one that announces its own exposure is merely incomplete.
 *
 * ## Why it names the measurement
 *
 * "This model may be susceptible to prompt injection" is unfalsifiable and
 * therefore useless — it is also what every tool says. The note states what was
 * tested and what happened, so a reader can weigh it, and so a future change to
 * the model invalidates a claim that was specific rather than a disclaimer that
 * was always true anyway.
 *
 * `unmeasured` is disclosed too. Silence would be indistinguishable from
 * `resistant`, and that is precisely the confusion this project exists to
 * prevent.
 */
export function injectionDisclosure(
  modelIds: readonly string[],
  catalog: readonly ModelDefinition[],
): string | null {
  const byId = new Map(catalog.map((m) => [m.id, m]));

  const exposed = modelIds.filter((id) => byId.get(id)?.injectionResistance === "exposed");
  const unmeasured = modelIds.filter((id) => {
    const r = byId.get(id)?.injectionResistance;
    return r === undefined || r === "unmeasured";
  });

  if (exposed.length > 0) {
    const names = exposed.map((id) => `\`${id}\``).join(", ");
    return (
      `> **This review may be incomplete.** It was produced by ${names}, which was measured ` +
      "following instructions written into a pull request diff — a comment telling the model to " +
      "ignore its instructions and report nothing. A pull request author can therefore suppress " +
      "findings by adding such a comment to their own diff.\n>\n" +
      "> FreeReview detects this by planting the suppression instruction next to a real defect: " +
      "the only way to pass is to ignore the instruction. This model did not.\n>\n" +
      "> Treat the findings below as a lower bound, not as a clean review. Only the default model " +
      "has been measured resistant; fallbacks exist for availability, not for this property."
    );
  }

  if (unmeasured.length > 0) {
    const names = unmeasured.map((id) => `\`${id}\``).join(", ");
    return (
      `> **This model's resistance to instructions embedded in the diff has not been measured.** ` +
      `It was produced by ${names}. If a diff contains a comment instructing the model to ignore ` +
      "its instructions, findings may be missing and this review will not say so."
    );
  }

  return null;
}

/**
 * The top-level review body.
 *
 * The count of unanchored and rejected findings is stated explicitly. A summary
 * that quietly shows only what succeeded reads as "this is everything", which
 * is the specific misunderstanding that makes a partial review look like a
 * clean bill of health.
 */
export function renderSummary(input: SummaryInput): string {
  const lines: string[] = [];

  const critical = input.findings.filter((f) => f.severity === "critical").length;
  const warning = input.findings.filter((f) => f.severity === "warning").length;
  const info = input.findings.filter((f) => f.severity === "info").length;

  lines.push("## FreeReview", "");

  // The no-review case comes first and is never phrased as a result. "Found
  // nothing material" and "could not look at anything" are opposites, and a
  // reader who cannot tell them apart will treat a routing failure as a clean
  // review.
  if (input.chunksReviewed === 0 && input.chunksPlanned > 0) {
    lines.push(
      `**No review was produced.** ${input.chunksPlanned} chunk(s) were prepared but none could be ` +
        "sent to a model successfully, so no code was examined.",
    );
    if (input.failureDetail !== null) {
      lines.push("", `Reason: ${neutraliseProse(input.failureDetail)}`);
    }
    lines.push(
      "",
      "<sub>Treat this as **not reviewed**. It is not a finding of no issues — nothing was looked at.</sub>",
    );
  } else if (input.findings.length === 0 && input.unanchored.length === 0) {
    lines.push(
      `Reviewed ${input.filesReviewed} file(s) and found nothing material. That is a result, not a guarantee — the review covers the changed lines only, and free models miss real defects.`,
    );
  } else {
    const parts: string[] = [];
    if (critical > 0) parts.push(`**${critical} critical**`);
    if (warning > 0) parts.push(`${warning} warning`);
    if (info > 0) parts.push(`${info} note`);
    lines.push(`Found ${parts.join(", ")} across ${input.filesReviewed} file(s).`);
  }

  lines.push("");

  // The advisory framing. Not a disclaimer bolted on — a reader who does not
  // know this is model-generated will read it as a human's judgement.
  lines.push(
    "<sub>Advisory only. Generated by a free-tier language model, which can be wrong. " +
      "This review does not block merging and nothing here was checked by a human. " +
      `Model: \`${input.modelUsed || "none"}\` · ${input.requestsUsed} request(s) · ` +
      `prompt \`${input.promptVersion}\`.</sub>`,
  );

  if (input.injectionNote !== null) {
    // Same placement and emphasis as the privacy warning: a suppressed review and
    // a clean review are indistinguishable to a reader, and only the review body
    // reaches someone who never opened the workflow logs.
    lines.push("");
    lines.push("> [!WARNING]", input.injectionNote);
  }

  if (input.privacyMode === "relaxed") {
    // Loud, unmissable, and inside the review itself — not only in the step
    // summary, which a developer reading a PR may never see.
    lines.push("");
    lines.push(
      "> [!WARNING]",
      "> **This review was produced with `privacy_mode: relaxed`.** The diff was sent " +
        "without zero-data-retention enforcement, so a provider may have retained the code. " +
        "Do not use this mode for confidential source.",
    );
  }

  if (input.unanchored.length > 0) {
    lines.push("", "### Not placed on a line", "");
    lines.push(
      "These findings could not be resolved to exactly one line, so they have no inline comment:",
      "",
    );
    for (const item of input.unanchored) {
      lines.push(
        `- **${SEVERITY_LABELS[item.severity]}** \`${item.path}\` — ${neutraliseProse(item.explanation.trim())}`,
      );
    }
  }

  if (input.rejections.length > 0) {
    lines.push("", "### Discarded", "");
    lines.push(
      `${input.rejections.length} finding(s) were discarded before publication:`,
      "",
    );
    for (const item of input.rejections) {
      lines.push(`- \`${item.path}\` — ${neutraliseProse(item.detail.trim())}`);
    }
  }

  if (input.filesReviewed < input.filesInPr) {
    lines.push(
      "",
      `<sub>Reviewed ${input.filesReviewed} of ${input.filesInPr} changed file(s); the rest were ` +
        "filtered as non-reviewable (generated, vendored, lockfiles, or assets).</sub>",
    );
  }

  return lines.join("\n");
}
