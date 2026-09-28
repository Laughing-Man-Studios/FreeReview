/**
 * Publisher tests.
 *
 * Two properties matter more than the happy path:
 *
 * 1. **The action can never block a merge.** There is no code path that produces
 *    `APPROVE` or `REQUEST_CHANGES`, and these tests would fail if one appeared.
 *
 * 2. **One bad comment must not suppress every good one.** GitHub rejects a
 *    whole review with a 422 if any inline comment is unacceptable, which for an
 *    advisory tool is the worst possible failure: the developer sees no findings
 *    at all and concludes the code is clean.
 */

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GithubClient } from "../../src/github/client.js";
import { buildReviewPayload, publishReview, type InlineComment, type PublishInput } from "../../src/github/publish.js";

const API = "https://api.github.com";
const REVIEWS = `${API}/repos/acme/widgets/pulls/42/reviews`;

const server = setupServer();

/**
 * Every payload sent, for asserting the event is always COMMENT.
 *
 * Recorded inside the handler rather than via a `request:start` hook, because
 * that hook's body parse is a promise — it resolves after `afterEach` has
 * already cleared the array, and the late push pollutes the next test. This was
 * a real flake, not a theoretical one.
 */
let sent: Record<string, unknown>[] = [];

interface CommentStub {
  readonly line: number;
}

/**
 * Wrap a handler so every payload it receives is recorded.
 *
 * msw passes a resolver-info object whose `request` is a real `Request`, so the
 * body must be cloned before reading — the same request is reused.
 */
function record(handler: (comments: readonly CommentStub[]) => Response) {
  return async ({ request }: { request: Request }): Promise<Response> => {
    const body = (await request.clone().json()) as { comments?: CommentStub[] };
    sent.push(body);
    return handler(body.comments ?? []);
  };
}

function unprocessable(message = "Validation Failed") {
  return HttpResponse.json({ message }, { status: 422 });
}

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

afterEach(() => {
  server.resetHandlers();
  sent = [];
});

afterAll(() => server.close());

function client(): GithubClient {
  return new GithubClient({ token: "ghp_testtoken0000000000000000000000", sleep: () => Promise.resolve() });
}

function comment(n: number): InlineComment {
  return {
    path: "src/loop.ts",
    body: `Finding ${n}`,
    line: n,
    side: "RIGHT",
  };
}

function input(comments: readonly InlineComment[]): PublishInput {
  return {
    owner: "acme",
    repo: "widgets",
    pullNumber: 42,
    commitId: "a".repeat(40),
    body: "## FreeReview",
    comments,
  };
}

function okReview() {
  return HttpResponse.json({ id: 99, html_url: "https://github.com/acme/widgets/pull/42#pullrequestreview-99" });
}

describe("the payload", () => {
  it("always sends COMMENT as the event", () => {
    // The single most important assertion in this file. There must be no way
    // for this action to block a merge, and the payload is where that would be
    // decided.
    expect(buildReviewPayload(input([]), [])["event"]).toBe("COMMENT");
    expect(buildReviewPayload(input([comment(1)]), [comment(1)])["event"]).toBe("COMMENT");
  });

  it("names no other event anywhere in the payload", () => {
    const payload = JSON.stringify(buildReviewPayload(input([comment(1)]), [comment(1)]));
    expect(payload).not.toContain("APPROVE");
    expect(payload).not.toContain("REQUEST_CHANGES");
  });

  it("anchors comments to the reviewed commit", () => {
    const payload = buildReviewPayload(input([comment(1)]), [comment(1)]);
    expect(payload["commit_id"]).toBe("a".repeat(40));
  });

  it("includes a start_line only for a multi-line comment", () => {
    const single = buildReviewPayload(input([comment(1)]), [comment(1)])["comments"] as Record<string, unknown>[];
    expect(single[0]).not.toHaveProperty("start_line");

    const ranged: InlineComment = { ...comment(1), startLine: 1, startSide: "RIGHT" };
    const multi = buildReviewPayload(input([ranged]), [ranged])["comments"] as Record<string, unknown>[];
    expect(multi[0]?.["start_line"]).toBe(1);
    expect(multi[0]?.["start_side"]).toBe("RIGHT");
  });
});

