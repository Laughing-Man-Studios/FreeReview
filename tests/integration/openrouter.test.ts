/**
 * Integration tests for the OpenRouter client against a mocked api.
 *
 * The contract asserted here is the one the project rests on: every request uses
 * an explicitly free model, routing is constrained so a paid endpoint cannot be
 * selected, and no request is sent that is expected to be rejected.
 *
 * No network access. `sleep` is injected so backoff costs no wall time.
 */

import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type Config, type ModelDefinition } from "../../src/config.js";
import {
  CHAT_COMPLETIONS_URL,
  OpenRouterClient,
  buildProviderBlock,
} from "../../src/llm/client.js";
import { OpenRouterError } from "../../src/llm/errors.js";

const server = setupServer();

/** Every request body sent, for exact-shape assertions. */
const sent: { body: Record<string, unknown>; headers: Headers }[] = [];

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  server.events.on("request:start", ({ request }) => {
    if (request.method !== "POST") return;
    const body = request.clone();
    void body
      .json()
      .then((parsed) => {
        sent.push({ body: parsed as Record<string, unknown>, headers: new Headers(request.headers) });
      })
      .catch(() => undefined);
  });
});

afterEach(() => {
  server.resetHandlers();
  sent.length = 0;
});

afterAll(() => server.close());

function config(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    INPUT_OPENROUTER_API_KEY: "sk-test-0000000000000000",
    ...overrides,
  });
}

const QWEN: ModelDefinition = {
  id: "qwen/qwen3.8-27b:free",
  enabled: true,
  priority: 0,
  maxContextTokens: 262_144,
  supportsResponseFormat: true,
  supportsJsonSchema: true,
  privacyEligible: true,
};

const GEMMA: ModelDefinition = {
  id: "google/gemma-4-31b-it:free",
  enabled: true,
  priority: 1,
  maxContextTokens: 262_144,
  supportsResponseFormat: true,
  // No structured outputs, so it must not receive a json_schema.
  supportsJsonSchema: false,
  privacyEligible: true,
};

const NO_STRUCTURED: ModelDefinition = {
  id: "nvidia/nemotron-3-ultra-550b-a55b:free",
  enabled: true,
  priority: 2,
  maxContextTokens: 1_000_000,
  supportsResponseFormat: false,
  supportsJsonSchema: false,
  privacyEligible: true,
};

const SCHEMA = {
  name: "code_review_findings",
  strict: true as const,
  schema: {
    type: "object",
    properties: { findings: { type: "array" } },
    required: ["findings"],
    additionalProperties: false,
  },
};

