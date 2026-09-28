/**
 * Review publication.
 *
 * One `POST /pulls/{n}/reviews` with `event: COMMENT` and an array of inline
 * comments. Never `APPROVE`, never `REQUEST_CHANGES`. The action has no
 * authority over merging and the code path that could use it does not exist.
 *
 * ## Why one review rather than N+1 requests
 *
 * A review with inline comments is a single atomic submission. Posting each
 * comment separately would mean a partial review if request 4 of 9 failed, and
 * a PR carrying some findings and not others is indistinguishable from a
 * complete review that found only those. The single call is both cheaper and
 * more honest about what happened.
 *
 * ## The 422 problem
 *
 * GitHub rejects a review with `422 Unprocessable Entity` when any inline
 * comment references a line it will not accept: a line outside the diff, a
 * `line`/`side` pair that does not exist, or a start/end range spanning a hunk
 * boundary. A single bad comment fails the *entire* review.
 *
 * That is a bad failure mode for an advisory tool: one unanchored finding
 * suppresses every good one. The mitigation is binary search — on a 422, drop
 * half the comments and retry, until the offending comment is isolated or the
 * set is known good. Each retry costs an API call but not a quota request, and
 * the run degrades to publishing the majority of findings rather than none.
 */

import { GithubError, type GithubClient } from "./client.js";

/**
 * The reviews path, relative to the client's base URL.
 *
 * `GithubClient` already prepends its base, so passing an absolute URL here
 * would produce `https://api.github.comhttps://api.github.com/...`.
 */
export const REVIEWS_PATH = "/repos/{owner}/{repo}/pulls/{number}/reviews";

export interface InlineComment {
  readonly path: string;
  readonly body: string;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
  readonly startLine?: number;
  readonly startSide?: "LEFT" | "RIGHT";
}

export interface PublishInput {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  /** The commit reviewed. GitHub anchors comments to this SHA's diff. */
  readonly commitId: string;
  readonly body: string;
  readonly comments: readonly InlineComment[];
}

export interface PublishResult {
  readonly ok: boolean;
  readonly reviewId: number | null;
  readonly reviewUrl: string | null;
  /** Comments that could not be published, isolated by the binary search. */
  readonly dropped: readonly InlineComment[];
  readonly degraded: boolean;
  readonly detail: string | null;
}

/** The payload shape GitHub documents for creating a review. */
export function buildReviewPayload(input: PublishInput, comments: readonly InlineComment[]): Record<string, unknown> {
  return {
    // COMMENT is the only event this action may ever send. There is no code path
    // that produces APPROVE or REQUEST_CHANGES.
    commit_id: input.commitId,
    body: input.body,
    event: "COMMENT",
    comments: comments.map((c) => ({
      path: c.path,
      body: c.body,
      line: c.line,
      side: c.side,
      ...(c.startLine !== undefined
        ? { start_line: c.startLine, start_side: c.startSide ?? c.side }
        : {}),
    })),
  };
}

interface RawReview {
  id?: number;
  html_url?: string;
}

/**
 * POST the review. Returns the parsed review on success; throws `GithubError`
 * with the original status so the caller can distinguish 422 (bad comment) from
 * 403 (no permission) and handle each differently.
 */
async function postReview(
  client: GithubClient,
  input: PublishInput,
  comments: readonly InlineComment[],
): Promise<RawReview> {
  const path = REVIEWS_PATH.replace("{owner}", input.owner)
    .replace("{repo}", input.repo)
    .replace("{number}", String(input.pullNumber));

  const response = await client.post(path, buildReviewPayload(input, comments));
  return response as RawReview;
}

/**
 * Ceiling on publication attempts.
 *
 * A pathological case — GitHub rejecting most comments — would otherwise
 * generate O(n log n) API calls, each of which can trip a secondary rate limit
 * and take the review down with it. Reaching the cap degrades to publishing
 * whatever succeeded so far, which is still better than nothing.
 */
const MAX_PUBLISH_ATTEMPTS = 24;

interface PublishAttempt {
  readonly ok: boolean;
  readonly reviewId: number | null;
  readonly reviewUrl: string | null;
  readonly published: readonly InlineComment[];
  readonly dropped: readonly InlineComment[];
  readonly detail: string | null;
}

/**
 * Recursively split a set until every acceptable comment has been published.
 *
 * A 422 means *at least one* comment in the set is unacceptable, and nothing
 * about which. So the set is halved and each half is attempted independently.
 *
 * The important property is that **both halves are retried**, not just the first.
 * An earlier version kept the first half and discarded the rest, which meant a
 * single bad comment silently suppressed every comment after it — the exact
 * "nothing found" illusion this function exists to prevent, just caused by a
 * bug in the recovery path instead of by a rejection.
 *
 * Recursion depth is log2(n), so a single bad comment among n costs about
 * log2(n) extra calls, not n.
 */
