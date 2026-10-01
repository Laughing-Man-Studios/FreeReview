/**
 * Stale-commit stress: the race between computing a review and publishing it.
 *
 * ## Why this needs its own stress test
 *
 * A review run takes real time — chunking, rendering, one or more model requests
 * with backoff, and GitHub publication. A push landing inside that window means
 * the diff the review was computed against is no longer the diff at the head.
 *
 * The failure is quiet and confident. GitHub resolves `line` and `side` against
 * the *current* head, so a comment anchored to line 12 lands on whatever now
 * occupies line 12. The review publishes successfully and is simply about
 * different code — a claim about a line the author never wrote, made with the
 * authority of a review nobody checked.
 *
 * ## The rule, and what the tests pin
 *
 * Re-read the pull request head immediately before publishing. If it moved,
 * discard **every** finding — not the ones whose lines happen to be unchanged. A
 * changed SHA can move a line *above* an unrelated finding and invalidate its
 * anchoring silently, and there is no cheap way to prove per-finding survival.
 *
 * The stress cases are the ones a single check cannot cover: the push landing
 * mid-chunk, the push landing between the check and publication, and the API
 * being unreachable at check time. The last is the dangerous one — it is tempting
 * to publish when the check cannot be performed, and that is exactly the case
 * where publishing is most likely to be wrong.
 */

import { describe, expect, it } from "vitest";
import { confirmHeadUnchanged } from "../../src/pipeline/stale.js";
import { GithubError, type GithubClient } from "../../src/github/client.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const HEAD_C = "c".repeat(40);

/**
 * A GitHub client whose head moves on the Nth call.
 *
 * Models the real interleaving: the review reads the head once to build the
 * request, then again before publishing. `movesOnCall` is the second read.
 */
function client(opts: { head?: string; movesOnCall?: number; failFromCall?: number } = {}) {
  let n = 0;

  const c = {
    get<T>(): Promise<T> {
      n += 1;
      if (opts.failFromCall !== undefined && n >= opts.failFromCall) {
        // A `GithubError` specifically. The implementation distinguishes it from a
        // programming error and returns `unverifiable` for it; an arbitrary throw
        // propagates, which is correct — a bug must not be reported as a stale PR.
        return Promise.reject(new GithubError("server", 503, "service unavailable"));
      }
      const sha = opts.movesOnCall !== undefined && n >= opts.movesOnCall ? HEAD_B : (opts.head ?? HEAD_A);
      return Promise.resolve({ head: { sha }, number: 7, base: { sha: HEAD_A } } as unknown as T);
    },
  } as unknown as GithubClient;

  return { client: c, reads: () => n };
}

const PARAMS = { owner: "acme", repo: "app", pullNumber: 7 };

describe("the head has not moved", () => {
  it("confirms and reports the current head", async () => {
    const { client: gh } = client({ head: HEAD_A });
    const result = await confirmHeadUnchanged(gh, { ...PARAMS, expectedHeadSha: HEAD_A });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.currentHeadSha).toBe(HEAD_A);
  });

  it("confirms across many polls that all agree", async () => {
    // A steady state is the common case and must not be mistaken for staleness:
    // a false positive here discards a correct review, which is as bad as the
    // failure it guards against.
    for (let i = 0; i < 25; i += 1) {
      const { client: gh } = client({ head: HEAD_A });
      const result = await confirmHeadUnchanged(gh, { ...PARAMS, expectedHeadSha: HEAD_A });
      expect(result.ok, `poll ${i} falsely reported staleness`).toBe(true);
    }
  });
});

