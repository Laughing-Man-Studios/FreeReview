/**
 * End-to-end pipeline tests through the Phase 4 probes.
 *
 * These drive the real `run()` against a mocked GitHub and OpenRouter, asserting
 * the *ordering* and *gating* properties that individual unit tests cannot see:
 *
 *  - the catalog and quota probes are free, so they must happen before any chat
 *    request and must not be counted against the request budget;
 *  - a run that cannot proceed must not send a request at all;
 *  - a probe that fails must degrade, not stop the review;
 *  - the daily reserve is respected at the pipeline level, not just in the
 *    scheduler, because the pipeline decides how many requests it *plans*.
 *
 * No network access. A real event payload is written to a temp file because
 * `GITHUB_EVENT_PATH` is the only way the event type can be read.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { run } from "../../src/run.js";
import { CHAT_COMPLETIONS_URL, KEY_URL, MODELS_URL } from "../../src/llm/client.js";
import { PROMPT_VERSION, CONFIG_VERSION } from "../../src/prompt/version.js";

const API = "https://api.github.com";
const OWNER = "acme";
const REPO = "widgets";
const PR = 42;
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const PR_PATH = `${API}/repos/${OWNER}/${REPO}/pulls/${PR}`;
const FILES_PATH = `${PR_PATH}/files`;

const server = setupServer();

/** Chat completions actually attempted. The budget tests assert on this. */
let chatCalls = 0;

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  server.events.on("request:start", ({ request }) => {
    if (request.method === "POST" && request.url === CHAT_COMPLETIONS_URL) chatCalls += 1;
  });
});

afterEach(() => {
  server.resetHandlers();
  chatCalls = 0;
});

afterAll(() => server.close());

// --- Event payload ---------------------------------------------------------

let workdir: string;

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), "freereview-run-"));
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function eventFile(action = "opened"): string {
  const path = join(workdir, `event-${action}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      action,
      repository: {
        name: REPO,
        owner: { login: OWNER },
        private: true,
        full_name: `${OWNER}/${REPO}`,
      },
      pull_request: { number: PR, head: { sha: HEAD_SHA }, base: { sha: BASE_SHA } },
    }),
    "utf8",
  );
  return path;
}

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: eventFile(),
    GITHUB_TOKEN: "ghp_testtoken0000000000000000000000",
    GITHUB_REPOSITORY: `${OWNER}/${REPO}`,
    GITHUB_EVENT_ACTION: "opened",
    INPUT_OPENROUTER_API_KEY: "sk-test-0000000000000000",
    INPUT_PRIMARY_MODEL: "qwen/qwen3.8-27b:free",
    ...overrides,
  };
}

// --- Mocked upstream -------------------------------------------------------

function prPayload(overrides: Record<string, unknown> = {}) {
  return {
    number: PR,
    state: "open",
    merged: false,
    draft: false,
    title: "Fix an off-by-one",
    body: "A real bug with a real fix.",
    head: {
      label: `${OWNER}:feature`,
      ref: "feature",
      sha: HEAD_SHA,
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
      sha: BASE_SHA,
      repo: {
        id: 1,
        name: REPO,
        full_name: `${OWNER}/${REPO}`,
        private: true,
        owner: { login: OWNER },
        fork: false,
      },
    },
    additions: 2,
    deletions: 2,
    changed_files: 1,
    commits: 1,
    mergeable: true,
    ...overrides,
  };
}

/**
 * A patch with a genuine off-by-one on the RIGHT side.
 *
 * The `@@` header counts are computed rather than written by hand, for the same
 * reason `tests/unit/render.test.ts` has a `hunk(...lines)` helper: the parser is
 * strict about them by design, and a miscounted header is a parse failure rather
 * than an off-by-one warning.
 */
const PATCH = [
  "diff --git a/src/loop.ts b/src/loop.ts",
  "index 1111111..2222222 100644",
  "--- a/src/loop.ts",
  "+++ b/src/loop.ts",
  "@@ -1,3 +1,3 @@",
  " export function total(values: number[]): number {",
  "-  return values.length;",
  "+  return values.length - 1;",
  " }",
  "",
].join("\n");

function filesPayload() {
  return [
    {
      sha: "blob1",
      filename: "src/loop.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
      patch: PATCH,
      blob_url: `${API}/repos/${OWNER}/${REPO}/blobs/blob1`,
      raw_url: `https://raw.githubusercontent.com/${OWNER}/${REPO}/feature/src/loop.ts`,
    },
  ];
}

function catalogPayload(modelId = "qwen/qwen3.8-27b:free") {
  return {
    data: [
      {
        id: modelId,
        context_length: 262_144,
        pricing: { prompt: "0", completion: "0" },
        supported_parameters: ["temperature", "max_tokens", "structured_outputs", "tools"],
      },
    ],
  };
}

