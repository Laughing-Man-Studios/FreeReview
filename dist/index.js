'use strict';

var fs = require('fs');

// src/run.ts

// src/config.ts
var DEFAULT_MODELS = [
  {
    id: "qwen/qwen3.8-27b:free",
    enabled: true,
    priority: 0,
    maxContextTokens: 262144,
    supportsResponseFormat: true,
    supportsJsonSchema: true,
    privacyEligible: true
  },
  {
    // Structured-output capable, 262k context. The strongest structured-output
    // fallback in the free catalog as of 2026-09-27.
    id: "nvidia/nemotron-3-super-120b-a12b:free",
    enabled: true,
    priority: 1,
    maxContextTokens: 262144,
    supportsResponseFormat: true,
    supportsJsonSchema: true,
    privacyEligible: true
  },
  {
    id: "liquid/lfm-2.5-2.6b:free",
    enabled: true,
    priority: 2,
    maxContextTokens: 65536,
    supportsResponseFormat: true,
    supportsJsonSchema: true,
    privacyEligible: true
  },
  {
    // Exposes `response_format` but NOT `structured_outputs`, so it cannot be
    // used with json_schema under `require_parameters: true`. Selects
    // JSON_OBJECT mode. Small context window.
    id: "google/gemma-4-31b-it:free",
    enabled: true,
    priority: 3,
    maxContextTokens: 262144,
    supportsResponseFormat: true,
    supportsJsonSchema: false,
    privacyEligible: true
  },
  {
    // No response_format at all. Selects PROMPT_JSON mode with defensive
    // parsing. 1M context, but no structured-output guarantee.
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    enabled: true,
    priority: 4,
    maxContextTokens: 1e6,
    supportsResponseFormat: false,
    supportsJsonSchema: false,
    privacyEligible: true
  },
  {
    // Excluded by default: OpenRouter documents that free usage may be used to
    // train and improve Poolside models. Retained in code (not removed) so the
    // model remains available to `privacy_mode: relaxed`.
    id: "poolside/laguna-s-2.1:free",
    enabled: false,
    priority: 5,
    maxContextTokens: 262144,
    supportsResponseFormat: false,
    supportsJsonSchema: false,
    privacyEligible: false
  },
  {
    // Excluded by default: the free Inkling endpoint documents that prompts and
    // outputs are logged and used to improve Thinking Machines Lab models.
    id: "thinkingmachines/inkling-small:free",
    enabled: false,
    priority: 6,
    maxContextTokens: 1048576,
    supportsResponseFormat: false,
    supportsJsonSchema: false,
    privacyEligible: false
  }
];
var ConfigError = class extends Error {
  constructor(input, detail) {
    super(`Invalid configuration for input '${input}': ${detail}`);
    this.input = input;
    this.detail = detail;
    this.name = "ConfigError";
  }
  input;
  detail;
};
var FREE_MODEL_ID_PATTERN = /^[a-z0-9._-]+\/[a-z0-9._-]+:free$/;
function assertFreeModelId(id, input) {
  if (!FREE_MODEL_ID_PATTERN.test(id)) {
    throw new ConfigError(
      input,
      `'${id}' is not a valid free model ID. Must match ${FREE_MODEL_ID_PATTERN} (lowercase author/slug ending in ':free'). This action never routes to a paid model.`
    );
  }
}
function readRaw(env, name) {
  const raw = env[`INPUT_${name.toUpperCase()}`];
  if (raw === void 0) return void 0;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
function readInt(env, name, fallback, { min, max }) {
  const raw = readRaw(env, name);
  if (raw === void 0) return fallback;
  if (!/^-?\d+$/.test(raw)) {
    throw new ConfigError(name, `'${raw}' is not an integer.`);
  }
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) {
    throw new ConfigError(name, `${value} is outside the allowed range [${min}, ${max}].`);
  }
  return value;
}
function readBool(env, name, fallback) {
  const raw = readRaw(env, name)?.toLowerCase();
  if (raw === void 0) return fallback;
  if (["true", "yes", "1", "on"].includes(raw)) return true;
  if (["false", "no", "0", "off"].includes(raw)) return false;
  throw new ConfigError(name, `'${raw}' is not a boolean. Use true or false.`);
}
function readPrivacyMode(env) {
  const raw = readRaw(env, "privacy_mode")?.toLowerCase() ?? "strict";
  if (raw === "strict" || raw === "relaxed") return raw;
  throw new ConfigError("privacy_mode", `'${raw}' is not a valid mode. Use strict or relaxed.`);
}
function parseModelList(value, input) {
  if (value === void 0) return void 0;
  const ids = value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return ids.map((id, index) => {
    assertFreeModelId(id, input);
    return {
      id,
      enabled: true,
      priority: index,
      maxContextTokens: null,
      supportsResponseFormat: null,
      supportsJsonSchema: null,
      // Unknown until the runtime catalog probe. An unverified model is
      // treated as eligible in strict mode only if the request-time ZDR and
      // data_collection constraints can be satisfied — which OpenRouter
      // enforces, not us. A 503/404 means no endpoint qualified.
      privacyEligible: true
    };
  });
}
function debugPayloadsFromEnv(env = process.env) {
  try {
    return readBool(env, "debug_payloads", false);
  } catch {
    return false;
  }
}
function loadConfig(env = process.env) {
  const openrouterApiKey = readRaw(env, "openrouter_api_key");
  if (openrouterApiKey === void 0) {
    throw new ConfigError(
      "openrouter_api_key",
      "Required input is missing. Set the OPENROUTER_API_KEY repository secret and pass it as `openrouter_api_key`."
    );
  }
  const privacyMode = readPrivacyMode(env);
  const configuredPrimary = readRaw(env, "primary_model");
  const configuredFallbacks = parseModelList(readRaw(env, "fallback_models"), "fallback_models");
  let models;
  if (configuredPrimary === void 0 && configuredFallbacks === void 0) {
    models = [...DEFAULT_MODELS];
  } else {
    const primaryId = configuredPrimary ?? DEFAULT_MODELS[0]?.id;
    if (primaryId === void 0) {
      throw new ConfigError("primary_model", "No default primary model is configured.");
    }
    assertFreeModelId(primaryId, "primary_model");
    const primary = {
      id: primaryId,
      enabled: true,
      priority: 0,
      maxContextTokens: null,
      supportsResponseFormat: null,
      supportsJsonSchema: null,
      privacyEligible: true
    };
    const fallbackIds = configuredFallbacks ?? [];
    models = [
      primary,
      ...fallbackIds.map((f, index) => {
        const known = DEFAULT_MODELS.find((m) => m.id === f.id);
        return {
          id: f.id,
          enabled: true,
          priority: index + 1,
          maxContextTokens: known?.maxContextTokens ?? null,
          supportsResponseFormat: known?.supportsResponseFormat ?? null,
          supportsJsonSchema: known?.supportsJsonSchema ?? null,
          privacyEligible: known?.privacyEligible ?? true
        };
      })
    ];
  }
  const maxInputTokens = readInt(env, "max_input_tokens", 24e3, { min: 1e3, max: 4e5 });
  const maxOutputTokens = readInt(env, "max_output_tokens", 1500, { min: 256, max: 32e3 });
  const maxChangedLines = readInt(env, "max_changed_lines", 2e3, { min: 1, max: 1e5 });
  const config = {
    openrouterApiKey,
    privacyMode,
    models,
    maxChangedLines,
    maxInputTokens,
    maxOutputTokens,
    maxRequestsPerRun: readInt(env, "max_requests_per_run", 8, { min: 1, max: 50 }),
    maxConcurrency: readInt(env, "max_concurrency", 2, { min: 1, max: 4 }),
    // Stay under OpenRouter's documented 20 RPM free-model cap.
    maxRequestsPerMinute: 15,
    maxRetriesPerRequest: 1,
    maxFindingsPerChunk: readInt(env, "max_findings_per_chunk", 5, { min: 1, max: 20 }),
    includeSuggestions: readBool(env, "include_suggestions", false),
    debugPayloads: readBool(env, "debug_payloads", false),
    dailyReserve: 10,
    charsPerToken: 3.2,
    tokenSafetyMultiplier: 1.25,
    requestTimeoutMs: 12e4,
    runBudgetMs: 8 * 6e4,
    referer: "https://github.com/Laughing-Man-Studios/FreeReview",
    title: "FreeReview"
  };
  validateConfig(config);
  return config;
}
function validateConfig(config) {
  if (config.models.length === 0) {
    throw new ConfigError("primary_model", "At least one model must be configured.");
  }
  const seen = /* @__PURE__ */ new Set();
  for (const model of config.models) {
    assertFreeModelId(model.id, "primary_model");
    if (seen.has(model.id)) {
      throw new ConfigError("fallback_models", `Duplicate model '${model.id}'.`);
    }
    seen.add(model.id);
  }
  if (config.privacyMode === "strict" && !config.models.some((m) => m.enabled)) {
    throw new ConfigError(
      "primary_model",
      "No enabled model remains. Strict privacy mode requires at least one privacy-eligible model."
    );
  }
  for (const model of config.models) {
    if (model.maxContextTokens === null) continue;
    const needed = config.maxInputTokens + config.maxOutputTokens;
    if (needed > model.maxContextTokens) {
      throw new ConfigError(
        "max_input_tokens",
        `Model '${model.id}' has a ${model.maxContextTokens}-token context window, but max_input_tokens (${config.maxInputTokens}) + max_output_tokens (${config.maxOutputTokens}) = ${needed}. Lower the token budgets or use a model with a larger window.`
      );
    }
  }
}

