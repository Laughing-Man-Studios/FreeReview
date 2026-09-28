/**
 * Pull request metadata and changed-file retrieval.
 *
 * The important structural decision: `GET /repos/{o}/{r}/pulls/{n}` returns
 * everything the eligibility gate needs — head SHA, head/base repository
 * identity, repository privacy, PR state, merge state, and change counts — in a
 * single request. The gate therefore costs exactly one API call.
 */

import type { GithubClient } from "./client.js";
import type { FileStatus } from "../types.js";

/**
 * Repository sub-object as it appears in the PR payload.
 *
 * `full_name` is the field that actually distinguishes a same-repository PR
 * from a fork: branch names and `label` are attacker-influenced strings, while
 * `full_name` is GitHub-assigned identity.
 */
export interface PrRepo {
  readonly id: number;
  readonly name: string;
  readonly full_name: string;
  readonly private: boolean;
  readonly owner: { readonly login: string };
  readonly fork: boolean;
}

export interface PrRef {
  readonly label: string;
  readonly ref: string;
  readonly sha: string;
  /**
   * Null when the head repository has been deleted. Treat as an unsupported
   * PR source rather than dereferencing it.
   */
  readonly repo: PrRepo | null;
}

export interface PullRequestMetadata {
  readonly number: number;
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly draft: boolean;
  readonly title: string;
  readonly head: PrRef;
  readonly base: PrRef;
  readonly additions: number;
  readonly deletions: number;
  readonly changed_files: number;
  readonly commits: number;
  /** True when GitHub is still computing mergeability. Unused by us. */
  readonly mergeable: boolean | null;
}

/** One entry of `GET /repos/{o}/{r}/pulls/{n}/files`. */
export interface PrFile {
  readonly sha: string | null;
  readonly filename: string;
  readonly status: FileStatus | "removed" | "changed" | "unchanged";
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  /** The unified diff. Absent for binary files and sometimes truncated. */
  readonly patch?: string;
  readonly previous_filename?: string;
  readonly blob_url: string;
  /** Direct link to the file's content at the PR head. Data, not code. */
  readonly raw_url: string;
}

export function prPath(owner: string, repo: string, pullNumber: number): string {
  return `/repos/${owner}/${repo}/pulls/${pullNumber}`;
}

/**
 * Fetch PR metadata. One call; drives the whole eligibility gate.
 *
 * A 404 here means the PR is invisible to this token, which for a private
 * repository is indistinguishable from "does not exist". Both are reported as
 * an invalid-context action failure rather than a silent skip, because they
 * indicate a misconfigured token.
 */
export async function getPullRequest(
  client: GithubClient,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PullRequestMetadata> {
  return client.get<PullRequestMetadata>(prPath(owner, repo, pullNumber));
}

/**
 * Fetch the current HEAD SHA only.
 *
 * Used for the stale check immediately before publication. Deliberately a
 * separate function from `getPullRequest` so the publication path fetches as
 * little as possible at the last possible moment.
 */
export async function getCurrentHeadSha(
  client: GithubClient,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<string | null> {
  const pr = await getPullRequest(client, owner, repo, pullNumber);
  return pr.head?.sha ?? null;
}

/**
 * Fetch every changed file, following pagination.
 *
 * `patch` is GitHub's unified diff for the file. It can be absent (binary) or
 * shortened (very large files); both are recorded as flags rather than being
 * silently treated as "no changes".
 */
export async function listPullRequestFiles(
  client: GithubClient,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PrFile[]> {
  return client.getAllPages<PrFile>(`${prPath(owner, repo, pullNumber)}/files`);
}

/**
 * Fetch a file's content at the PR head via its `raw_url`.
 *
 * This is how bounded surrounding-code context is obtained without checking out
 * the repository. The content is treated as untrusted data throughout; it is
 * never written to disk and never executed.
 *
 * Deliberately not routed through `GithubClient`: `raw_url` points at
 * `raw.githubusercontent.com`, not `api.github.com`, and returns bytes rather
 * than JSON. It also takes no repository token for public repos, and for
 * private repos the blob is reachable via the same token.
 */
export async function fetchFileContentAtHead(
  file: PrFile,
  options: { maxBytes: number; fetchImpl?: typeof fetch },
): Promise<string | null> {
  const doFetch = options.fetchImpl ?? fetch;

  // Abort before transferring a huge body rather than after.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await doFetch(file.raw_url, { signal: controller.signal });
    if (!response.ok) return null;

    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) return null;

    const text = await response.text();
    return text.length > options.maxBytes ? null : text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