describe("a successful publication", () => {
  it("posts one review and returns its URL", async () => {
    server.use(http.post(REVIEWS, record(() => okReview())));

    const result = await publishReview(client(), input([comment(1), comment(2)]));

    expect(result.ok).toBe(true);
    expect(result.reviewId).toBe(99);
    expect(result.reviewUrl).toContain("pullrequestreview-99");
    expect(result.dropped).toHaveLength(0);
    expect(result.degraded).toBe(false);
    // One atomic submission, not one request per comment.
    expect(sent).toHaveLength(1);
  });

  it("publishes a summary even with no inline comments", async () => {
    // A review with nothing to say is still evidence the code was examined,
    // and is materially different from no review at all.
    server.use(http.post(REVIEWS, record(() => okReview())));

    const result = await publishReview(client(), input([]));

    expect(result.ok).toBe(true);
    expect(sent[0]?.["body"]).toBe("## FreeReview");
    expect(sent[0]?.["comments"]).toEqual([]);
  });
});

describe("a 422 must not suppress the whole review", () => {
  it("bisects to isolate the offending comment", async () => {
    // Four comments, one of which GitHub rejects. Without bisection the whole
    // review fails and the developer sees nothing, which reads as "no findings".
    server.use(
      http.post(REVIEWS, record((comments) => (comments.some((c) => c.line === 3) ? unprocessable() : okReview()))),
    );

    const result = await publishReview(client(), input([comment(1), comment(2), comment(3), comment(4)]));

    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.dropped.map((c) => c.line)).toEqual([3]);
    expect(result.detail).toMatch(/rejected 1 of 4/);
  });

  it("retries both halves, so a bad comment does not suppress later valid ones", async () => {
    // The first implementation kept the first half and discarded the rest, so a
    // single bad comment silently swallowed every comment after it — the exact
    // "nothing found" illusion the recovery path exists to prevent, caused by a
    // bug in the recovery rather than by a rejection.
    server.use(
      http.post(REVIEWS, record((comments) => (comments.some((c) => c.line === 2) ? unprocessable() : okReview()))),
    );

    const result = await publishReview(client(), input([comment(1), comment(2), comment(3)]));

    expect(result.ok).toBe(true);
    expect(result.dropped.map((c) => c.line)).toEqual([2]);
    // Comments 1 and 3 both survive, in separate successful submissions. The
    // rejected attempts are also in `sent`, so assert on the two accepted
    // payloads rather than on everything that was tried.
    const attempted = sent.map((b) => (b["comments"] as { line: number }[] | undefined) ?? []).filter((c) => c.length > 0);
    expect(attempted.at(-1)).toEqual([expect.objectContaining({ line: 3 })]);
    expect(attempted.some((c) => c.length === 1 && c[0]?.line === 1)).toBe(true);
    // Five attempts for three comments: the whole set, its first half, that
    // half split again, and finally the third comment on its own. The bad
    // comment was isolated without ever being published alongside a good one.
    expect(attempted).toHaveLength(5);
  });

  it("publishes the summary alone when every comment is rejected", async () => {
    // Silence would read as "nothing found". The summary carries the count and
    // says the findings could not be placed.
    server.use(
      http.post(REVIEWS, record((comments) => (comments.length > 0 ? unprocessable() : okReview()))),
    );

    const result = await publishReview(client(), input([comment(1), comment(2)]));

    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.dropped).toHaveLength(2);
    expect(result.detail).toMatch(/rejected all 2/);
    const last = sent[sent.length - 1] as { comments: unknown[]; body: string };
    expect(last.comments).toEqual([]);
    expect(last.body).toBe("## FreeReview");
  });

  it("stops isolating after the attempt ceiling rather than spinning", async () => {
    // The summary is always accepted, so the run still ends with something
    // published rather than an unbounded request loop.
    server.use(
      http.post(REVIEWS, record((comments) => (comments.length > 0 ? unprocessable() : okReview()))),
    );

    const result = await publishReview(client(), input(Array.from({ length: 20 }, (_, i) => comment(i + 1))));

    expect(sent.length).toBeLessThanOrEqual(25);
    expect(result.ok).toBe(true);
  });

  it("gives up on a single rejected comment and still posts the summary", async () => {
    server.use(
      http.post(REVIEWS, record((comments) => (comments.length > 0 ? unprocessable() : okReview()))),
    );

    const result = await publishReview(client(), input([comment(1)]));

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(2);
    expect(result.dropped).toHaveLength(1);
  });

  it("does not mistake a permission failure for a bad comment", async () => {
    // A 403 is an operator problem. Bisecting on it would burn API calls
    // narrowing down a failure that has nothing to do with any one comment.
    server.use(
      http.post(
        REVIEWS,
        record(() => HttpResponse.json({ message: "Resource not accessible by integration" }, { status: 403 })),
      ),
    );

    const result = await publishReview(client(), input([comment(1), comment(2), comment(3), comment(4)]));

    expect(result.ok).toBe(false);
    expect(sent).toHaveLength(1);
  });
});