// src/diagnostics.ts
var ACTION_FAILURE_CODES = /* @__PURE__ */ new Set([
  "CONFIG_INVALID",
  "MISSING_CREDENTIALS",
  "INVALID_GITHUB_CONTEXT",
  "DIFF_PARSE_FAILED",
  "OPENROUTER_AUTH_FAILED",
  "INTERNAL_ERROR"
]);
function severityOf(code) {
  return ACTION_FAILURE_CODES.has(code) ? "failure" : "expected";
}
function diagnostic(code, message, context) {
  return { code, severity: severityOf(code), message, ...context ? { context } : {} };
}
function escapeForLog(value) {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function formatDiagnostic(d) {
  const parts = [`[${d.code}]`, d.message];
  if (d.context) {
    const rendered = Object.entries(d.context).filter(([, v]) => v !== void 0).map(([k, v]) => `${k}=${String(v)}`);
    if (rendered.length > 0) parts.push(`(${rendered.join(" ")})`);
  }
  return parts.join(" ");
}
var SECRET_PATTERNS = [
  // OpenAI / OpenRouter style
  /sk-[A-Za-z0-9_-]{16,}/g,
  // GitHub tokens
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  // AWS access key ids
  /AKIA[0-9A-Z]{16}/g,
  // Google API keys
  /AIza[0-9A-Za-z_-]{30,}/g,
  // Slack
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  // GitLab
  /glpat-[A-Za-z0-9_-]{16,}/g
];
function redactSecrets(value) {
  let out = value;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}
function renderValue(value) {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value) ?? "[unserialisable]";
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return value.toString();
  return "";
}
function sanitize(fields) {
  if (!fields) return {};
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === void 0) continue;
    out[key] = redactSecrets(renderValue(value));
  }
  return out;
}
function formatLine(level, message, fields) {
  const safe = redactSecrets(message);
  const extras = sanitize(fields);
  const rendered = Object.entries(extras).map(([k, v]) => `${k}=${v}`).join(" ");
  return rendered ? `${level} ${safe} ${rendered}` : `${level} ${safe}`;
}
function firstLine(value) {
  const line = value.split("\n", 1)[0] ?? value;
  return line.length > 400 ? `${line.slice(0, 400)}\u2026` : line;
}
function createLogger(opts) {
  const debugEnabled = opts?.debug ?? process.env["RUNNER_DEBUG"] === "1";
  const diagnostics = [];
  const emit = (level, command, message, fields) => {
    const line = formatLine(level, message, fields);
    if (command) {
      process.stdout.write(`${command}::${escapeForLog(line)}
`);
    } else {
      process.stdout.write(`${escapeForLog(line)}
`);
    }
  };
  const logger = {
    info: (message, fields) => emit("info", "", message, fields),
    warn: (message, fields) => emit("warn", "", message, fields),
    error: (message, fields) => emit("error", "::error", firstLine(message), fields),
    annotation: (message, fields) => emit("warning", "::warning", firstLine(message), fields),
    debug: (message, fields) => {
      if (debugEnabled) emit("debug", "", message, fields);
    },
    record: (d) => {
      diagnostics.push(d);
      emit(d.severity === "failure" ? "error" : "warning", "", formatDiagnostic(d));
    },
    log: (code, message, context) => {
      const d = diagnostic(code, message, context);
      logger.record(d);
      return d;
    },
    get diagnostics() {
      return diagnostics;
    },
    counts: () => {
      const out = {};
      for (const d of diagnostics) out[d.code] = (out[d.code] ?? 0) + 1;
      return out;
    }
  };
  return logger;
}

