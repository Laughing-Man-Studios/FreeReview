/**
 * Integration tests for the GitHub client, against a mocked api.github.com.
 *
 * These assert on the exact wire contract — headers, pagination, retry
 * behaviour, and the error taxonomy the retry policy depends on — because that
 * taxonomy is what decides whether a run wastes quota or wastes wall clock.
 *
 * No network access. `sleep` is injected so backoff does not consume real time.
 */

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ACCEPT_JSON,
  GITHUB_API_VERSION,
  GithubClient,
  GithubError,
} from "../../src/github/client.js";
import { getPullRequest, listPullRequestFiles } from "../../src/github/pr.js";
import type { PrFile, PullRequestMetadata } from "../../src/github/pr.js";

const API = "https://api.github.com";
const OWNER = "acme";
const REPO = "widgets";
const PR_PATH = `${API}/repos/${OWNER}/${REPO}/pulls/42`;

const server = setupServer();

/** Records every request so header and call-count assertions are possible. */
const seen: { url: string; headers: Headers; method: string }[] = [];

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  // Global hook: every request is recorded, so tests that do not care about
  // headers still get accurate call counts for free.
  server.events.on("request:start", ({ request }) => {
    seen.push({ url: request.url, headers: new Headers(request.headers), method: request.method });
  });
});

afterEach(() => {
  server.resetHandlers();
  seen.length = 0;
});

afterAll(() => {
  server.close();
});

function client(overrides: Partial<ConstructorParameters<typeof GithubClient>[0]> = {}) {
  return new GithubClient({
    token: "ghp_testtoken0000000000000000000000",
    sleep: async () => {}, // no real backoff in tests
    maxRetries: 3,
    ...overrides,
  });
}

function prPayload(overrides: Partial<PullRequestMetadata> = {}): PullRequestMetadata {
  return {
    number: 42,
    state: "open",
    merged: false,
    draft: false,
    title: "Add widget factory",
    head: {
      label: `${OWNER}:feature`,
      ref: "feature",
      sha: "a".repeat(40),
      repo: {
        id: 1,
        name: REPO,
        full_name: `${OWNER}/${REPO}`,
        private: true,
        owner: { login: OWNER },
        fork: false,
      },
    },
    base: {
      label: `${OWNER}:main`,
      ref: "main",
      sha: "b".repeat(40),
      repo: {
        id: 1,
        name: REPO,
        full_name: `${OWNER}/${REPO}`,
        private: true,
        owner: { login: OWNER },
        fork: false,
      },
    },
    additions: 10,
    deletions: 2,
    changed_files: 1,
    commits: 1,
    mergeable: true,
    ...overrides,
  };
}

function fileEntry(index: number): PrFile {
  return {
    sha: `sha${index}`,
    filename: `src/file${index}.ts`,
    status: "modified",
    additions: 3,
    deletions: 1,
    changes: 4,
    patch: "@@ -1,2 +1,4 @@\n line\n-old\n+new",
    blob_url: `${API}/repos/${OWNER}/${REPO}/blobs/sha${index}`,
    raw_url: `https://raw.githubusercontent.com/${OWNER}/${REPO}/feature/src/file${index}.ts`,
  };
}

describe("request construction", () => {
  it("sends the pinned API version, JSON accept, and bearer token", async () => {
    server.use(http.get(PR_PATH, () => HttpResponse.json(prPayload())));

    await getPullRequest(client(), OWNER, REPO, 42);

    const headers = seen[0]?.headers;
    expect(headers?.get("authorization")).toBe("Bearer ghp_testtoken0000000000000000000000");
    expect(headers?.get("accept")).toBe(ACCEPT_JSON);
    expect(headers?.get("x-github-api-version")).toBe(GITHUB_API_VERSION);
    expect(headers?.get("user-agent")).toBe("FreeReview");
  });

  it("pins the API version so a GitHub-side default change cannot alter a released action", () => {
    expect(GITHUB_API_VERSION).toBe("2026-03-10");
  });
});

