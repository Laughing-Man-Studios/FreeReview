/**
 * Staleness check.
 *
 * A review run takes real time: chunking, rendering, one or more model requests
 * with backoff, and now GitHub publication. In that window a push can land, and
 * the diff this review was computed against is no longer the diff at the head
 * of the pull request.
 *
 * ## Why this is checked, and not just noted
 *
 * The alternative is publishing findings anchored to lines that have since
 * moved. GitHub will accept them — `line` and `side` are resolved against the
 * current head, so a comment lands on whatever now occupies that line. The
 * result is a confident claim about code nobody wrote.
 *
 * A developer whose push got "reviewed" by a tool commenting on the wrong line
 * concludes the tool is broken, and is right. This check costs one API call.
 *
 * ## The rule
 *
 * Re-read the pull request immediately before publishing. If `head.sha` differs
 * from the SHA the review was computed against, **every** finding is discarded.
 * Not the findings whose lines happen to be unchanged — a changed SHA can move
 * a line above an unrelated finding and invalidate its anchoring silently, and
 * there is no cheap way to prove per-finding survival.
 *
 * The run reports `STALE_HEAD_SHA` and publishes nothing. A subsequent
 * `synchronize` event triggers a fresh run against the new head.
 */

import { GithubError, type GithubClient } from "../github/client.js";
import { getPullRequest } from "../github/pr.js";

export type StalenessResult =
  | { readonly ok: true; readonly currentHeadSha: string }
  | { readonly ok: false; readonly reason: "stale" | "unverifiable"; readonly detail: string };

/**
 * Confirm the pull request head has not moved since the review was computed.
 *
 * `unverifiable` is deliberately distinct from `stale`. A GitHub error means we
 * do not know, and publishing anyway would be choosing the unsafe branch on a
 * network blip. The run skips publication and says so, which is a visible,
 * recoverable outcome rather than a wrong review.
 */
export async function confirmHeadUnchanged(
  client: GithubClient,
  params: { owner: string; repo: string; pullNumber: number; expectedHeadSha: string },
): Promise<StalenessResult> {
  let currentHeadSha: string;

  try {
    const pr = await getPullRequest(client, params.owner, params.repo, params.pullNumber);
    currentHeadSha = pr.head.sha;
  } catch (error) {
    if (error instanceof GithubError) {
      return {
        ok: false,
        reason: "unverifiable",
        detail: `Could not re-read the pull request to confirm it had not changed: ${error.message}`,
      };
    }
    throw error;
  }

  if (currentHeadSha !== params.expectedHeadSha) {
    return {
      ok: false,
      reason: "stale",
      detail:
        "The pull request gained a new commit while this review was running. The findings " +
        "were computed against the previous version and have been discarded rather than " +
        "published against lines that have since moved. The new commit will trigger a fresh review.",
    };
  }

  return { ok: true, currentHeadSha };
}
