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
    referer: "https://github.com/Rogibb111/FreeReview",
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

// src/run.ts
function emptyOutputs(status) {
  return {
    status,
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
async function run(env = process.env) {
  const probeLogger = createLogger();
  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      probeLogger.log("CONFIG_INVALID", error.detail, { input: error.input });
      const outputs2 = emptyOutputs("failed");
      appendStepSummary(summarise(probeLogger, outputs2), env);
      appendOutputs(outputs2, env);
      return outputs2;
    }
    throw error;
  }
  const logger = createLogger({ debug: config.debugPayloads });
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
  const outputs = emptyOutputs("skipped_pipeline_not_implemented");
  appendStepSummary(summarise(logger, outputs), env);
  appendOutputs(outputs, env);
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
