/**
 * Catalog drift check.
 *
 * ## Why this exists
 *
 * The default pool is third-party data we do not control. If `inclusionai/ling`
 * disappears from OpenRouter's free catalog, every consumer of this action stops
 * getting a primary model, and nothing in their CI says why — their config and
 * our config are both unchanged.
 *
 * The action degrades correctly: a 404 falls through to the next model, and if the
 * pool empties the run reports `NO_ELIGIBLE_MODEL` rather than a clean review. That
 * is the right runtime behaviour. It is not a reason to leave nobody watching.
 *
 * ## What is checked, and why each check earns its place
 *
 *  - **Exists and is `:free`** — the two conditions that make it eligible at all.
 *  - **Prices at zero** — the project sends `provider.max_price: 0`, so a model
 *    whose free tier quietly became paid would return no endpoint rather than
 *    billing anyone. Worth knowing before users hit it, not after.
 *  - **Declares its declared capability** — the check that found the production
 *    bug. OpenRouter's `supported_parameters` is a union across endpoints and can
 *    be stale, which is how `qwen` came to route to a mode that 404s.
 *
 * ## Why it reports rather than fails
 *
 * A free catalog drifting is not our outage. Failing would turn every consumer's CI
 * red for something they cannot fix and did not cause. The signal belongs in an
 * issue and a step summary, where a human decides.
 */

import { fetchCatalog, type CatalogModel } from "../src/llm/catalog.js";
import { DEFAULT_MODELS, reviewModeFor } from "../src/config.js";
import type { ModelDefinition } from "../src/config.js";

export interface Finding {
  readonly modelId: string;
  readonly kind: "missing" | "not-free" | "priced" | "capability" | "context";
  /**
   * `actionable` means our configuration is wrong and can be corrected from the
   * catalog alone. `remeasure` means the catalog has moved and our *measured*
   * value is now stale — which is not the same thing, and acting on the catalog
   * would break a working configuration.
   *
   * The distinction is not cosmetic. OpenRouter's `supported_parameters` is a
   * union across endpoints and has been observed to be exactly backwards for one
   * model: `qwen/qwen3.8-27b:free` advertises `structured_outputs` — which returns
   * 404 on every request — while omitting `response_format`, which serves fine.
   * Following the advertisement there would have "fixed" a model that works and
   * left the broken mode in place.
   */
  readonly action: "actionable" | "remeasure";
  readonly detail: string;
}

export function check(entry: ModelDefinition, remote: CatalogModel | undefined): Finding[] {
  const problems: Finding[] = [];

  if (remote === undefined) {
    return [
      { modelId: entry.id, kind: "missing", action: "actionable", detail: "not present in GET /api/v1/models" },
    ];
  }

  if (!entry.id.endsWith(":free")) {
    problems.push({
      modelId: entry.id,
      kind: "not-free",
      action: "actionable",
      detail: "catalog id does not end in :free",
    });
  }

  const prompt = remote.pricing?.prompt;
  const completion = remote.pricing?.completion;
  if (prompt !== "0" || completion !== "0") {
    problems.push({
      modelId: entry.id,
      kind: "priced",
      action: "actionable",
      detail: `pricing prompt=${prompt ?? "?"} completion=${completion ?? "?"} — expected both "0"`,
    });
  }

  // The check that found the production bug: the catalog claims a capability the
  // endpoint will not serve.
  const params = new Set(remote.supported_parameters ?? []);
  if (entry.supportsJsonSchema === true && !params.has("structured_outputs")) {
    problems.push({
      modelId: entry.id,
      kind: "capability",
      action: "remeasure",
      detail:
        "catalog claims supportsJsonSchema but the live catalog no longer advertises " +
        "structured_outputs — RE-MEASURE with PROBE_MODE=matrix; do not copy the advertised value",
    });
  }
  if (entry.supportsResponseFormat === true && !params.has("response_format")) {
    problems.push({
      modelId: entry.id,
      kind: "capability",
      action: "remeasure",
      detail:
        "catalog claims supportsResponseFormat but the live catalog does not advertise it — " +
        "RE-MEASURE with PROBE_MODE=matrix; the advertised value has been observed to be wrong",
    });
  }

  const claimedContext = entry.maxContextTokens;
  if (typeof remote.context_length === "number" && claimedContext !== null && remote.context_length < claimedContext) {
    problems.push({
      modelId: entry.id,
      kind: "context",
      action: "remeasure",
      detail: `context_length ${remote.context_length} is below the catalog's ${claimedContext}`,
    });
  }

  return problems;
}

