import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SUPPORTED_PR_EVENTS, parseEventContext } from "../../src/github/context.js";

/** Write an event payload to a temp file and return the env that points at it. */
function withEvent(payload: unknown, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "freereview-event-"));
  const file = join(dir, "event.json");
  writeFileSync(file, typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  return { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: file, ...extra };
}

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "opened",
    repository: { name: "widgets", owner: { login: "acme" } },
    pull_request: { number: 42, head: { sha: "a".repeat(40) } },
    ...overrides,
  };
}

describe("parseEventContext — happy path", () => {
  it("extracts owner, repo, PR number, action, and head SHA", () => {
    const result = parseEventContext(withEvent(basePayload()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.context).toEqual({
      eventName: "pull_request",
      action: "opened",
      owner: "acme",
      repo: "widgets",
      pullNumber: 42,
      eventHeadSha: "a".repeat(40),
    });
  });

  it("handles every supported event action", () => {
    for (const action of SUPPORTED_PR_EVENTS) {
      const result = parseEventContext(withEvent(basePayload({ action })));
      expect(result.ok, action).toBe(true);
      if (result.ok) expect(result.context.action).toBe(action);
    }
  });

  it("reports a missing head SHA as null rather than failing", () => {
    // The event head SHA is a hint only; it is re-fetched from the API.
    const result = parseEventContext(
      withEvent(basePayload({ pull_request: { number: 42 } })),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.context.eventHeadSha).toBeNull();
  });
});

describe("parseEventContext — unsupported event is a non-blocking skip", () => {
  it.each(["push", "issue_comment", "pull_request_target", "schedule", "workflow_dispatch"])(
    "reports UNSUPPORTED_EVENT for '%s'",
    (eventName) => {
      const result = parseEventContext({ GITHUB_EVENT_NAME: eventName });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("UNSUPPORTED_EVENT");
    },
  );

  it("fails when GITHUB_EVENT_NAME is absent", () => {
    const result = parseEventContext({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_GITHUB_CONTEXT");
  });
});

describe("parseEventContext — malformed context is an action failure", () => {
  it("reports unparseable JSON", () => {
    const result = parseEventContext(withEvent("{not json"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_GITHUB_CONTEXT");
    expect(result.detail).toMatch(/event payload/i);
  });

  it("reports a missing GITHUB_EVENT_PATH", () => {
    const result = parseEventContext({ GITHUB_EVENT_NAME: "pull_request" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_GITHUB_CONTEXT");
  });

  it.each([
    ["no repository object", { action: "opened", pull_request: { number: 1 } }],
    ["no pull_request object", { action: "opened", repository: { name: "w", owner: { login: "a" } } }],
    ["missing repo name", { action: "opened", repository: { owner: { login: "a" } }, pull_request: { number: 1 } }],
    [
      "missing owner login",
      { action: "opened", repository: { name: "w" }, pull_request: { number: 1 } },
    ],
    [
      "missing PR number",
      { action: "opened", repository: { name: "w", owner: { login: "a" } }, pull_request: {} },
    ],
    [
      "non-numeric PR number",
      {
        action: "opened",
        repository: { name: "w", owner: { login: "a" } },
        pull_request: { number: "42" },
      },
    ],
  ])("reports a payload with %s", (_label, payload) => {
    const result = parseEventContext(withEvent(payload));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_GITHUB_CONTEXT");
  });

  it("reports a JSON payload that is not an object", () => {
    const result = parseEventContext(withEvent("[1,2,3]"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_GITHUB_CONTEXT");
  });

  it("never echoes an unbounded payload fragment into the diagnostic", () => {
    // A parse error message can contain a fragment of the input. The event
    // payload is not source code, but it can contain a PR title chosen by
    // anyone who can open a PR, so details are bounded.
    const result = parseEventContext(withEvent("{".repeat(5_000)));
    if (result.ok) return;
    expect(result.detail.length).toBeLessThan(500);
  });
});