function okResponse(overrides: Record<string, unknown> = {}) {
  return HttpResponse.json({
    id: "gen-1",
    model: "x",
    choices: [{ message: { role: "assistant", content: '{"findings":[]}' }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    ...overrides,
  });
}

/**
 * Send a request expecting it to fail, returning the typed error.
 *
 * The client either resolves with a `ChatResult` or rejects with an
 * `OpenRouterError`; this narrows the rejection so assertions can read
 * `errorType` and `failure` without a cast at every call site.
 */
async function expectFailure(
  promise: Promise<unknown>,
): Promise<OpenRouterError> {
  try {
    const value = await promise;
    throw new Error(`expected a failure, received ${JSON.stringify(value).slice(0, 120)}`);
  } catch (error) {
    if (error instanceof OpenRouterError) return error;
    throw error;
  }
}

const MESSAGES = [{ role: "user" as const, content: "review this" }];

describe("guard 1: config-time :free rejection", () => {
  it("rejects a paid model before any request is constructed", () => {
    expect(() =>
      loadConfig({
        INPUT_OPENROUTER_API_KEY: "sk-test",
        INPUT_PRIMARY_MODEL: "openai/gpt-4o",
      }),
    ).toThrow(/never routes to a paid model/);
  });
});

describe("guard 2: per-request :free assertion", () => {
  it("refuses to send a request for a non-free model", async () => {
    const client = new OpenRouterClient({ config: config() });
    const paid: ModelDefinition = { ...QWEN, id: "openai/gpt-4o" };

    await expect(
      client.complete({ model: paid, messages: MESSAGES, mode: "STRUCTURED", schema: SCHEMA, maxOutputTokens: 100 }),
    ).rejects.toThrow(OpenRouterError);

    // Nothing was sent.
    expect(sent).toHaveLength(0);
  });

  it("names the model in the refusal", async () => {
    const client = new OpenRouterClient({ config: config() });
    const paid: ModelDefinition = { ...QWEN, id: "qwen/qwen3.8-27b" };
    await expect(
      client.complete({ model: paid, messages: MESSAGES, mode: "PROMPT_JSON", maxOutputTokens: 100 }),
    ).rejects.toThrow(/qwen\/qwen3\.8-27b/);
  });

  it("a model ending in :free passes the assertion", async () => {
    server.use(http.post(CHAT_COMPLETIONS_URL, () => okResponse()));
    const client = new OpenRouterClient({ config: config() });
    await expect(
      client.complete({ model: QWEN, messages: MESSAGES, mode: "STRUCTURED", schema: SCHEMA, maxOutputTokens: 100 }),
    ).resolves.toBeDefined();
    expect(sent).toHaveLength(1);
  });
});

describe("guard 3: provider.max_price is pinned to zero", () => {
  it("sends zero max_price in strict mode", async () => {
    server.use(http.post(CHAT_COMPLETIONS_URL, () => okResponse()));
    const client = new OpenRouterClient({ config: config({ INPUT_PRIVACY_MODE: "strict" }) });

    await client.complete({ model: QWEN, messages: MESSAGES, mode: "STRUCTURED", schema: SCHEMA, maxOutputTokens: 100 });

    const provider = sent[0]?.body["provider"] as Record<string, unknown>;
    expect(provider["max_price"]).toEqual({ prompt: "0", completion: "0", request: "0" });
  });

  it("keeps max_price zero even in relaxed mode", async () => {
    // Relaxing privacy must never become a licence to spend money.
    server.use(http.post(CHAT_COMPLETIONS_URL, () => okResponse()));
    const client = new OpenRouterClient({ config: config({ INPUT_PRIVACY_MODE: "relaxed" }) });

    await client.complete({ model: QWEN, messages: MESSAGES, mode: "PROMPT_JSON", maxOutputTokens: 100 });

    const provider = sent[0]?.body["provider"] as Record<string, unknown>;
    expect(provider["max_price"]).toEqual({ prompt: "0", completion: "0", request: "0" });
  });
});

describe("privacy routing constraints", () => {
  it("strict mode sends zdr and data_collection deny", () => {
    const provider = buildProviderBlock(config({ INPUT_PRIVACY_MODE: "strict" }), "PROMPT_JSON");
    expect(provider["zdr"]).toBe(true);
    expect(provider["data_collection"]).toBe("deny");
  });

  it("relaxed mode omits both", () => {
    const provider = buildProviderBlock(config({ INPUT_PRIVACY_MODE: "relaxed" }), "PROMPT_JSON");
    expect(provider["zdr"]).toBeUndefined();
    expect(provider["data_collection"]).toBeUndefined();
  });

  it("relaxed mode still pins max_price", () => {
    const provider = buildProviderBlock(config({ INPUT_PRIVACY_MODE: "relaxed" }), "PROMPT_JSON");
    expect(provider["max_price"]).toEqual({ prompt: "0", completion: "0", request: "0" });
  });
});

describe("request shape follows declared capabilities", () => {
  it("STRUCTURED mode sends a strict json_schema and require_parameters", async () => {
    server.use(http.post(CHAT_COMPLETIONS_URL, () => okResponse()));
    const client = new OpenRouterClient({ config: config() });

    await client.complete({ model: QWEN, messages: MESSAGES, mode: "STRUCTURED", schema: SCHEMA, maxOutputTokens: 100 });

    const body = sent[0]!.body;
    const responseFormat = body["response_format"] as Record<string, unknown>;
    const jsonSchema = responseFormat["json_schema"] as Record<string, unknown>;
    expect(responseFormat["type"]).toBe("json_schema");
    expect(jsonSchema["name"]).toBe("code_review_findings");
    expect(jsonSchema["strict"]).toBe(true);
    expect((body["provider"] as Record<string, unknown>)["require_parameters"]).toBe(true);
  });

  it("JSON_OBJECT mode sends json_object and NOT require_parameters", async () => {
    // The Gemma-4 case. Sending require_parameters without json_schema excludes
    // every endpoint and yields a 503 for free.
    server.use(http.post(CHAT_COMPLETIONS_URL, () => okResponse()));
    const client = new OpenRouterClient({ config: config() });

    await client.complete({ model: GEMMA, messages: MESSAGES, mode: "JSON_OBJECT", maxOutputTokens: 100 });

    const body = sent[0]!.body;
    expect(body["response_format"]).toEqual({ type: "json_object" });
    expect((body["provider"] as Record<string, unknown>)["require_parameters"]).toBeUndefined();
  });

  it("PROMPT_JSON mode sends no response_format at all", async () => {
    server.use(http.post(CHAT_COMPLETIONS_URL, () => okResponse()));
    const client = new OpenRouterClient({ config: config() });

    await client.complete({ model: NO_STRUCTURED, messages: MESSAGES, mode: "PROMPT_JSON", maxOutputTokens: 100 });

    expect(sent[0]?.body["response_format"]).toBeUndefined();
    expect((sent[0]?.body["provider"] as Record<string, unknown>)["require_parameters"]).toBeUndefined();
  });
});

describe("request is deterministic and bounded", () => {
  it("sends temperature 0, a fixed top_p, a fixed seed, and no streaming", async () => {
    server.use(http.post(CHAT_COMPLETIONS_URL, () => okResponse()));
    const client = new OpenRouterClient({ config: config() });

    await client.complete({ model: QWEN, messages: MESSAGES, mode: "PROMPT_JSON", maxOutputTokens: 1_500 });

    const body = sent[0]!.body;
    expect(body["temperature"]).toBe(0);
    expect(body["top_p"]).toBe(1);
    expect(typeof body["seed"]).toBe("number");
    expect(body["stream"]).toBe(false);
    expect(body["max_tokens"]).toBe(1_500);
  });

  it("builds an identical body for identical input", () => {
    const client = new OpenRouterClient({ config: config() });
    const request = { model: QWEN, messages: MESSAGES, mode: "PROMPT_JSON" as const, maxOutputTokens: 100 };

    expect(client.buildBody(request)).toEqual(client.buildBody(request));
  });

  it("sends the attribution and router-metadata headers", async () => {
    server.use(http.post(CHAT_COMPLETIONS_URL, () => okResponse()));
    const client = new OpenRouterClient({ config: config() });

    await client.complete({ model: QWEN, messages: MESSAGES, mode: "PROMPT_JSON", maxOutputTokens: 100 });

    const headers = sent[0]?.headers;
    expect(headers?.get("authorization")).toBe("Bearer sk-test-0000000000000000");
    expect(headers?.get("x-openrouter-title")).toBe("FreeReview");
    expect(headers?.get("x-openrouter-metadata")).toBe("enabled");
    expect(headers?.get("http-referer")).toContain("FreeReview");
  });
});

describe("a 200 can still carry an error", () => {
  it("treats a 200 with an error body as a failure, not an empty review", async () => {
    // The bug this prevents: a provider failure after headers were sent returns
    // 200 with an error and no usable choices. Status-only checking yields a
    // silent empty review, indistinguishable from "no findings".
    server.use(
      http.post(CHAT_COMPLETIONS_URL, () =>
        HttpResponse.json({
          id: "gen-2",
          error: { code: 502, message: "Provider disconnected", metadata: { error_type: "provider_unavailable" } },
        }),
      ),
    );

    const client = new OpenRouterClient({ config: config() });
    const error = await expectFailure(client.complete({ model: QWEN, messages: MESSAGES, mode: "PROMPT_JSON", maxOutputTokens: 100 }));

    expect(error).toBeInstanceOf(OpenRouterError);
    expect(error.errorType).toBe("provider_unavailable");
    expect(error.failure).toBe("retryable");
  });

  it("treats a 200 whose first choice carries an error as a failure", async () => {
    server.use(
      http.post(CHAT_COMPLETIONS_URL, () =>
        HttpResponse.json({
          id: "gen-3",
          choices: [
            {
              message: { role: "assistant", content: "partial" },
              finish_reason: "error",
              error: { code: 502, message: "dropped", metadata: { error_type: "provider_unavailable" } },
            },
          ],
        }),
      ),
    );

    const client = new OpenRouterClient({ config: config() });
    await expect(
      client.complete({ model: QWEN, messages: MESSAGES, mode: "PROMPT_JSON", maxOutputTokens: 100 }),
    ).rejects.toThrow(OpenRouterError);
  });
});

describe("empty output is split by cause", () => {
  it("reports a truncated response as max_tokens_exceeded and marks it fatal", async () => {
    // A reasoning model that spent the whole budget on reasoning tokens will not
    // produce content on a retry. Retrying wastes quota; the fix is a bigger
    // output budget.
    server.use(
      http.post(CHAT_COMPLETIONS_URL, () =>
        okResponse({
          choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }],
        }),
      ),
    );

    const client = new OpenRouterClient({ config: config() });
    const error = await expectFailure(client.complete({ model: QWEN, messages: MESSAGES, mode: "PROMPT_JSON", maxOutputTokens: 100 }));

    expect(error.errorType).toBe("max_tokens_exceeded");
    expect(error.failure).toBe("fatal");
    expect(error.message).toMatch(/Retrying will not help/);
  });

  it("infers truncation from reasoning tokens when finish_reason is absent", async () => {
    server.use(
      http.post(CHAT_COMPLETIONS_URL, () =>
        okResponse({
          choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
          usage: { completion_tokens: 500, completion_tokens_details: { reasoning_tokens: 480 } },
        }),
      ),
    );

    const client = new OpenRouterClient({ config: config() });
    const error = await expectFailure(client.complete({ model: QWEN, messages: MESSAGES, mode: "PROMPT_JSON", maxOutputTokens: 500 }));

    expect(error.errorType).toBe("max_tokens_exceeded");
  });

  it("reports a warm-up empty response as retryable", async () => {
    server.use(
      http.post(CHAT_COMPLETIONS_URL, () =>
        okResponse({
          choices: [{ message: { role: "assistant", content: "   " }, finish_reason: "stop" }],
        }),
      ),
    );

    const client = new OpenRouterClient({ config: config() });
    const error = await expectFailure(client.complete({ model: QWEN, messages: MESSAGES, mode: "PROMPT_JSON", maxOutputTokens: 100 }));

    expect(error.failure).toBe("retryable");
  });
});