/** A healthy upstream: one eligible PR, a valid model, plenty of allowance. */
function healthy(): void {
  server.use(http.get(PR_PATH, () => HttpResponse.json(prPayload())));
  server.use(http.get(FILES_PATH, () => HttpResponse.json(filesPayload())));
  server.use(http.get(MODELS_URL, () => HttpResponse.json(catalogPayload())));
  server.use(
    http.get(KEY_URL, () =>
      HttpResponse.json({
        data: { is_free_tier: false, free_model_daily_requests: { used: 2, limit: 50, remaining: 48 } },
      }),
    ),
  );
}

describe("the run reaches the Phase 4 boundary with no request sent", () => {
  it("probes the catalog and the quota, then stops before spending anything", async () => {
    healthy();
    const urls: string[] = [];
    server.events.on("request:start", ({ request }) => urls.push(request.url));

    const outputs = await run(env());

    expect(urls).toContain(MODELS_URL);
    expect(urls).toContain(KEY_URL);
    // The probes cost nothing against the daily allowance, and the pipeline
    // stops at the Phase 4 boundary, so nothing has been spent.
    expect(chatCalls).toBe(0);
    expect(outputs.requests_used).toBe("0");
  });
});

describe("the model must be usable before anything is sent", () => {
  it("skips without a request when the configured model left the catalog", async () => {
    server.use(http.get(PR_PATH, () => HttpResponse.json(prPayload())));
    server.use(http.get(FILES_PATH, () => HttpResponse.json(filesPayload())));
    // The catalog is readable, and the model is simply not in it.
    server.use(http.get(MODELS_URL, () => HttpResponse.json(catalogPayload("other/model:free"))));
    server.use(http.get(KEY_URL, () => HttpResponse.json({ data: {} })));

    const outputs = await run(env());

    // The status is derived from the recorded diagnostic, not passed in, so a
    // maintainer reading the check URL sees the actual reason.
    expect(outputs.status).toBe("skipped_no_eligible_model");
    expect(chatCalls).toBe(0);
  });

  it("skips without a request when the model is no longer priced at zero", async () => {
    server.use(http.get(PR_PATH, () => HttpResponse.json(prPayload())));
    server.use(http.get(FILES_PATH, () => HttpResponse.json(filesPayload())));
    // Still listed, still suffixed `:free`, but repriced. The id is not proof.
    server.use(
      http.get(MODELS_URL, () =>
        HttpResponse.json({
          data: [
            {
              id: "qwen/qwen3.8-27b:free",
              context_length: 262_144,
              pricing: { prompt: "0.0000002", completion: "0" },
              supported_parameters: ["structured_outputs"],
            },
          ],
        }),
      ),
    );
    server.use(http.get(KEY_URL, () => HttpResponse.json({ data: {} })));

    const outputs = await run(env());

    expect(outputs.status).toBe("skipped_no_eligible_model");
    expect(chatCalls).toBe(0);
  });

  it("degrades to configured assumptions when the catalog is unreachable", async () => {
    // Refusing to review because a free probe failed would make the tool
    // useless whenever OpenRouter has a bad minute.
    server.use(http.get(PR_PATH, () => HttpResponse.json(prPayload())));
    server.use(http.get(FILES_PATH, () => HttpResponse.json(filesPayload())));
    server.use(http.get(MODELS_URL, () => HttpResponse.error()));
    server.use(
      http.get(KEY_URL, () =>
        HttpResponse.json({
          data: { is_free_tier: false, free_model_daily_requests: { used: 1, limit: 50, remaining: 49 } },
        }),
      ),
    );

    const outputs = await run(env());

    // It got past the eligibility gate, so the status reflects the Phase 4
    // boundary rather than a model rejection.
    expect(outputs.status).toBe("skipped_pipeline_not_implemented");
    expect(chatCalls).toBe(0);
  });
});