export function format(findings: readonly Finding[]): string {
  return findings
    .map(
      (f) =>
        `- [${f.action}] ${f.kind.padEnd(10)} ${f.modelId}\n              ${f.detail}`,
    )
    .join("\n");
}

/**
 * The pool shrinking is the only condition worth interrupting a human for.
 *
 * A single dead model is absorbed: the action falls back, and the README already
 * documents the chain. Below the fallback count, a provider outage or a catalog
 * change leaves consumers with no review at all.
 */
export const MIN_USABLE_MODELS = 2;

async function main(): Promise<void> {
  // `fetchCatalog` is unauthenticated — the endpoint is public — so this check
  // needs no secret, which means it can also run on a fork without one.
  let remote: Map<string, CatalogModel> | null = null;
  let fetchError: string | null = null;

  try {
    const catalog = await fetchCatalog();
    if (catalog === null) {
      fetchError = "GET /api/v1/models returned a non-OK response";
    } else {
      remote = new Map(catalog.map((entry) => [entry.id, entry]));
    }
  } catch (error) {
    // A failed probe is not a finding. Reporting drift because OpenRouter was
    // briefly unreachable would train people to ignore this workflow.
    fetchError = `probe failed: ${(error as Error).message.split("\n")[0]}`;
  }

  // Structural facts that need no network, so a green run is informative rather
  // than silent — in particular whether strict mode still has any ZDR model,
  // because if that reaches zero the default configuration reviews nothing.
  const enabled = DEFAULT_MODELS.filter((m) => m.enabled);
  const zdr = DEFAULT_MODELS.filter((m) => m.zdrEligible);
  const structural: string[] = [
    `catalog entries: ${DEFAULT_MODELS.length} (${enabled.length} enabled)`,
    `ZDR-capable: ${zdr.length === 0 ? "NONE — strict mode reviews nothing" : zdr.map((m) => m.id).join(", ")}`,
    `measured modes: ${enabled.map((m) => `${m.id.split("/")[1]}=${reviewModeFor(m)}`).join(", ")}`,
    `injection resistance: ${DEFAULT_MODELS.map((m) => `${m.id.split("/")[1]}=${m.injectionResistance ?? "?"}`).join(", ")}`,
  ];

  const findings: Finding[] = [];
  for (const model of DEFAULT_MODELS) {
    findings.push(...check(model, remote?.get(model.id)));
  }

  // A single dead model is absorbed: the action falls back and the README
  // documents the chain. Below the fallback count, a provider outage leaves
  // consumers with no review at all — the only condition worth interrupting for.
  const usable = enabled.length - findings.filter((f) => f.kind === "missing").length;
  // Only `actionable` findings justify editing configuration. A capability
  // mismatch justifies re-measuring, which costs requests and might change
  // nothing.
  const actionable = findings.filter((f) => f.action === "actionable");
  const breaking = usable < MIN_USABLE_MODELS || actionable.length > 0;

  if (findings.length > 0) {
    console.log(
      `\n${findings.length} finding(s): ${actionable.length} actionable, ` +
        `${findings.length - actionable.length} need re-measurement`,
    );
    console.log(format(findings));
  } else {
    console.log("\nno drift detected");
  }

  // Machine-readable outputs for the workflow. Set even on a clean run so the
  // step summary can say what was checked.
  console.log(`\n::set-output name=report::${[...structural, fetchError, findings.length ? format(findings) : "no drift detected"].filter(Boolean).join("\n").replace(/\n/g, "%0A")}`);
  console.log(`::set-output name=breaking::${breaking}`);
}

// Run only when executed directly. Importing this module from a test must not
// fire a network probe, which is the whole reason `check` is exported.
if (import.meta.url === `file://${process.argv[1] ?? ""}`) void main();