describe("successful responses", () => {
  it("returns content, usage, and router metadata", async () => {
    server.use(
      http.post(CHAT_COMPLETIONS_URL, () =>
        okResponse({
          openrouter_metadata: {
            attempt: 1,
            strategy: "direct",
            region: "iad",
            is_byok: false,
            endpoints: { available: [{ provider: "Some Provider" }] },
          },
        }),
      ),
    );

    const client = new OpenRouterClient({ config: config() });
    const result = await client.complete({
      model: QWEN,
      messages: MESSAGES,
      mode: "STRUCTURED",
      schema: SCHEMA,
      maxOutputTokens: 100,
    });

    expect(result.content).toBe('{"findings":[]}');
    expect(result.finishReason).toBe("stop");
    expect(result.usage.promptTokens).toBe(100);
    expect(result.usage.completionTokens).toBe(20);
    // The serving provider is an audit trail: it is how a reviewer can tell
    // which company received the diff.
    expect(result.router.provider).toBe("Some Provider");
    expect(result.router.attempt).toBe(1);
  });

  it("parses structured output when the body is JSON", async () => {
    server.use(
      http.post(CHAT_COMPLETIONS_URL, () =>
        okResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: '{"findings":[{"path":"a.ts","buggyCodeQuote":"x","explanation":"y","severity":"warning","suggestedCode":null}]}',
              },
              finish_reason: "stop",
            },
          ],
        }),
      ),
    );

    const client = new OpenRouterClient({ config: config() });
    const result = await client.complete({
      model: QWEN,
      messages: MESSAGES,
      mode: "STRUCTURED",
      schema: SCHEMA,
      maxOutputTokens: 100,
    });

    expect(result.parsed?.findings).toHaveLength(1);
    expect(result.parsed?.findings[0]?.severity).toBe("warning");
  });

  it("returns null parsed output when the body is not JSON", async () => {
    server.use(
      http.post(CHAT_COMPLETIONS_URL, () =>
        okResponse({
          choices: [{ message: { role: "assistant", content: "not json at all" }, finish_reason: "stop" }],
        }),
      ),
    );

    const client = new OpenRouterClient({ config: config() });
    const result = await client.complete({
      model: QWEN,
      messages: MESSAGES,
      mode: "PROMPT_JSON",
      maxOutputTokens: 100,
    });

    expect(result.content).toBe("not json at all");
    expect(result.parsed).toBeNull();
  });
});