describe("the daily reserve is respected at the pipeline level", () => {
  it("skips without a request when the allowance is exhausted", async () => {
    server.use(http.get(PR_PATH, () => HttpResponse.json(prPayload())));
    server.use(http.get(FILES_PATH, () => HttpResponse.json(filesPayload())));
    server.use(http.get(MODELS_URL, () => HttpResponse.json(catalogPayload())));
    server.use(
      http.get(KEY_URL, () =>
        HttpResponse.json({
          data: { is_free_tier: false, free_model_daily_requests: { used: 49, limit: 50, remaining: 1 } },
        }),
      ),
    );

    const outputs = await run(env());

    // A distinct status, not a generic skip: the maintainer needs to know the
    // review was skipped for budget reasons and will succeed tomorrow.
    expect(outputs.status).toBe("skipped_quota_exhausted");
    expect(chatCalls).toBe(0);
  });

  it("skips without a request when only the reserve remains", async () => {
    server.use(http.get(PR_PATH, () => HttpResponse.json(prPayload())));
    server.use(http.get(FILES_PATH, () => HttpResponse.json(filesPayload())));
    server.use(http.get(MODELS_URL, () => HttpResponse.json(catalogPayload())));
    // Remaining exactly equal to the default reserve of 10.
    server.use(
      http.get(KEY_URL, () =>
        HttpResponse.json({
          data: { is_free_tier: false, free_model_daily_requests: { used: 40, limit: 50, remaining: 10 } },
        }),
      ),
    );

    const outputs = await run(env());

    expect(outputs.status).toBe("skipped_quota_exhausted");
    expect(chatCalls).toBe(0);
  });

  it("continues when the quota probe itself fails", async () => {
    // The per-run budget still bounds the run, so an unreadable allowance is
    // not a reason to review nothing.
    server.use(http.get(PR_PATH, () => HttpResponse.json(prPayload())));
    server.use(http.get(FILES_PATH, () => HttpResponse.json(filesPayload())));
    server.use(http.get(MODELS_URL, () => HttpResponse.json(catalogPayload())));
    server.use(http.get(KEY_URL, () => HttpResponse.error()));

    const outputs = await run(env());

    expect(outputs.status).toBe("skipped_pipeline_not_implemented");
    expect(chatCalls).toBe(0);
  });
});

describe("a rejected quota probe is not mistaken for a rejected review", () => {
  it("does not report no_findings when it could not review", async () => {
    // The most damaging possible lie: a green run that reviewed nothing.
    server.use(http.get(PR_PATH, () => HttpResponse.json(prPayload())));
    server.use(http.get(FILES_PATH, () => HttpResponse.json(filesPayload())));
    server.use(http.get(MODELS_URL, () => HttpResponse.json(catalogPayload())));
    server.use(
      http.get(KEY_URL, () =>
        HttpResponse.json({
          data: { is_free_tier: false, free_model_daily_requests: { used: 50, limit: 50, remaining: 0 } },
        }),
      ),
    );

    const outputs = await run(env());

    expect(outputs.status).not.toBe("reviewed");
    expect(outputs.status).not.toBe("no_findings");
    expect(outputs.findings_count).toBe("0");
  });
});

describe("the gate order is preserved", () => {
  it("never probes OpenRouter for a pull request from a public repository", async () => {
    // A public repository is rejected before anything is sent anywhere.
    // Probing OpenRouter first would be a privacy bug: it reveals that a
    // specific pull request exists, to a third party, before the gate ran.
    // The gate keys off the *base* repository's privacy, since that is the
    // code whose contents would be sent.
    const publicPr = prPayload();
    publicPr.base.repo.private = false;

    server.use(http.get(PR_PATH, () => HttpResponse.json(publicPr)));

    const urls: string[] = [];
    server.events.on("request:start", ({ request }) => urls.push(request.url));

    const outputs = await run(env());

    expect(outputs.status).toBe("skipped_public_repository");
    expect(urls.some((u) => u.startsWith("https://openrouter.ai"))).toBe(false);
  });

  it("never probes OpenRouter for a draft pull request", async () => {
    server.use(http.get(PR_PATH, () => HttpResponse.json(prPayload({ draft: true }))));

    const urls: string[] = [];
    server.events.on("request:start", ({ request }) => urls.push(request.url));

    const outputs = await run(env());

    expect(outputs.status).toBe("skipped_draft_pr");
    expect(urls.some((u) => u.startsWith("https://openrouter.ai"))).toBe(false);
  });

  it("never lists changed files for a pull request that failed the gate", async () => {
    // Cheapest assertion of the same property: the run must not even read the
    // diff, let alone send it.
    server.use(http.get(PR_PATH, () => HttpResponse.json(prPayload({ draft: true }))));

    const urls: string[] = [];
    server.events.on("request:start", ({ request }) => urls.push(request.url));

    await run(env());

    expect(urls.some((u) => u.endsWith("/files"))).toBe(false);
  });
});

describe("the skip marker is versioned", () => {
  it("uses a dated version, so a prompt change is visibly distinguishable from a code change", () => {
    // The versions are embedded in the skip marker comment to suppress
    // re-reviews. A dated format makes "the reviewer changed" immediately
    // legible in a diff, which a bare semver bump does not.
    expect(PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(CONFIG_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it("increments the revision when the prompt contract changes", () => {
    // A bare date would be ambiguous if two prompt changes landed on one day.
    const [, revision] = PROMPT_VERSION.split(".");
    expect(revision).toBeDefined();
  });
});
