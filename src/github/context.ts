/**
 * GitHub Actions event context parsing.
 *
 * Everything read here is available from the environment without a single API
 * call, which is why the eligibility gate can be cheap.
 *
 * `GITHUB_EVENT_PATH` is a file the runner wrote containing the raw webhook
 * payload. It is the authoritative statement of *which event fired*; inferring
 * the event type from `GITHUB_REF` instead would be guesswork.
 */

import { readFileSync } from "node:fs";
import type { DiagnosticCode } from "../diagnostics.js";

/** PR events this action reviews. */
export const SUPPORTED_PR_EVENTS: ReadonlySet<string> = new Set([
  "opened",
  "reopened",
  "synchronize",
]);

export interface EventContext {
  readonly eventName: string;
  readonly action: string;
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  /**
   * The head SHA from the event payload. Treated as a hint only: it is
   * re-fetched from the API, because a `synchronize` event's payload can
   * already be stale by the time the job starts.
   */
  readonly eventHeadSha: string | null;
}

export type EventContextResult =
  | { readonly ok: true; readonly context: EventContext }
  | { readonly ok: false; readonly code: DiagnosticCode; readonly detail: string };

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Parse the event payload.
 *
 * Returns a `DiagnosticCode` rather than throwing so the caller can report the
 * precise reason the run could not start. All of these are `INVALID_GITHUB_CONTEXT`
 * except an unsupported event, which is a normal skip.
 */
export function parseEventContext(env: NodeJS.ProcessEnv = process.env): EventContextResult {
  const eventName = asString(env["GITHUB_EVENT_NAME"]);
  if (eventName === null) {
    return { ok: false, code: "INVALID_GITHUB_CONTEXT", detail: "GITHUB_EVENT_NAME is not set." };
  }

  if (eventName !== "pull_request") {
    return {
      ok: false,
      code: "UNSUPPORTED_EVENT",
      detail: `This action only runs on 'pull_request'. Got '${eventName}'.`,
    };
  }

  const eventPath = asString(env["GITHUB_EVENT_PATH"]);
  if (eventPath === null) {
    return { ok: false, code: "INVALID_GITHUB_CONTEXT", detail: "GITHUB_EVENT_PATH is not set." };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(eventPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unparseable JSON";
    return {
      ok: false,
      code: "INVALID_GITHUB_CONTEXT",
      detail: `Could not read the event payload at GITHUB_EVENT_PATH: ${detail}`,
    };
  }

  if (typeof payload !== "object" || payload === null) {
    return { ok: false, code: "INVALID_GITHUB_CONTEXT", detail: "Event payload is not an object." };
  }

  const root = payload as Record<string, unknown>;
  const action = asString(root["action"]);

  const repository = root["repository"];
  if (typeof repository !== "object" || repository === null) {
    return {
      ok: false,
      code: "INVALID_GITHUB_CONTEXT",
      detail: "Event payload has no repository object.",
    };
  }
  const repoObj = repository as Record<string, unknown>;
  const owner = asString((repoObj["owner"] as Record<string, unknown> | undefined)?.["login"]);
  const repo = asString(repoObj["name"]);

  if (owner === null || repo === null) {
    return {
      ok: false,
      code: "INVALID_GITHUB_CONTEXT",
      detail: "Event payload repository is missing owner.login or name.",
    };
  }

  const pullRequest = root["pull_request"];
  if (typeof pullRequest !== "object" || pullRequest === null) {
    return {
      ok: false,
      code: "INVALID_GITHUB_CONTEXT",
      detail: "Event payload has no pull_request object.",
    };
  }
  const prObj = pullRequest as Record<string, unknown>;
  const pullNumber = asNumber(prObj["number"]);

  if (pullNumber === null) {
    return {
      ok: false,
      code: "INVALID_GITHUB_CONTEXT",
      detail: "Event payload pull_request.number is missing or not a number.",
    };
  }

  const head = prObj["head"];
  const eventHeadSha = asString(
    (typeof head === "object" && head !== null ? (head as Record<string, unknown>) : {})["sha"],
  );

  return {
    ok: true,
    context: { eventName, action: action ?? "", owner, repo, pullNumber, eventHeadSha },
  };
}