describe("error bodies are classified by error_type", () => {
  it("maps a 429 with Retry-After to retryable and surfaces the delay", async () => {
    server.use(
      http.post(CHAT_COMPLETIONS_URL, () =>
        HttpResponse.json(
          { error: { code: 429, message: "Rate limit exceeded", metadata: { error_type: "rate_limit_exceeded" } } },
          { status: 429, headers: { "Retry-After": "12" } },
        ),
      ),
    );

    const client = new OpenRouterClient({ config: config() });
    const error = await expectFailure(client.complete({ model: QWEN, messages: MESSAGES, mode: "PROMPT_JSON", maxOutputTokens: 100 }));

    expect(error.failure).toBe("retryable");
    expect(error.retryAfterSeconds).toBe(12);
  });

  it("maps a 401 to fatal, so a bad key is not retried", async () => {
    // The Phase 1 bug: 401 was unclassified and became a non-blocking skip,
    // producing a green run that had reviewed nothing.
    server.use(
      http.post(CHAT_COMPLETIONS_URL, () =>
        HttpResponse.json({ error: { code: 401, message: "Bad credentials", metadata: { error_type: "authentication" } } }, { status: 401 }),
      ),
    );

    const client = new OpenRouterClient({ config: config() });
    const error = await expectFailure(client.complete({ model: QWEN, messages: MESSAGES, mode: "PROMPT_JSON", maxOutputTokens: 100 }));

    expect(error.failure).toBe("fatal");
    expect(error.errorType).toBe("authentication");
  });

  it("maps a 503 with attempt 0 to a model fallback, not a retry", async () => {
    // No endpoint satisfied the routing constraints. Retrying the same model
    // cannot help; the constraint is deterministic.
    server.use(
      http.post(CHAT_COMPLETIONS_URL, () =>
        HttpResponse.json(
          {
            error: { code: 503, message: "No available model provider meets your routing requirements" },
            openrouter_metadata: { attempt: 0 },
          },
          { status: 503 },
        ),
      ),
    );

    const client = new OpenRouterClient({ config: config() });
    const error = await expectFailure(client.complete({ model: QWEN, messages: MESSAGES, mode: "PROMPT_JSON", maxOutputTokens: 100 }));

    expect(error.failure).toBe("fallback");
    expect(error.noEligibleProvider).toBe(true);
  });

  it("maps a 503 with attempt 1 to a retry, since the provider was just busy", async () => {
    server.use(
      http.post(CHAT_COMPLETIONS_URL, () =>
        HttpResponse.json(
          {
            error: { code: 503, message: "Provider overloaded", metadata: { error_type: "provider_overloaded" } },
            openrouter_metadata: { attempt: 1 },
          },
          { status: 503 },
        ),
      ),
    );

    const client = new OpenRouterClient({ config: config() });
    const error = await expectFailure(client.complete({ model: QWEN, messages: MESSAGES, mode: "PROMPT_JSON", maxOutputTokens: 100 }));

    expect(error.failure).toBe("retryable");
  });

  it("maps a 402 with the in-flight budget limit source to a retry", async () => {
    server.use(
      http.post(CHAT_COMPLETIONS_URL, () =>
        HttpResponse.json(
          {
            error: {
              code: 402,
              message: "in-flight budget exhausted",
              metadata: { error_type: "payment_required", limit_source: "openrouter_in_flight_budget" },
            },
          },
          { status: 402, headers: { "Retry-After": "5" } },
        ),
      ),
    );

    const client = new OpenRouterClient({ config: config() });
    const error = await expectFailure(client.complete({ model: QWEN, messages: MESSAGES, mode: "PROMPT_JSON", maxOutputTokens: 100 }));

    expect(error.failure).toBe("retryable");
  });

  it("maps a 402 without that limit source to fatal", async () => {
    // An out-of-credits account is an operator problem. A $0 action must never
    // reach this, and if it does, retrying is pointless.
    server.use(
      http.post(CHAT_COMPLETIONS_URL, () =>
        HttpResponse.json(
          {
            error: {
              code: 402,
              message: "Insufficient credits",
              metadata: { error_type: "payment_required", limit_source: "openrouter_credits" },
            },
          },
          { status: 402 },
        ),
      ),
    );

    const client = new OpenRouterClient({ config: config() });
    const error = await expectFailure(client.complete({ model: QWEN, messages: MESSAGES, mode: "PROMPT_JSON", maxOutputTokens: 100 }));

    expect(error.failure).toBe("fatal");
  });
});