async function publishSet(
  client: GithubClient,
  input: PublishInput,
  comments: readonly InlineComment[],
  state: { attempts: number; published: InlineComment[]; dropped: InlineComment[]; detail: string | null },
  lastReview: { id: number | null; url: string | null },
): Promise<PublishAttempt> {
  if (comments.length === 0) {
    return { ok: true, reviewId: lastReview.id, reviewUrl: lastReview.url, published: [], dropped: [], detail: null };
  }

  if (state.attempts >= MAX_PUBLISH_ATTEMPTS) {
    state.dropped.push(...comments);
    state.detail = `Stopped isolating rejected comments after ${MAX_PUBLISH_ATTEMPTS} attempts.`;
    return { ok: true, reviewId: lastReview.id, reviewUrl: lastReview.url, published: [], dropped: [], detail: state.detail };
  }

  state.attempts += 1;

  try {
    const review = await postReview(client, input, comments);
    state.published.push(...comments);
    return {
      ok: true,
      reviewId: review.id ?? null,
      reviewUrl: review.html_url ?? null,
      published: comments,
      dropped: [],
      detail: null,
    };
  } catch (error) {
    if (!(error instanceof GithubError)) throw error;

    // Only a 422 is attributable to a specific comment. A 403 is a permissions
    // problem and a 5xx is transient; bisecting on either would burn API calls
    // narrowing a failure that has nothing to do with any one comment.
    if (error.status !== 422 || comments.length <= 1) {
      if (comments.length === 1) {
        // A lone rejected comment is isolated. Keep going with the rest.
        state.dropped.push(comments[0] as InlineComment);
        state.detail = `GitHub rejected ${state.dropped.length} inline comment(s); the rest are published.`;
        return { ok: true, reviewId: lastReview.id, reviewUrl: lastReview.url, published: [], dropped: comments, detail: state.detail };
      }
      return {
        ok: false,
        reviewId: lastReview.id,
        reviewUrl: lastReview.url,
        published: [],
        dropped: comments,
        detail: `GitHub rejected the review: ${error.message}`,
      };
    }

    const half = Math.floor(comments.length / 2);
    const first = await publishSet(client, input, comments.slice(0, half), state, lastReview);
    if (!first.ok) return first;

    const second = await publishSet(client, input, comments.slice(half), state, {
      id: first.reviewId ?? lastReview.id,
      url: first.reviewUrl ?? lastReview.url,
    });

    return {
      ok: second.ok,
      reviewId: second.reviewId ?? first.reviewId,
      reviewUrl: second.reviewUrl ?? first.reviewUrl,
      published: [...first.published, ...second.published],
      dropped: [...first.dropped, ...second.dropped],
      detail: second.detail ?? first.detail ?? state.detail,
    };
  }
}

/**
 * Publish a review, isolating comments GitHub will not accept.
 *
 * The alternative — dropping all comments and publishing the summary alone —
 * would mean one unanchorable finding silences every real one, and the reviewer
 * has no way to distinguish that from "nothing found".
 */
export async function publishReview(client: GithubClient, input: PublishInput): Promise<PublishResult> {
  const state = { attempts: 0, published: [] as InlineComment[], dropped: [] as InlineComment[], detail: null as string | null };
  const lastReview = { id: null as number | null, url: null as string | null };

  if (input.comments.length === 0) {
    // A summary with no inline comments is still a review worth posting: it
    // records that the code was examined.
    try {
      const review = await postReview(client, input, []);
      return {
        ok: true,
        reviewId: review.id ?? null,
        reviewUrl: review.html_url ?? null,
        dropped: [],
        degraded: false,
        detail: null,
      };
    } catch (error) {
      if (error instanceof GithubError) {
        return { ok: false, reviewId: null, reviewUrl: null, dropped: [], degraded: false, detail: `GitHub rejected the review: ${error.message}` };
      }
      throw error;
    }
  }

  const result = await publishSet(client, input, input.comments, state, lastReview);

  // Everything was rejected. Post the summary on its own so the developer still
  // sees that the code was examined and that N findings existed but could not be
  // placed — silence here would read as "nothing found", which is the specific
  // misunderstanding this whole path exists to prevent.
  if (result.ok && result.published.length === 0 && input.comments.length > 0) {
    try {
      const review = await postReview(client, input, []);
      return {
        ok: true,
        reviewId: review.id ?? null,
        reviewUrl: review.html_url ?? null,
        dropped: result.dropped,
        degraded: true,
        detail:
          `GitHub rejected all ${input.comments.length} inline comment(s). The summary was ` +
          "published without them, so this run's findings are not visible on the diff.",
      };
    } catch (error) {
      if (!(error instanceof GithubError)) throw error;
      return {
        ok: false,
        reviewId: null,
        reviewUrl: null,
        dropped: result.dropped,
        degraded: true,
        detail: `GitHub rejected the review: ${error.message}`,
      };
    }
  }

  return {
    ok: result.ok,
    reviewId: result.reviewId,
    reviewUrl: result.reviewUrl,
    dropped: result.dropped,
    degraded: result.dropped.length > 0,
    detail:
      result.dropped.length > 0
        ? `GitHub rejected ${result.dropped.length} of ${input.comments.length} inline comment(s) and they were omitted. ` +
          `${result.published.length} were published.`
        : result.detail,
  };
}