// src/github/client.ts
var API_BASE = "https://api.github.com";
var GITHUB_API_VERSION = "2026-03-10";
var ACCEPT_JSON = "application/vnd.github+json";
var GithubError = class extends Error {
  constructor(kind, status, message, retryAfterSeconds) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.name = "GithubError";
  }
  kind;
  status;
  retryAfterSeconds;
  /** Whether a bounded retry has any chance of succeeding. */
  get retryable() {
    return this.kind === "rate_limited" || this.kind === "server";
  }
  /**
   * Whether this is GitHub's *secondary* rate limit (abuse detection) rather
   * than the primary hourly quota. Secondary limits apply to content-creating
   * endpoints and carry a `Retry-After`.
   */
  get isSecondaryRateLimit() {
    return this.status === 403 && this.retryAfterSeconds !== void 0;
  }
};
var defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
function classify(status, body, retryAfterHeader) {
  const message = typeof body === "object" && body !== null && "message" in body ? String(body.message) : `GitHub API returned ${status}`;
  const parsedRetryAfter = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : Number.NaN;
  const retryAfter = Number.isFinite(parsedRetryAfter) ? parsedRetryAfter : void 0;
  let kind;
  if (status === 401) {
    kind = "forbidden";
  } else if (status === 403) {
    kind = retryAfter !== void 0 ? "rate_limited" : "forbidden";
  } else if (status === 429) {
    kind = "rate_limited";
  } else if (status === 404 || status === 410) {
    kind = "not_found";
  } else if (status >= 500) {
    kind = "server";
  } else {
    kind = "client";
  }
  return new GithubError(kind, status, message, retryAfter);
}
var GithubClient = class {
  token;
  sleep;
  maxRetries;
  fetchImpl;
  baseUrl;
  userAgent;
  /** Wall-clock budget so a hung GitHub cannot stall the whole run. */
  constructor(options) {
    this.token = options.token;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRetries = options.maxRetries ?? 3;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? API_BASE;
    this.userAgent = options.userAgent ?? "FreeReview";
  }
  headers(accept) {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: accept,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": this.userAgent
    };
  }
  /**
   * Idempotent GET with bounded exponential backoff.
   *
   * Retries only `retryable` errors. A 404 is never retried: if the PR is not
   * visible to this token, waiting will not change that.
   */
  async get(path, options) {
    const url = `${this.baseUrl}${path}`;
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      let response;
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          headers: this.headers(options?.accept ?? ACCEPT_JSON)
        });
      } catch (cause) {
        if (attempt === this.maxRetries) throw cause;
        await this.sleep(backoffMs(attempt));
        continue;
      }
      if (response.ok) {
        return await response.json();
      }
      const body = await safeJson(response);
      const error = classify(response.status, body, response.headers.get("retry-after"));
      lastError = error;
      if (!error.retryable || attempt === this.maxRetries) {
        throw error;
      }
      const waitMs = error.retryAfterSeconds !== void 0 ? Math.min(error.retryAfterSeconds * 1e3, 6e4) : backoffMs(attempt);
      await this.sleep(waitMs);
    }
    throw lastError ?? new GithubError("server", 0, "GitHub request failed with no response");
  }
  /**
   * POST with NO automatic retry.
   *
   * Content-creating endpoints (review creation) trigger secondary rate limits
   * and a retried POST can duplicate a review. Retry policy for publication
   * lives in `github/publish.ts` where it can be explicit about idempotency.
   */
  async post(path, body) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { ...this.headers(ACCEPT_JSON), "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (response.ok) return await response.json();
    const payload = await safeJson(response);
    throw classify(response.status, payload, response.headers.get("retry-after"));
  }
  /**
   * Follow GitHub pagination to completion, with a hard page cap.
   *
   * The cap exists so a pathological response cannot spin forever. `pulls/{n}/files`
   * documents a 3000-file maximum, so 30 pages of 100 is the true ceiling.
   */
  async getAllPages(path, options) {
    const perPage = options?.perPage ?? 100;
    const maxPages = options?.maxPages ?? 40;
    const separator = path.includes("?") ? "&" : "?";
    const out = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const batch = await this.get(
        `${path}${separator}per_page=${perPage}&page=${page}`
      );
      if (!Array.isArray(batch) || batch.length === 0) break;
      out.push(...batch);
      if (batch.length < perPage) break;
    }
    return out;
  }
};
function backoffMs(attempt) {
  const base = Math.min(2 ** attempt * 250, 8e3);
  return base / 2 + Math.random() * (base / 2);
}
async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
var SUPPORTED_PR_EVENTS = /* @__PURE__ */ new Set([
  "opened",
  "reopened",
  "synchronize"
]);
function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function parseEventContext(env = process.env) {
  const eventName = asString(env["GITHUB_EVENT_NAME"]);
  if (eventName === null) {
    return { ok: false, code: "INVALID_GITHUB_CONTEXT", detail: "GITHUB_EVENT_NAME is not set." };
  }
  if (eventName !== "pull_request") {
    return {
      ok: false,
      code: "UNSUPPORTED_EVENT",
      detail: `This action only runs on 'pull_request'. Got '${eventName}'.`
    };
  }
  const eventPath = asString(env["GITHUB_EVENT_PATH"]);
  if (eventPath === null) {
    return { ok: false, code: "INVALID_GITHUB_CONTEXT", detail: "GITHUB_EVENT_PATH is not set." };
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unparseable JSON";
    return {
      ok: false,
      code: "INVALID_GITHUB_CONTEXT",
      detail: `Could not read the event payload at GITHUB_EVENT_PATH: ${detail}`
    };
  }
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, code: "INVALID_GITHUB_CONTEXT", detail: "Event payload is not an object." };
  }
  const root = payload;
  const action = asString(root["action"]);
  const repository = root["repository"];
  if (typeof repository !== "object" || repository === null) {
    return {
      ok: false,
      code: "INVALID_GITHUB_CONTEXT",
      detail: "Event payload has no repository object."
    };
  }
  const repoObj = repository;
  const owner = asString(repoObj["owner"]?.["login"]);
  const repo = asString(repoObj["name"]);
  if (owner === null || repo === null) {
    return {
      ok: false,
      code: "INVALID_GITHUB_CONTEXT",
      detail: "Event payload repository is missing owner.login or name."
    };
  }
  const pullRequest = root["pull_request"];
  if (typeof pullRequest !== "object" || pullRequest === null) {
    return {
      ok: false,
      code: "INVALID_GITHUB_CONTEXT",
      detail: "Event payload has no pull_request object."
    };
  }
  const prObj = pullRequest;
  const pullNumber = asNumber(prObj["number"]);
  if (pullNumber === null) {
    return {
      ok: false,
      code: "INVALID_GITHUB_CONTEXT",
      detail: "Event payload pull_request.number is missing or not a number."
    };
  }
  const head = prObj["head"];
  const eventHeadSha = asString(
    (typeof head === "object" && head !== null ? head : {})["sha"]
  );
  return {
    ok: true,
    context: { eventName, action: action ?? "", owner, repo, pullNumber, eventHeadSha }
  };
}