describe("the client never retries on its own", () => {
  it("issues exactly one request for a retryable failure", async () => {
    // A hidden retry inside the client would spend quota the scheduler cannot
    // account for, which is precisely the thing the scheduler exists to prevent.
    let calls = 0;
    server.use(
      http.post(CHAT_COMPLETIONS_URL, () => {
        calls += 1;
        return HttpResponse.json(
          { error: { code: 429, message: "slow down", metadata: { error_type: "rate_limit_exceeded" } } },
          { status: 429, headers: { "Retry-After": "1" } },
        );
      }),
    );

    const client = new OpenRouterClient({ config: config() });
    await client
      .complete({ model: QWEN, messages: MESSAGES, mode: "PROMPT_JSON", maxOutputTokens: 100 })
      .catch(() => undefined);

    expect(calls).toBe(1);
  });
});

describe("abort propagates rather than being retried", () => {
  it("rethrows an AbortError so the scheduler can stop immediately", async () => {
    server.use(http.post(CHAT_COMPLETIONS_URL, () => HttpResponse.error()));
    const client = new OpenRouterClient({ config: config() });
    const controller = new AbortController();
    controller.abort();

    const error = await client
      .complete({
        model: QWEN,
        messages: MESSAGES,
        mode: "PROMPT_JSON",
        maxOutputTokens: 100,
        signal: controller.signal,
      })
      .catch((e: unknown) => e);

    // Either the fetch rejects with AbortError, or the request is refused before
    // sending. It must not be converted into a retryable OpenRouterError.
    if (error instanceof OpenRouterError) expect(error.failure).toBe("fatal");
    else expect((error as Error).name).toBe("AbortError");
  });
});
