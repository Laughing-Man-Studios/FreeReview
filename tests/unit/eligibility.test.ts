import { describe, expect, it } from "vitest";
import type { EventContext } from "../../src/github/context.js";
import type { PullRequestMetadata } from "../../src/github/pr.js";
import { evaluateEligibility } from "../../src/pipeline/eligibility.js";

const OWNER = "acme";
const REPO = "widgets";
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);

function repo(fullName: string, isPrivate = true, isFork = false) {
  const [owner, name] = fullName.split("/");
  return {
    id: 1,
    name: name ?? "",
    full_name: fullName,
    private: isPrivate,
    owner: { login: owner ?? "" },
    fork: isFork,
  } as const;
}

function pr(overrides: Partial<PullRequestMetadata> = {}): PullRequestMetadata {
  return {
    number: 42,
    state: "open",
    merged: false,
    draft: false,
    title: "Add widget factory",
    head: { label: `${OWNER}:feature`, ref: "feature", sha: HEAD_SHA, repo: repo(`${OWNER}/${REPO}`) },
    base: { label: `${OWNER}:main`, ref: "main", sha: BASE_SHA, repo: repo(`${OWNER}/${REPO}`) },
    additions: 10,
    deletions: 2,
    changed_files: 1,
    commits: 1,
    mergeable: true,
    ...overrides,
  };
}

function event(overrides: Partial<EventContext> = {}): EventContext {
  return {
    eventName: "pull_request",
    action: "opened",
    owner: OWNER,
    repo: REPO,
    pullNumber: 42,
    eventHeadSha: HEAD_SHA,
    ...overrides,
  };
}

function evaluate(overrides: Partial<Parameters<typeof evaluateEligibility>[0]> = {}) {
  return evaluateEligibility({
    event: event(),
    pr: pr(),
    promptVersion: "test-prompt",
    configVersion: "test-config",
    ...overrides,
  });
}

describe("evaluateEligibility — the happy path", () => {
  it("accepts a same-repository private PR on a supported event", () => {
    const result = evaluate();
    expect(result.eligible).toBe(true);
  });

  it("captures the immutable review identity", () => {
    const result = evaluate();
    if (!result.eligible) throw new Error("expected eligible");

    expect(result.identity).toEqual({
      owner: OWNER,
      repo: REPO,
      pullNumber: 42,
      baseSha: BASE_SHA,
      reviewHeadSha: HEAD_SHA,
      promptVersion: "test-prompt",
      configVersion: "test-config",
    });
  });

  it("uses the API's head SHA, not the event payload's", () => {
    const result = evaluate({ event: event({ eventHeadSha: "stale".repeat(8) }) });
    if (!result.eligible) throw new Error("expected eligible");
    expect(result.identity.reviewHeadSha).toBe(HEAD_SHA);
  });

  it("reports total changed lines and file count for the size gate", () => {
    const result = evaluate({ pr: pr({ additions: 300, deletions: 45, changed_files: 7 }) });
    if (!result.eligible) throw new Error("expected eligible");
    expect(result.totalChangedLines).toBe(345);
    expect(result.changedFileCount).toBe(7);
  });

  it.each(["opened", "reopened", "synchronize"])("accepts the '%s' event", (action) => {
    expect(evaluate({ event: event({ action }) }).eligible).toBe(true);
  });
});

describe("evaluateEligibility — unsupported events are a non-blocking skip", () => {
  it.each(["closed", "reopened", "labeled", "assigned", "edited", "ready_for_review", ""])(
    "skips the '%s' event",
    (action) => {
      const result = evaluate({ event: event({ action: action === "reopened" ? "closed" : action }) });
      expect(result.eligible).toBe(false);
      if (result.eligible) return;
      expect(result.diagnostic.code).toBe("UNSUPPORTED_EVENT");
      expect(result.diagnostic.severity).toBe("expected");
    },
  );
});

describe("evaluateEligibility — fork PRs are never sent to a provider", () => {
  it("skips a fork PR identified by differing repository identity", () => {
    const result = evaluate({
      pr: pr({
        head: { label: "contributor:patch", ref: "patch", sha: HEAD_SHA, repo: repo("contributor/widgets", true, true) },
      }),
    });

    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.diagnostic.code).toBe("UNSUPPORTED_PR_SOURCE");
    expect(result.diagnostic.severity).toBe("expected");
  });

  it("records both repository identities for the audit trail", () => {
    const result = evaluate({
      pr: pr({
        head: { label: "x:y", ref: "y", sha: HEAD_SHA, repo: repo("contributor/widgets", true, true) },
      }),
    });
    if (result.eligible) throw new Error("expected ineligible");
    expect(result.diagnostic.context).toMatchObject({
      head_repo: "contributor/widgets",
      base_repo: `${OWNER}/${REPO}`,
    });
  });

  it("does not trust a matching branch name as proof of provenance", () => {
    // head.label is "<owner>:<ref>". A fork from an org member could be labelled
    // "acme:main" while living in another repository. Only full_name is
    // trustworthy, so this must still be skipped.
    const result = evaluate({
      pr: pr({
        head: {
          label: `${OWNER}:feature`,
          ref: "feature",
          sha: HEAD_SHA,
          repo: repo("attacker/widgets", true, true),
        },
      }),
    });
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.diagnostic.code).toBe("UNSUPPORTED_PR_SOURCE");
  });

  it("does not trust matching owner names when the repository differs", () => {
    const result = evaluate({
      pr: pr({
        head: { label: `${OWNER}:x`, ref: "x", sha: HEAD_SHA, repo: repo(`${OWNER}-evil/widgets`, true, true) },
      }),
    });
    expect(result.eligible).toBe(false);
  });

  it("skips a PR whose head repository has been deleted", () => {
    const result = evaluate({
      pr: pr({
        head: { label: "gone:main", ref: "main", sha: HEAD_SHA, repo: null },
      }),
    });
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.diagnostic.code).toBe("UNSUPPORTED_PR_SOURCE");
  });
});