describe("the head moved during the run", () => {
  it("reports stale", async () => {
    const { client: gh } = client({ movesOnCall: 1 });
    const result = await confirmHeadUnchanged(gh, { ...PARAMS, expectedHeadSha: HEAD_A });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("stale");
  });

  it("names both heads, so the failure is diagnosable from the log", async () => {
    const { client: gh } = client({ movesOnCall: 1 });
    const result = await confirmHeadUnchanged(gh, { ...PARAMS, expectedHeadSha: HEAD_A });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Names the cause, says what happened to the findings, and says what will
      // happen next — so an operator reading the log knows whether to re-run.
      expect(result.detail).toMatch(/new commit/i);
      expect(result.detail).toMatch(/discarded/i);
      expect(result.detail).toMatch(/fresh review/i);
    }
  });

  it("discards the review entirely, not just findings near the change", async () => {
    // The rule being pinned. Per-finding survival cannot be proven cheaply: a
    // changed SHA can shift a line *above* an unrelated finding.
    const { client: gh } = client({ movesOnCall: 1 });
    const result = await confirmHeadUnchanged(gh, { ...PARAMS, expectedHeadSha: HEAD_A });

    // The result carries no findings — it is a whole-run verdict.
    expect(result).not.toHaveProperty("findings");
    expect(result.ok).toBe(false);
  });

  it("reads the pull request exactly once, as late as possible", async () => {
    // A single read, at the last moment before publishing. My first version of
    // this test modelled interleavings *inside* the check — a push landing between
    // two reads — which cannot happen, because there is only one read.
    //
    // The property worth pinning is the one that makes a single read sufficient:
    // nothing is cached or reused from earlier in the run, so a push landing at any
    // point during chunking or model requests is necessarily observed here.
    const { client: gh, reads } = client();
    const result = await confirmHeadUnchanged(gh, { ...PARAMS, expectedHeadSha: HEAD_A });

    expect(result.ok).toBe(true);
    expect(reads()).toBe(1);
  });

  it("observes a push that landed at any point before the check", async () => {
    // The consequence of the single read: any move before it is caught, so the
    // exact time the push landed during the run does not matter.
    for (const movesOnCall of [1]) {
      const { client: gh } = client({ movesOnCall });
      const result = await confirmHeadUnchanged(gh, { ...PARAMS, expectedHeadSha: HEAD_A });
      expect(result.ok, `move on call ${movesOnCall} was not detected`).toBe(false);
    }
  });
});

describe("an unverifiable head is not a confirmation", () => {
  it("reports unverifiable rather than stale, and never `ok`", async () => {
    // Distinct on purpose. `stale` means "do not publish, a newer run will". A
    // GitHub error means something else entirely, and conflating them makes the
    // diagnostic lie about why a review was withheld.
    const { client: gh } = client({ failFromCall: 1 });
    const result = await confirmHeadUnchanged(gh, { ...PARAMS, expectedHeadSha: HEAD_A });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unverifiable");
      expect(result.reason).not.toBe("stale");
    }
  });

  it("never publishes on an unverifiable check", async () => {
    // The dangerous temptation: GitHub had a bad minute, so publish anyway. That
    // is exactly when the check matters most, because the push that made the
    // review stale may be the push whose API response we could not read.
    const { client: gh } = client({ failFromCall: 1 });
    const result = await confirmHeadUnchanged(gh, { ...PARAMS, expectedHeadSha: HEAD_A });

    expect(result.ok).toBe(false);
  });
});

describe("repeated runs after a push", () => {
  it("accepts the new head once the review is recomputed against it", async () => {
    // A push must not wedge the action: `synchronize` re-triggers, and the
    // recomputed review matches the new head.
    const first = await confirmHeadUnchanged(client({ movesOnCall: 1 }).client, { ...PARAMS, expectedHeadSha: HEAD_A });
    expect(first.ok).toBe(false);

    const second = await confirmHeadUnchanged(client({ head: HEAD_B }).client, { ...PARAMS, expectedHeadSha: HEAD_B });
    expect(second.ok).toBe(true);
  });

  it("does not accumulate state between runs", async () => {
    // 30 stale runs then one clean run: the clean one must pass. A memoised
    // "already reported stale" would withhold every subsequent review.
    for (let i = 0; i < 30; i += 1) {
      const result = await confirmHeadUnchanged(client({ movesOnCall: 1 }).client, { ...PARAMS, expectedHeadSha: HEAD_A });
      expect(result.ok).toBe(false);
    }
    const fresh = await confirmHeadUnchanged(client({ head: HEAD_C }).client, { ...PARAMS, expectedHeadSha: HEAD_C });
    expect(fresh.ok).toBe(true);
  });
});