describe("the eligibility gate costs exactly one API call", () => {
  it("returns everything the gate needs from GET /pulls/{n} alone", async () => {
    server.use(http.get(PR_PATH, () => HttpResponse.json(prPayload())));

    const pr = await getPullRequest(client(), OWNER, REPO, 42);

    // Every field pipeline/eligibility.ts reads.
    expect(pr.head.sha).toBe("a".repeat(40));
    expect(pr.head.repo?.full_name).toBe(`${OWNER}/${REPO}`);
    expect(pr.base.repo?.full_name).toBe(`${OWNER}/${REPO}`);
    expect(pr.base.repo?.private).toBe(true);
    expect(pr.state).toBe("open");
    expect(pr.merged).toBe(false);
    expect(pr.draft).toBe(false);
    expect(pr.additions + pr.deletions).toBe(12);

    expect(seen).toHaveLength(1);
  });
});

describe("pagination", () => {
  it("follows pages to completion and stops on a short page", async () => {
    server.use(
      http.get(`${PR_PATH}/files`, ({ request }) => {
        const url = new URL(request.url);
        const page = Number(url.searchParams.get("page") ?? "1");
        const perPage = Number(url.searchParams.get("per_page") ?? "30");

        if (page === 1) {
          return HttpResponse.json(Array.from({ length: perPage }, (_, i) => fileEntry(i)));
        }
        // Second page is short, so iteration must stop here.
        return HttpResponse.json([fileEntry(100)]);
      }),
    );

    const files = await listPullRequestFiles(client(), OWNER, REPO, 42);

    expect(files).toHaveLength(101);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.url).toContain("per_page=100");
  });

  it("stops on an empty page", async () => {
    server.use(http.get(`${PR_PATH}/files`, () => HttpResponse.json([])));
    expect(await listPullRequestFiles(client(), OWNER, REPO, 42)).toEqual([]);
  });

  it("honours a page cap rather than looping forever on a pathological server", async () => {
    // A server that always returns a full page would loop without a cap.
    server.use(
      http.get(`${PR_PATH}/files`, ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get("page") ?? "1");
        return HttpResponse.json(Array.from({ length: 100 }, (_, i) => fileEntry(page * 100 + i)));
      }),
    );

    const files = await listPullRequestFiles(client(), OWNER, REPO, 42);

    expect(files.length).toBeLessThanOrEqual(4_000);
    expect(seen.length).toBeLessThanOrEqual(40);
  });
});