// src/github/pr.ts
function prPath(owner, repo, pullNumber) {
  return `/repos/${owner}/${repo}/pulls/${pullNumber}`;
}
async function getPullRequest(client, owner, repo, pullNumber) {
  return client.get(prPath(owner, repo, pullNumber));
}
async function listPullRequestFiles(client, owner, repo, pullNumber) {
  return client.getAllPages(`${prPath(owner, repo, pullNumber)}/files`);
}

// src/pipeline/eligibility.ts
function skip(code, message, context) {
  return { eligible: false, diagnostic: { code, severity: "expected", message, ...context ? { context } : {} } };
}
function fail(code, message, context) {
  return { eligible: false, diagnostic: { code, severity: "failure", message, ...{} } };
}
function evaluateEligibility(input) {
  const { event, pr } = input;
  if (!SUPPORTED_PR_EVENTS.has(event.action)) {
    return skip(
      "UNSUPPORTED_EVENT",
      `PR event '${event.action || "(none)"}' is not one of ${[...SUPPORTED_PR_EVENTS].join(", ")}.`,
      { action: event.action || "(none)" }
    );
  }
  if (!pr.head?.sha) {
    return fail("INVALID_GITHUB_CONTEXT", "PR head SHA is missing from the API response.");
  }
  if (!pr.head?.repo) {
    return skip(
      "UNSUPPORTED_PR_SOURCE",
      "The PR head repository is no longer available (deleted or inaccessible)."
    );
  }
  if (!pr.base?.repo) {
    return fail("INVALID_GITHUB_CONTEXT", "PR base repository is missing from the API response.");
  }
  if (pr.merged) {
    return skip("PR_ALREADY_MERGED", "The pull request has already been merged.");
  }
  if (pr.state !== "open") {
    return skip("PR_CLOSED", "The pull request is not open.", { state: pr.state });
  }
  if (pr.draft) {
    return skip("DRAFT_PR", "The pull request is a draft.");
  }
  const baseIsPrivate = pr.base.repo.private;
  if (!baseIsPrivate) {
    return skip(
      "PUBLIC_REPOSITORY",
      "The base repository is public. This action only reviews private repositories by default, because it sends diff contents to an external inference provider.",
      { base_repo: pr.base.repo.full_name }
    );
  }
  if (pr.head.repo.full_name !== pr.base.repo.full_name) {
    return skip(
      "UNSUPPORTED_PR_SOURCE",
      "The pull request head is in a different repository (a fork or external contribution). Reviewing it would mean sending third-party code to an external inference provider, which v1 does not do.",
      { head_repo: pr.head.repo.full_name, base_repo: pr.base.repo.full_name }
    );
  }
  if (event.eventHeadSha !== null && event.eventHeadSha !== pr.head.sha) ;
  const totalChangedLines = pr.additions + pr.deletions;
  return {
    eligible: true,
    totalChangedLines,
    changedFileCount: pr.changed_files,
    identity: {
      owner: pr.base.repo.owner.login,
      repo: pr.base.repo.name,
      pullNumber: pr.number,
      baseSha: pr.base.sha,
      reviewHeadSha: pr.head.sha,
      promptVersion: input.promptVersion,
      configVersion: input.configVersion
    }
  };
}

