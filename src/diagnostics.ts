/**
 * Machine-readable diagnostic codes and the structured logger.
 *
 * Every decision this action makes that a human might want to audit ends up as
 * exactly one of these codes. The split that matters:
 *
 *   - `expected`  the reviewer did its job correctly and there is simply nothing
 *                 to say (unsupported PR, oversized PR, no findings, quota
 *                 exhausted). The workflow stays GREEN.
 *   - `failure`   the action or its configuration is broken. Exit 1.
 *
 * Finding severity never influences the exit code. A `critical` finding and an
 * empty review are both a successful run.
 */

export const DIAGNOSTIC_CODES = [
  // --- eligibility -------------------------------------------------------
  "UNSUPPORTED_PR_SOURCE",
  "PUBLIC_REPOSITORY",
  "DRAFT_PR",
  "PR_CLOSED",
  "PR_ALREADY_MERGED",
  "UNSUPPORTED_EVENT",
  "INVALID_GITHUB_CONTEXT",
  "CONFIG_INVALID",
  "MISSING_CREDENTIALS",

  // --- diff acquisition --------------------------------------------------
  "DIFF_FETCH_FAILED",
  "DIFF_PARSE_FAILED",
  "DIFF_TRUNCATED",

  // --- size / budget gating ----------------------------------------------
  "PR_TOO_LARGE",
  "CONTEXT_TOO_LARGE",
  "NO_REVIEWABLE_FILES",

  // --- upstream ----------------------------------------------------------
  "OPENROUTER_QUOTA_EXHAUSTED",
  "OPENROUTER_RATE_LIMITED",
  "OPENROUTER_UNAVAILABLE",
  "OPENROUTER_AUTH_FAILED",
  "NO_ELIGIBLE_MODEL",
  "NO_ELIGIBLE_PROVIDER",
  "REQUEST_BUDGET_EXHAUSTED",
  "RATE_LIMIT_BUDGET_THROTTLED",
  "REQUEST_CANCELLED",

  // --- model output ------------------------------------------------------
  "MODEL_OUTPUT_INVALID",
  "MODEL_OUTPUT_EMPTY_RETRYABLE",
  "MODEL_OUTPUT_TRUNCATED",
  "MODEL_OUTPUT_TOO_LARGE",
  "FINDING_COUNT_EXCEEDED",

  // --- validation / anchoring --------------------------------------------
  "ANCHOR_NOT_FOUND",
  "ANCHOR_AMBIGUOUS",
  "ANCHOR_RANGE_INVALID",
  "ANCHOR_SIDE_MISMATCH",
  "ANCHOR_CONTEXT_ONLY",
  "ANCHOR_QUOTE_MALFORMED",
  "PATH_NOT_IN_PR",
  "INJECTION_COMPLIANCE_SUSPECTED",
  "DUPLICATE_FINDING_SUPPRESSED",
  "SUGGESTION_REJECTED",

  // --- publication -------------------------------------------------------
  "STALE_HEAD_SHA",
  "HEAD_CHANGED_MID_RUN",
  "GITHUB_PUBLISH_FAILED",
  "GITHUB_PUBLISH_DEGRADED",
  "INTERNAL_ERROR",
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

/**
 * Codes that mean "the action or its configuration is broken".
 *
 * Everything not listed here is an expected outcome and exits 0. This set is
 * the single place the advisory/non-blocking policy is encoded.
 */
export const ACTION_FAILURE_CODES: ReadonlySet<DiagnosticCode> = new Set<DiagnosticCode>([
  "CONFIG_INVALID",
  "MISSING_CREDENTIALS",
  "INVALID_GITHUB_CONTEXT",
  "DIFF_PARSE_FAILED",
  "OPENROUTER_AUTH_FAILED",
  "INTERNAL_ERROR",
]);

export type DiagnosticSeverity = "expected" | "failure";

export function severityOf(code: DiagnosticCode): DiagnosticSeverity {
  return ACTION_FAILURE_CODES.has(code) ? "failure" : "expected";
}

export interface Diagnostic {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  /** Structured, non-source-bearing context. Never include file contents. */
  context?: Record<string, string | number | boolean | undefined>;
}

export function diagnostic(
  code: DiagnosticCode,
  message: string,
  context?: Diagnostic["context"],
): Diagnostic {
  return { code, severity: severityOf(code), message, ...(context ? { context } : {}) };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * GitHub Actions command escaping. User/model-controlled text can contain
 * `%`, `\r` or `\n`; unescaped, `%0A` in a message injects a fake log line and
 * `::error::` in a message injects a fake workflow command.
 */
function escapeForLog(value: string): string {
  return value
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

function formatDiagnostic(d: Diagnostic): string {
  const parts = [`[${d.code}]`, d.message];
  if (d.context) {
    const rendered = Object.entries(d.context)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${String(v)}`);
    if (rendered.length > 0) parts.push(`(${rendered.join(" ")})`);
  }
  return parts.join(" ");
}

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  /** Emits a GitHub `::error::` annotation. */
  error(message: string, fields?: Record<string, unknown>): void;
  /** Emits a GitHub `::warning::` annotation. */
  annotation(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  record(d: Diagnostic): void;
  /** Records a diagnostic and returns it, for inline use. */
  log(code: DiagnosticCode, message: string, context?: Diagnostic["context"]): Diagnostic;
  readonly diagnostics: readonly Diagnostic[];
  /** Counts by code, for the step summary. */
  counts(): Record<string, number>;
}

const SECRET_PATTERNS: readonly RegExp[] = [
  // OpenAI / OpenRouter style
  /sk-[A-Za-z0-9_-]{16,}/g,
  // GitHub tokens
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  // AWS access key ids
  /AKIA[0-9A-Z]{16}/g,
  // Google API keys
  /AIza[0-9A-Za-z_-]{30,}/g,
  // Slack
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  // GitLab
  /glpat-[A-Za-z0-9_-]{16,}/g,
];

/**
 * Defence in depth for the log-redaction requirement: even though the action is
 * designed never to print a secret, any string that reaches a log line or a
 * published comment passes through here first.
 */
export function redactSecrets(value: string): string {
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

/**
 * Render a log field value to a single-line string.
 *
 * Explicit rather than `String(value)`: `String()` on an object yields
 * "[object Object]", and on a symbol it throws.
 */
function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value) ?? "[unserialisable]";
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return value.toString();
  return "";
}

function sanitize(fields: Record<string, unknown> | undefined): Record<string, string> {
  if (!fields) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[key] = redactSecrets(renderValue(value));
  }
  return out;
}

function formatLine(
  level: string,
  message: string,
  fields?: Record<string, unknown>,
): string {
  const safe = redactSecrets(message);
  const extras = sanitize(fields);
  const rendered = Object.entries(extras)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  return rendered ? `${level} ${safe} ${rendered}` : `${level} ${safe}`;
}

/** Only the leading line of a multi-line value is emitted at each level. */
function firstLine(value: string): string {
  const line = value.split("\n", 1)[0] ?? value;
  return line.length > 400 ? `${line.slice(0, 400)}…` : line;
}

export function createLogger(opts?: { debug?: boolean }): Logger {
  const debugEnabled = opts?.debug ?? process.env["RUNNER_DEBUG"] === "1";
  const diagnostics: Diagnostic[] = [];

  const emit = (level: string, command: string, message: string, fields?: Record<string, unknown>) => {
    const line = formatLine(level, message, fields);
    if (command) {
      // GitHub command escaping applies to the whole annotated line.
      process.stdout.write(`${command}::${escapeForLog(line)}\n`);
    } else {
      process.stdout.write(`${escapeForLog(line)}\n`);
    }
  };

  const logger: Logger = {
    info: (message, fields) => emit("info", "", message, fields),
    warn: (message, fields) => emit("warn", "", message, fields),
    error: (message, fields) => emit("error", "::error", firstLine(message), fields),
    annotation: (message, fields) => emit("warning", "::warning", firstLine(message), fields),
    debug: (message, fields) => {
      if (debugEnabled) emit("debug", "", message, fields);
    },
    record: (d) => {
      diagnostics.push(d);
      emit(d.severity === "failure" ? "error" : "warning", "", formatDiagnostic(d));
    },
    log: (code, message, context) => {
      const d = diagnostic(code, message, context);
      logger.record(d);
      return d;
    },
    get diagnostics() {
      return diagnostics;
    },
    counts: () => {
      const out: Record<string, number> = {};
      for (const d of diagnostics) out[d.code] = (out[d.code] ?? 0) + 1;
      return out;
    },
  };

  return logger;
}