describe("error taxonomy drives retry policy", () => {
  it("does NOT retry a 404 — a PR invisible to this token stays invisible", async () => {
    server.use(
      http.get(PR_PATH, () => HttpResponse.json({ message: "Not Found" }, { status: 404 })),
    );

    const error = (await getPullRequest(client(), OWNER, REPO, 42).catch((e: unknown) => e)) as GithubError;

    expect(error).toBeInstanceOf(GithubError);
    expect(error.kind).toBe("not_found");
    expect(error.retryable).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it("does NOT retry a 403 with no Retry-After — that is a permissions failure", async () => {
    server.use(
      http.get(PR_PATH, () =>
        HttpResponse.json({ message: "Resource not accessible by personal access token" }, { status: 403 }),
      ),
    );

    const error = (await getPullRequest(client(), OWNER, REPO, 42).catch((e: unknown) => e)) as GithubError;

    expect(error.kind).toBe("forbidden");
    expect(error.retryable).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it("retries a 403 that carries Retry-After, treating it as secondary rate limiting", async () => {
    let attempt = 0;
    server.use(
      http.get(PR_PATH, () => {
        attempt += 1;
        if (attempt === 1) {
          return HttpResponse.json(
            { message: "You have exceeded a secondary rate limit" },
            { status: 403, headers: { "Retry-After": "1" } },
          );
        }
        return HttpResponse.json(prPayload());
      }),
    );

    await expect(getPullRequest(client(), OWNER, REPO, 42)).resolves.toMatchObject({ number: 42 });
    expect(attempt).toBe(2);
  });

  it("classifies a 403 with Retry-After as rate_limited, not forbidden", async () => {
    server.use(
      http.get(PR_PATH, () =>
        HttpResponse.json({ message: "secondary" }, { status: 403, headers: { "Retry-After": "2" } }),
      ),
    );

    const error = (await getPullRequest(client({ maxRetries: 0 }), OWNER, REPO, 42).catch(
      (e: unknown) => e,
    )) as GithubError;

    expect(error.kind).toBe("rate_limited");
    expect(error.isSecondaryRateLimit).toBe(true);
    expect(error.retryAfterSeconds).toBe(2);
  });

  it("retries a 500 and succeeds", async () => {
    let attempt = 0;
    server.use(
      http.get(PR_PATH, () => {
        attempt += 1;
        if (attempt <= 2) return HttpResponse.json({ message: "boom" }, { status: 500 });
        return HttpResponse.json(prPayload());
      }),
    );

    await expect(getPullRequest(client(), OWNER, REPO, 42)).resolves.toMatchObject({ number: 42 });
    expect(attempt).toBe(3);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    server.use(
      http.get(PR_PATH, () => HttpResponse.json({ message: "still broken" }, { status: 502 })),
    );

    const error = (await getPullRequest(client({ maxRetries: 2 }), OWNER, REPO, 42).catch(
      (e: unknown) => e,
    )) as GithubError;

    expect(error.kind).toBe("server");
    expect(seen).toHaveLength(3); // initial + 2 retries
  });

  it("retries a network-level failure", async () => {
    let attempt = 0;
    server.use(
      http.get(PR_PATH, () => {
        attempt += 1;
        if (attempt === 1) return HttpResponse.error();
        return HttpResponse.json(prPayload());
      }),
    );

    await expect(getPullRequest(client(), OWNER, REPO, 42)).resolves.toMatchObject({ number: 42 });
  });

  it("prefers the server's Retry-After over its own backoff curve", async () => {
    const sleeps: number[] = [];
    let attempt = 0;
    server.use(
      http.get(PR_PATH, () => {
        attempt += 1;
        if (attempt === 1) {
          return HttpResponse.json(
            { message: "slow down" },
            { status: 429, headers: { "Retry-After": "7" } },
          );
        }
        return HttpResponse.json(prPayload());
      }),
    );

    await getPullRequest(
      client({ sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      } }),
      OWNER,
      REPO,
      42,
    );

    // 7 seconds from the header, not a value from our own exponential curve.
    expect(sleeps).toEqual([7000]);
    expect(attempt).toBe(2);
  });

  it("caps an absurd Retry-After so a hostile or buggy value cannot stall the run", async () => {
    const sleeps: number[] = [];
    let attempt = 0;
    server.use(
      http.get(PR_PATH, () => {
        attempt += 1;
        if (attempt === 1) {
          return HttpResponse.json(
            { message: "come back later" },
            { status: 429, headers: { "Retry-After": "86400" } },
          );
        }
        return HttpResponse.json(prPayload());
      }),
    );

    await getPullRequest(
      client({ sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      } }),
      OWNER,
      REPO,
      42,
    );

    expect(sleeps).toEqual([60_000]);
  });
});

describe("post() is never retried automatically", () => {
  it("throws on the first failure without retrying", async () => {
    let calls = 0;
    server.use(
      http.post(`${PR_PATH}/reviews`, () => {
        calls += 1;
        return HttpResponse.json({ message: "Validation Failed" }, { status: 422 });
      }),
    );

    const error = (await client()
      .post(`/repos/${OWNER}/${REPO}/pulls/42/reviews`, { event: "COMMENT" })
      .catch((e: unknown) => e)) as GithubError;

    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(GithubError);
    expect(error.kind).toBe("client");
  });

  it("sends a JSON content type and the pinned version", async () => {
    server.use(http.post(`${PR_PATH}/reviews`, () => HttpResponse.json({ id: 1 })));

    await client().post(`/repos/${OWNER}/${REPO}/pulls/42/reviews`, { event: "COMMENT" });

    expect(seen[0]?.headers.get("content-type")).toBe("application/json");
    expect(seen[0]?.headers.get("x-github-api-version")).toBe(GITHUB_API_VERSION);
    expect(seen[0]?.method).toBe("POST");
  });
});