// src/prompt/version.ts
var PROMPT_VERSION = "2026-09-27.1";
var CONFIG_VERSION = "2026-09-27.1";

// src/run.ts
function baseOutputs() {
  return {
    findings_count: "0",
    unanchored_count: "0",
    files_reviewed: "0",
    model_used: "",
    requests_used: "0",
    review_url: ""
  };
}
function appendOutputs(outputs, env = process.env) {
  const path = env["GITHUB_OUTPUT"];
  if (!path) return;
  const keys = Object.keys(outputs);
  const body = keys.map((k) => `${k}=${outputs[k].replace(/[\r\n]+/g, " ")}`).join("\n");
  fs.appendFileSync(path, `${body}
`, "utf8");
}
function appendStepSummary(markdown, env = process.env) {
  const path = env["GITHUB_STEP_SUMMARY"];
  if (!path) return;
  fs.appendFileSync(path, `${markdown}
`, "utf8");
}
function summarise(logger, outputs) {
  const counts = logger.counts();
  const rows = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([code, n]) => `| \`${code}\` | ${n} |`).join("\n");
  return [
    "## FreeReview",
    "",
    `**Status:** \`${outputs.status}\``,
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Findings published | ${outputs.findings_count} |`,
    `| Unanchored (not published inline) | ${outputs.unanchored_count} |`,
    `| Files reviewed | ${outputs.files_reviewed} |`,
    `| Model | ${outputs.model_used || "\u2014"} |`,
    `| OpenRouter requests used | ${outputs.requests_used} |`,
    "",
    rows.length > 0 ? ["### Diagnostics", "", "| Code | Count |", "| --- | --- |", rows].join("\n") : "_No diagnostics recorded._",
    ""
  ].join("\n");
}
function resolveStatus(diagnostics) {
  if (diagnostics.some((d) => d.severity === "failure")) return "failed";
  const skipOrder = [
    // 1. event
    ["skipped_unsupported_event", /* @__PURE__ */ new Set(["UNSUPPORTED_EVENT"])],
    // 2. structural metadata (also catches a deleted head repository)
    ["skipped_unsupported_pr_source", /* @__PURE__ */ new Set(["UNSUPPORTED_PR_SOURCE"])],
    // 3. PR state
    ["skipped_pr_closed", /* @__PURE__ */ new Set(["PR_ALREADY_MERGED", "PR_CLOSED"])],
    ["skipped_draft_pr", /* @__PURE__ */ new Set(["DRAFT_PR"])],
    // 4. trust boundary: privacy, then provenance
    ["skipped_public_repository", /* @__PURE__ */ new Set(["PUBLIC_REPOSITORY"])],
    // 5. everything downstream of the gate
    ["skipped_diff_unavailable", /* @__PURE__ */ new Set(["DIFF_FETCH_FAILED", "DIFF_TRUNCATED"])],
    ["skipped_pr_too_large", /* @__PURE__ */ new Set(["PR_TOO_LARGE", "CONTEXT_TOO_LARGE"])],
    ["skipped_no_reviewable_files", /* @__PURE__ */ new Set(["NO_REVIEWABLE_FILES"])],
    ["skipped_no_eligible_model", /* @__PURE__ */ new Set(["NO_ELIGIBLE_MODEL", "NO_ELIGIBLE_PROVIDER"])],
    [
      "skipped_quota_exhausted",
      /* @__PURE__ */ new Set([
        "OPENROUTER_QUOTA_EXHAUSTED",
        "REQUEST_BUDGET_EXHAUSTED",
        "RATE_LIMIT_BUDGET_THROTTLED"
      ])
    ],
    [
      "skipped_upstream_unavailable",
      /* @__PURE__ */ new Set(["OPENROUTER_RATE_LIMITED", "OPENROUTER_UNAVAILABLE"])
    ],
    ["skipped_cancelled", /* @__PURE__ */ new Set(["REQUEST_CANCELLED"])],
    ["skipped_stale", /* @__PURE__ */ new Set(["STALE_HEAD_SHA", "HEAD_CHANGED_MID_RUN"])],
    // Every remaining expected-severity code is something that stopped a
    // usable review from being produced.
    [
      "skipped_no_usable_output",
      /* @__PURE__ */ new Set([
        "MODEL_OUTPUT_INVALID",
        "MODEL_OUTPUT_EMPTY_RETRYABLE",
        "MODEL_OUTPUT_TRUNCATED",
        "MODEL_OUTPUT_TOO_LARGE",
        "FINDING_COUNT_EXCEEDED",
        "INJECTION_COMPLIANCE_SUSPECTED",
        "GITHUB_PUBLISH_FAILED",
        "GITHUB_PUBLISH_DEGRADED"
      ])
    ]
  ];
  const codes = new Set(diagnostics.map((d) => d.code));
  for (const [status, members] of skipOrder) {
    if ([...members].some((code) => codes.has(code))) return status;
  }
  if (diagnostics.length > 0) return "skipped_no_usable_output";
  return "reviewed";
}
async function run(env = process.env) {
  const logger = createLogger({ debug: debugPayloadsFromEnv(env) });
  const eventResult = parseEventContext(env);
  if (!eventResult.ok) {
    logger.log(eventResult.code, eventResult.detail);
    return finish(logger, baseOutputs(), "skipped_early_exit");
  }
  const event = eventResult.context;
  logger.debug("event context parsed", {
    owner: event.owner,
    repo: event.repo,
    pull: event.pullNumber,
    action: event.action
  });
  const token = env["GITHUB_TOKEN"];
  if (token === void 0 || token.length === 0) {
    logger.log(
      "MISSING_CREDENTIALS",
      "GITHUB_TOKEN is not available. Invoke this action from a GitHub Actions workflow with 'permissions: pull-requests: write'."
    );
    return finish(logger, baseOutputs(), "failed");
  }
  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.log("CONFIG_INVALID", error.detail, { input: error.input });
      return finish(logger, baseOutputs(), "failed");
    }
    throw error;
  }
  logger.info("FreeReview starting", {
    privacy_mode: config.privacyMode,
    models: config.models.length,
    max_requests_per_run: config.maxRequestsPerRun,
    max_input_tokens: config.maxInputTokens
  });
  if (config.privacyMode === "relaxed") {
    logger.annotation(
      "privacy_mode=relaxed: this review was sent WITHOUT zero-data-retention enforcement. Providers may retain prompts and outputs. Use privacy_mode=strict to require provider.zdr=true and provider.data_collection='deny'."
    );
  }
  if (config.debugPayloads) {
    logger.annotation(
      "debug_payloads=true: full prompt bodies and model responses will be written to the workflow log. This exposes proprietary source code to anyone who can read the log."
    );
  }
  const client = new GithubClient({ token });
  let pr;
  try {
    pr = await getPullRequest(client, event.owner, event.repo, event.pullNumber);
  } catch (error) {
    if (error instanceof GithubError) {
      const code = error.kind === "not_found" || error.kind === "forbidden" ? "INVALID_GITHUB_CONTEXT" : "DIFF_FETCH_FAILED";
      logger.log(
        code,
        `Could not read pull request #${event.pullNumber}: ${error.message}`,
        { status: error.status, kind: error.kind }
      );
      return finish(logger, baseOutputs(), error.kind === "server" ? "skipped_early_exit" : "failed");
    }
    throw error;
  }
  const eligibility = evaluateEligibility({
    event,
    pr,
    promptVersion: PROMPT_VERSION,
    configVersion: CONFIG_VERSION
  });
  if (!eligibility.eligible) {
    logger.record(eligibility.diagnostic);
    return finish(logger, baseOutputs(), "skipped_early_exit");
  }
  const { identity, totalChangedLines, changedFileCount } = eligibility;
  logger.info("PR is eligible for review", {
    pull: identity.pullNumber,
    head: identity.reviewHeadSha.slice(0, 7),
    base: identity.baseSha.slice(0, 7),
    changed_lines: totalChangedLines,
    changed_files: changedFileCount
  });
  let files;
  try {
    files = await listPullRequestFiles(client, identity.owner, identity.repo, identity.pullNumber);
  } catch (error) {
    if (error instanceof GithubError) {
      logger.log("DIFF_FETCH_FAILED", `Could not list changed files: ${error.message}`, {
        status: error.status,
        kind: error.kind
      });
      return finish(logger, baseOutputs(), "skipped_early_exit");
    }
    throw error;
  }
  const binaryCount = files.filter((f) => !f.patch).length;
  logger.info("changed files retrieved", {
    total: files.length,
    reported: changedFileCount,
    without_patch: binaryCount
  });
  if (files.length < changedFileCount) {
    logger.log(
      "DIFF_TRUNCATED",
      `GitHub reported ${changedFileCount} changed files but returned ${files.length}. The change list was truncated and the review would be incomplete.`,
      { reported: changedFileCount, received: files.length }
    );
    return finish(logger, baseOutputs(), "skipped_early_exit");
  }
  return finish(
    logger,
    { ...baseOutputs(), files_reviewed: String(files.length) },
    "skipped_pipeline_not_implemented"
  );
}
function finish(logger, partial, statusHint) {
  const resolved = resolveStatus(logger.diagnostics);
  const outputs = {
    ...partial,
    // A diagnostics-derived status is always more informative than the hint.
    status: resolved === "reviewed" && statusHint !== "reviewed" ? statusHint : resolved
  };
  appendStepSummary(summarise(logger, outputs));
  appendOutputs(outputs);
  return outputs;
}

// src/index.ts
void run().then((outputs) => {
  process.exitCode = outputs.status === "failed" ? 1 : 0;
}).catch((error) => {
  const message = error instanceof Error ? error.message : "unknown error";
  const single = message.replace(/[\r\n]+/g, " ").slice(0, 400);
  process.stdout.write(`::error::INTERNAL_ERROR ${single}
`);
  process.exitCode = 1;
});