describe("evaluateEligibility — private-repository-only default", () => {
  it("skips a public base repository", () => {
    const result = evaluate({
      pr: pr({ base: { label: `${OWNER}:main`, ref: "main", sha: BASE_SHA, repo: repo(`${OWNER}/${REPO}`, false) } }),
    });
    expect(result.eligible).toBe(false);
    if (result.eligible) return;
    expect(result.diagnostic.code).toBe("PUBLIC_REPOSITORY");
    expect(result.diagnostic.severity).toBe("expected");
  });

  it("checks the BASE repository's privacy, not the head's", () => {
    // A private fork PR into a public base is still a public-repo review.
    const result = evaluate({
      pr: pr({
        base: { label: `${OWNER}:main`, ref: "main", sha: BASE_SHA, repo: repo(`${OWNER}/${REPO}`, false) },
        head: { label: `${OWNER}:f`, ref: "f", sha: HEAD_SHA, repo: repo(`${OWNER}/widgets`, true) },
      }),
    });
    if (result.eligible) throw new Error("expected ineligible");
    expect(result.diagnostic.code).toBe("PUBLIC_REPOSITORY");
  });
});

describe("evaluateEligibility — PR state", () => {
  it("skips a merged PR", () => {
    const result = evaluate({ pr: pr({ merged: true, state: "closed" }) });
    if (result.eligible) throw new Error("expected ineligible");
    expect(result.diagnostic.code).toBe("PR_ALREADY_MERGED");
  });

  it("skips a closed PR", () => {
    const result = evaluate({ pr: pr({ state: "closed" }) });
    if (result.eligible) throw new Error("expected ineligible");
    expect(result.diagnostic.code).toBe("PR_CLOSED");
  });

  it("skips a draft PR", () => {
    const result = evaluate({ pr: pr({ draft: true }) });
    if (result.eligible) throw new Error("expected ineligible");
    expect(result.diagnostic.code).toBe("DRAFT_PR");
  });

  it("every state-based skip is non-blocking", () => {
    for (const [label, overrides] of [
      ["merged", { merged: true, state: "closed" as const }],
      ["closed", { state: "closed" as const }],
      ["draft", { draft: true }],
    ] as const) {
      const result = evaluate({ pr: pr(overrides) });
      if (result.eligible) throw new Error(`${label} should be ineligible`);
      expect(result.diagnostic.severity, label).toBe("expected");
    }
  });
});

describe("evaluateEligibility — structural failures are action failures", () => {
  it("fails when the head SHA is absent", () => {
    const base = pr();
    const result = evaluate({
      pr: { ...base, head: { ...base.head, sha: "" } },
    });
    if (result.eligible) throw new Error("expected ineligible");
    expect(result.diagnostic.code).toBe("INVALID_GITHUB_CONTEXT");
    expect(result.diagnostic.severity).toBe("failure");
  });

  it("fails when the base repository is absent", () => {
    const base = pr();
    const result = evaluate({
      pr: { ...base, base: { ...base.base, repo: null } },
    });
    if (result.eligible) throw new Error("expected ineligible");
    expect(result.diagnostic.code).toBe("INVALID_GITHUB_CONTEXT");
    expect(result.diagnostic.severity).toBe("failure");
  });
});

describe("evaluateEligibility — check ordering", () => {
  it("reports the unsupported event even when the PR is also a fork", () => {
    // The event check runs first, so the operator is told the actionable
    // reason rather than a downstream symptom.
    const result = evaluate({
      event: event({ action: "closed" }),
      pr: pr({
        head: { label: "x:y", ref: "y", sha: HEAD_SHA, repo: repo("other/repo", true, true) },
      }),
    });
    if (result.eligible) throw new Error("expected ineligible");
    expect(result.diagnostic.code).toBe("UNSUPPORTED_EVENT");
  });

  it("reports PR_CLOSED before PUBLIC_REPOSITORY", () => {
    const result = evaluate({
      pr: pr({
        state: "closed",
        base: { label: `${OWNER}:main`, ref: "main", sha: BASE_SHA, repo: repo(`${OWNER}/${REPO}`, false) },
      }),
    });
    if (result.eligible) throw new Error("expected ineligible");
    expect(result.diagnostic.code).toBe("PR_CLOSED");
  });

  it("reports PUBLIC_REPOSITORY before UNSUPPORTED_PR_SOURCE", () => {
    // Both are skips; privacy is the stronger signal so it wins.
    const result = evaluate({
      pr: pr({
        base: { label: `${OWNER}:main`, ref: "main", sha: BASE_SHA, repo: repo(`${OWNER}/${REPO}`, false) },
        head: { label: "x:y", ref: "y", sha: HEAD_SHA, repo: repo("other/repo", true, true) },
      }),
    });
    if (result.eligible) throw new Error("expected ineligible");
    expect(result.diagnostic.code).toBe("PUBLIC_REPOSITORY");
  });
});
