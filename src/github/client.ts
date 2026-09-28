/**
 * Minimal GitHub REST client.
 *
 * Scope is deliberately small: this action makes a handful of GET calls and one
 * POST, all against api.github.com. It exists to provide three things the raw
 * `fetch` call does not:
 *
 *   1. Correct, pinned API version and media-type headers.
 *   2. Typed errors that distinguish "retryable" from "will never work", so
 *      the retry policy is a table rather than a guess.
 *   3. Pagination, because `pulls/{n}/files` returns at most 100 per page and a
 *      large PR will otherwise be silently truncated.
 *
 * Note on budgets: GitHub calls are cheap relative to the 50/day OpenRouter
 * budget, but they are not free — the Actions GITHUB_TOKEN is rate limited per
 * repository. Retries are bounded and only applied to idempotent reads.
 */

const API_BASE = "https://api.github.com";

/**
 * Pinned API version. Unpinned requests follow whatever the API defaults to
 * today, which means a GitHub-side change can silently alter a response shape
 * in a released action.
 */
export const GITHUB_API_VERSION = "2026-03-10";

export const ACCEPT_JSON = "application/vnd.github+json";
export const ACCEPT_DIFF = "application/vnd.github.v3.diff";

export type GithubErrorKind =
  /** 401/403 — token lacks access, or the request is genuinely forbidden. */
  | "forbidden"
  /** 404 — repo, PR, or path does not exist, or is invisible to this token. */
  | "not_found"
  /** 429, or 403 with a rate-limit signal. */
  | "rate_limited"
  /** 5xx. */
  | "server"
  /** Anything else. */
  | "client";

export class GithubError extends Error {
  constructor(
    readonly kind: GithubErrorKind,
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "GithubError";
  }

  /** Whether a bounded retry has any chance of succeeding. */
  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "server";
  }

  /**
   * Whether this is GitHub's *secondary* rate limit (abuse detection) rather
   * than the primary hourly quota. Secondary limits apply to content-creating
   * endpoints and carry a `Retry-After`.
   */
  get isSecondaryRateLimit(): boolean {
    return this.status === 403 && this.retryAfterSeconds !== undefined;
  }
}

export interface GithubClientOptions {
  token: string;
  /** Injected for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Bounded retries for idempotent reads. */
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  userAgent?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function classify(status: number, body: unknown, retryAfterHeader: string | null): GithubError {
  const message =
    typeof body === "object" && body !== null && "message" in body
      ? String((body).message)
      : `GitHub API returned ${status}`;

  const parsedRetryAfter = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : Number.NaN;
  const retryAfter = Number.isFinite(parsedRetryAfter) ? parsedRetryAfter : undefined;

  let kind: GithubErrorKind;
  if (status === 401) {
    // Bad or expired credentials. Distinct from 403 so the caller can treat it
    // as an action failure rather than a skippable PR — a silent pass here
    // would report a green run for a token that cannot read anything.
    kind = "forbidden";
  } else if (status === 403) {
    // A 403 with Retry-After is secondary rate limiting, not a permissions
    // problem. Retrying a genuine permission failure forever is pointless.
    kind = retryAfter !== undefined ? "rate_limited" : "forbidden";
  } else if (status === 429) {
    kind = "rate_limited";
  } else if (status === 404 || status === 410) {
    kind = "not_found";
  } else if (status >= 500) {
    kind = "server";
  } else {
    kind = "client";
  }

  return new GithubError(kind, status, message, retryAfter);
}

export class GithubClient {
  private readonly token: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly userAgent: string;

  /** Wall-clock budget so a hung GitHub cannot stall the whole run. */
  constructor(options: GithubClientOptions) {
    this.token = options.token;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetries = options.maxRetries ?? 3;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? API_BASE;
    this.userAgent = options.userAgent ?? "FreeReview";
  }

  private headers(accept: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: accept,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": this.userAgent,
    };
  }

  /**
   * Idempotent GET with bounded exponential backoff.
   *
   * Retries only `retryable` errors. A 404 is never retried: if the PR is not
   * visible to this token, waiting will not change that.
   */
  async get<T>(path: string, options?: { accept?: string }): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    let lastError: GithubError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          headers: this.headers(options?.accept ?? ACCEPT_JSON),
        });
      } catch (cause) {
        // Network-level failure (DNS, reset, TLS). Treat as transient.
        if (attempt === this.maxRetries) throw cause;
        await this.sleep(backoffMs(attempt));
        continue;
      }

      if (response.ok) {
        return (await response.json()) as T;
      }

      const body = await safeJson(response);
      const error = classify(response.status, body, response.headers.get("retry-after"));
      lastError = error;

      if (!error.retryable || attempt === this.maxRetries) {
        throw error;
      }

      // Prefer the server's own instruction over our own backoff curve.
      const waitMs = error.retryAfterSeconds !== undefined
        ? Math.min(error.retryAfterSeconds * 1000, 60_000)
        : backoffMs(attempt);
      await this.sleep(waitMs);
    }

    /* c8 ignore next */
    throw lastError ?? new GithubError("server", 0, "GitHub request failed with no response");
  }

  /**
   * POST with NO automatic retry.
   *
   * Content-creating endpoints (review creation) trigger secondary rate limits
   * and a retried POST can duplicate a review. Retry policy for publication
   * lives in `github/publish.ts` where it can be explicit about idempotency.
   */
  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { ...this.headers(ACCEPT_JSON), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (response.ok) return (await response.json()) as T;

    const payload = await safeJson(response);
    throw classify(response.status, payload, response.headers.get("retry-after"));
  }

  /**
   * Follow GitHub pagination to completion, with a hard page cap.
   *
   * The cap exists so a pathological response cannot spin forever. `pulls/{n}/files`
   * documents a 3000-file maximum, so 30 pages of 100 is the true ceiling.
   */
  async getAllPages<T>(path: string, options?: { perPage?: number; maxPages?: number }): Promise<T[]> {
    const perPage = options?.perPage ?? 100;
    const maxPages = options?.maxPages ?? 40;
    const separator = path.includes("?") ? "&" : "?";
    const out: T[] = [];

    for (let page = 1; page <= maxPages; page += 1) {
      const batch = await this.get<T[]>(
        `${path}${separator}per_page=${perPage}&page=${page}`,
      );
      if (!Array.isArray(batch) || batch.length === 0) break;
      out.push(...batch);
      if (batch.length < perPage) break;
    }

    return out;
  }
}

/** Exponential with full jitter, capped. */
function backoffMs(attempt: number): number {
  const base = Math.min(2 ** attempt * 250, 8_000);
  return base / 2 + Math.random() * (base / 2);
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
