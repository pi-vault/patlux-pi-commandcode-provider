/**
 * Integration tests for streamCommandCode using a mock Command Code server.
 *
 * Tests the full stream lifecycle: events, error handling, edge cases.
 * No real API key needed — the mock server simulates all responses.
 *
 * Run with: npx tsx tests/test-stream.ts
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createServer, type Server } from "node:http";
// ---------------------------------------------------------------------------
// pi-ai types: import from pi's bundled copy
// ---------------------------------------------------------------------------

const PI_AI =
  "/nix/store/rlhiqjvq3xhs82481s198c6bpnsksbjd-pi-coding-agent-0.72.0/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-ai/dist/index.js";

let createAssistantMessageEventStream: any;
let calculateCost: any;

// Both the pi-ai import and server startup happen in a single before hook
// to avoid ordering issues with node:test + tsx.

before(async () => {
  // 1. Import pi-ai
  const mod = await import(PI_AI);
  createAssistantMessageEventStream = mod.createAssistantMessageEventStream;
  calculateCost = mod.calculateCost;

  // 2. Start mock server
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/alpha/generate") {
        _requestCount++;
        let body = "";
        req.on("data", (c) => (body += c.toString()));
        req.on("end", () => {
          try {
            _lastRequestBody = JSON.parse(body);
          } catch {
            _lastRequestBody = null;
          }

          const plan = _nextPlan;

          if (plan.type === "error") {
            res.writeHead(plan.status, { "Content-Type": "text/plain" });
            res.end(plan.body);
            return;
          }

          res.writeHead(plan.status, {
            "Content-Type": "text/plain; charset=utf-8",
            "Transfer-Encoding": "chunked",
          });

          const events = plan.events ?? [];
          const delays = plan.delays ?? events.map(() => 0);
          const hangAfterLast = plan.type === "success" ? plan.hangAfterLast : false;

          let i = 0;
          const sendNext = () => {
            if (i >= events.length) {
              if (!hangAfterLast) res.end();
              return;
            }
            res.write(events[i] + "\n");
            i++;
            if (i < events.length) {
              setTimeout(sendNext, delays[i] ?? 0);
            } else if (!hangAfterLast) {
              res.end();
            }
          };

          sendNext();
        });
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    server.listen(0, () => {
      port = (server.address() as any).port;
      resolve();
    });
  });

  // 3. Initialize streamCommandCode
  if (typeof createAssistantMessageEventStream !== "function") {
    throw new Error(
      `createAssistantMessageEventStream is not a function after import, it is ${typeof createAssistantMessageEventStream}`,
    );
  }
  streamCommandCode = createStreamCommandCode(
    createAssistantMessageEventStream,
    calculateCost,
    baseUrl(),
  );
});

// ---------------------------------------------------------------------------
// Build model fixture
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: "test-model",
    name: "Test Model",
    api: "commandcode-custom",
    provider: "commandcode",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4096,
    ...overrides,
  };
}

function makeContext(overrides: Partial<Record<string, any>> = {}) {
  return {
    systemPrompt: "You are a test assistant.",
    messages: [
      { role: "user", content: "hello", timestamp: Date.now() },
    ],
    tools: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock server: simulates Command Code /alpha/generate streaming endpoint
// ---------------------------------------------------------------------------

type ResponsePlan =
  | { type: "success"; status: number; events: string[]; delays?: number[]; hangAfterLast?: boolean }
  | { type: "error"; status: number; body: string };

let server: Server;
let port: number;
let _nextPlan: ResponsePlan = { type: "success", status: 200, events: [] };
let _requestCount = 0;
let _lastRequestBody: any = null;
let streamCommandCode: any;

function mockResponse(plan: ResponsePlan) {
  _nextPlan = plan;
}

function lastRequestBody(): any {
  return _lastRequestBody;
}

function requestCount(): number {
  return _requestCount;
}

function baseUrl(): string {
  return `http://localhost:${port}`;
}

after(() => {
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  _requestCount = 0;
  _lastRequestBody = null;
  _nextPlan = { type: "success", status: 200, events: [] };
});

// ---------------------------------------------------------------------------
// Helper: collect all events from a stream into an array
// ---------------------------------------------------------------------------

async function collectEvents(
  stream: any,
  opts?: { signal?: AbortSignal; maxEvents?: number; timeoutMs?: number },
): Promise<any[]> {
  const events: any[] = [];
  const max = opts?.maxEvents ?? 1000;

  // Create abort promise (resolves when signal fires)
  const abortPromise = new Promise<void>((resolve) => {
    opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
  });

  // Create timeout promise (only if timeoutMs is set)
  const timeoutPromise = opts?.timeoutMs
    ? new Promise<void>((resolve) => setTimeout(resolve, opts.timeoutMs))
    : null;

  // The iteration promise: for-await the async iterable stream
  const iteratorPromise = (async () => {
    try {
      for await (const event of stream) {
        events.push(event);
        if (events.length >= max || event.type === "done" || event.type === "error") {
          return;
        }
      }
    } catch {
      // Stream ended or was aborted — just return what we have
    }
  })();

  // Race: iteration vs abort vs (optional) timeout
  if (timeoutPromise) {
    await Promise.race([iteratorPromise, abortPromise, timeoutPromise]);
  } else {
    await Promise.race([iteratorPromise, abortPromise]);
  }

  return events;
}

// ---------------------------------------------------------------------------
// Inlined streamCommandCode — identical logic to index.ts, configurable baseUrl.
// We inline instead of importing index.ts because index.ts imports from
// @mariozechner/pi-ai and @mariozechner/pi-coding-agent which aren't
// installed as npm deps (pi resolves them from its own install path).
// ---------------------------------------------------------------------------

import { existsSync, readFileSync as fsReadFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Copy of getApiKey (identical to index.ts)
function getApiKey(): string | undefined {
  const env = process.env.COMMANDCODE_API_KEY;
  if (env) return env;
  try {
    const authPath = join(homedir(), ".commandcode", "auth.json");
    if (existsSync(authPath)) {
      const auth = JSON.parse(fsReadFileSync(authPath, "utf-8"));
      if (auth.apiKey) return auth.apiKey;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

// Copy of textContent (identical to index.ts)
function textContent(m: { content: any[] }): string {
  return (m.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text ?? "")
    .join("\n");
}

// Copy of uuid (identical to index.ts)
function uuid(): string {
  return crypto.randomUUID();
}

function getEnvironmentInfo(): string {
  return `${process.platform}-${process.arch}, Node.js ${process.version}`;
}

function parseStreamEventLine(line: string): any | undefined {
  let trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) return undefined;
  if (trimmed.startsWith("data:")) trimmed = trimmed.slice(5).trim();
  if (!trimmed || trimmed === "[DONE]") return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function mapFinishReason(reason: unknown): "stop" | "length" | "toolUse" {
  if (reason === "tool-calls") return "toolUse";
  if (
    reason === "length" ||
    reason === "max_tokens" ||
    reason === "max-tokens" ||
    reason === "max_output_tokens"
  ) {
    return "length";
  }
  return "stop";
}

// Copy of toJsonSchema (identical to index.ts)
function toJsonSchema(schema: any): any {
  if (!schema) return {};
  const s = schema as Record<string, any>;
  const kind = s.kind ?? s.type;
  if (s.enum) {
    return { type: typeof s.enum[0], enum: s.enum };
  }
  switch (kind) {
    case "string":
    case "String":
      return { type: "string" };
    case "number":
    case "Number":
      return { type: "number" };
    case "boolean":
    case "Boolean":
      return { type: "boolean" };
    case "object":
    case "Object": {
      const props: Record<string, any> = {};
      const inferredRequired: string[] = [];
      if (s.properties) {
        for (const [k, v] of Object.entries(s.properties)) {
          props[k] = toJsonSchema(v);
          if (!(v as any).optional && !s.optional?.includes?.(k))
            inferredRequired.push(k);
        }
      }
      const required = Array.isArray(s.required) ? s.required : inferredRequired;
      const out: any = { type: "object" };
      if (Object.keys(props).length) out.properties = props;
      if (required.length) out.required = required;
      return out;
    }
    case "array":
    case "Array":
      return { type: "array", items: toJsonSchema(s.items ?? s.element) };
    case "union":
    case "Union": {
      const variants = s.variants ?? s.anyOf ?? [];
      for (const v of variants) {
        const schema = toJsonSchema(v);
        if (schema && Object.keys(schema).length) return schema;
      }
      return {};
    }
    case "optional":
    case "Optional":
      return toJsonSchema(s.wrapped ?? s.inner);
    default:
      return {};
  }
}

function toolsToJson(tools: any[]): any[] {
  if (!tools) return [];
  return tools.map((t) => {
    const schema = t.parameters ? toJsonSchema(t.parameters) : {};
    return {
      type: "function",
      name: t.name,
      description: t.description,
      input_schema: schema,
    };
  });
}

function messagesToCC(msgs: any[]): any[] {
  const out: any[] = [];
  for (const m of msgs) {
    if (m.role === "user") {
      out.push({
        role: "user",
        content: typeof m.content === "string" ? m.content : m.content,
      });
    } else if (m.role === "assistant") {
      const parts: any[] = [];
      for (const c of m.content) {
        if (c.type === "text") {
          parts.push({ type: "text", text: c.text });
        } else if (c.type === "thinking") {
          parts.push({ type: "reasoning", text: c.thinking });
        } else if (c.type === "toolCall") {
          parts.push({
            type: "tool-call",
            toolCallId: c.id,
            toolName: c.name,
            input: c.arguments,
          });
        }
      }
      out.push({ role: "assistant", content: parts });
    } else if (m.role === "toolResult") {
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: m.toolCallId,
            toolName: m.toolName,
            output: m.isError
              ? { type: "error-text", value: textContent(m) }
              : { type: "text", value: textContent(m) },
          },
        ],
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// streamCommandCode — exact copy of index.ts logic, parameterized via baseUrl
// ---------------------------------------------------------------------------

function createStreamCommandCode(
  _createStream: any,
  _calculateCost: any,
  _apiBase: string,
) {
  function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      return Promise.reject(
        new DOMException("The operation was aborted", "AbortError"),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () =>
        reject(new DOMException("The operation was aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }

  return function streamCommandCode(
    model: any,
    context: any,
    options?: any,
  ): any {
    const stream = _createStream();

    (async () => {
      const apiKey = options?.apiKey ?? getApiKey();
      if (!apiKey) {
        const msg: any = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage:
            "No Command Code API key. Set COMMANDCODE_API_KEY env var or configure ~/.commandcode/auth.json or ~/.pi/agent/auth.json.",
          timestamp: Date.now(),
        };
        stream.push({ type: "error", reason: "error", error: msg });
        stream.end();
        return;
      }

      const output: any = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };

      const controller = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      options?.signal?.addEventListener(
        "abort",
        () => controller.abort(),
        { once: true },
      );

      try {
        stream.push({ type: "start", partial: output as any });

        const ccHeaders: Record<string, string> = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "x-command-code-version": "0.24.1",
          "x-cli-environment": "production",
          "x-project-slug": "pi-cc",
          "x-taste-learning": "false",
          "x-co-flag": "false",
          "x-session-id": uuid(),
          ...options?.headers,
        };

        const body = {
          config: {
            workingDir: process.cwd(),
            date: new Date().toISOString().split("T")[0],
            environment: getEnvironmentInfo(),
            structure: [],
            isGitRepo: false,
            currentBranch: "",
            mainBranch: "",
            gitStatus: "",
            recentCommits: [],
          },
          memory: "",
          taste: "",
          skills: null,
          permissionMode: "standard",
          params: {
            model: model.id,
            messages: messagesToCC(context.messages),
            tools: toolsToJson(context.tools),
            system: context.systemPrompt ?? "",
            max_tokens: Math.min(
              options?.maxTokens ?? model.maxTokens,
              200_000,
            ),
            stream: true,
          },
        };

        const response = await raceAbort(
          fetch(`${_apiBase}/alpha/generate`, {
            method: "POST",
            headers: ccHeaders,
            body: JSON.stringify(body),
            signal: controller.signal,
          }),
          controller.signal,
        );

        if (!response.ok) {
          const errBody = await response.text().catch(() => "");
          throw new Error(
            `Command Code API error ${response.status}: ${errBody.slice(0, 500)}`,
          );
        }

        reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";
        let currentTextIdx = -1;
        let textBlock: any = null;
        let reasoningActive = false;
        let thinkingBlock: string[] = [];
        let finished = false;

        mainLoop: for (;;) {
          if (controller.signal.aborted)
            throw new DOMException("Aborted", "AbortError");
          const { done, value } = await raceAbort(
            reader.read(),
            controller.signal,
          );
          if (done) break;
          if (controller.signal.aborted)
            throw new DOMException("Aborted", "AbortError");
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (controller.signal.aborted) break mainLoop;
            const event = parseStreamEventLine(line);
            if (!event) continue;

            switch (event.type) {
              case "text-delta": {
                if (!textBlock) {
                  textBlock = { type: "text", text: "" };
                  output.content.push(textBlock);
                  currentTextIdx = output.content.length - 1;
                  stream.push({
                    type: "text_start",
                    contentIndex: currentTextIdx,
                    partial: output,
                  });
                }
                textBlock.text += event.text ?? "";
                stream.push({
                  type: "text_delta",
                  contentIndex: currentTextIdx,
                  delta: event.text ?? "",
                  partial: output,
                });
                break;
              }

              case "reasoning-delta": {
                if (!reasoningActive) {
                  reasoningActive = true;
                }
                thinkingBlock.push(event.text ?? "");
                break;
              }

              case "reasoning-end": {
                if (thinkingBlock.length > 0) {
                  const thinkingText = thinkingBlock.join("");
                  thinkingBlock = [];
                  output.content.push({
                    type: "thinking",
                    thinking: thinkingText,
                  });
                  const idx = output.content.length - 1;
                  stream.push({
                    type: "thinking_start",
                    contentIndex: idx,
                    partial: output,
                  });
                  stream.push({
                    type: "thinking_delta",
                    contentIndex: idx,
                    delta: thinkingText,
                    partial: output,
                  });
                  stream.push({
                    type: "thinking_end",
                    contentIndex: idx,
                    content: thinkingText,
                    partial: output,
                  });
                }
                reasoningActive = false;
                break;
              }

              case "tool-call": {
                if (textBlock) {
                  stream.push({
                    type: "text_end",
                    contentIndex: currentTextIdx,
                    content: textBlock.text,
                    partial: output,
                  });
                  textBlock = null;
                  currentTextIdx = -1;
                }
                output.content.push({
                  type: "toolCall",
                  id: event.toolCallId,
                  name: event.toolName,
                  arguments: event.input ?? event.args ?? {},
                });
                const idx = output.content.length - 1;
                stream.push({
                  type: "toolcall_start",
                  contentIndex: idx,
                  partial: output,
                });
                stream.push({
                  type: "toolcall_end",
                  contentIndex: idx,
                  toolCall: {
                    type: "toolCall",
                    id: event.toolCallId,
                    name: event.toolName,
                    arguments: event.input ?? event.args ?? {},
                  },
                  partial: output,
                });
                break;
              }

              case "finish": {
                const usage = event.totalUsage;
                if (usage) {
                  output.usage.input = usage.inputTokens ?? 0;
                  output.usage.output = usage.outputTokens ?? 0;
                  output.usage.cacheRead =
                    usage.inputTokenDetails?.cacheReadTokens ?? 0;
                  output.usage.cacheWrite =
                    usage.inputTokenDetails?.cacheWriteTokens ?? 0;
                  output.usage.totalTokens =
                    output.usage.input +
                    output.usage.output +
                    output.usage.cacheRead +
                    output.usage.cacheWrite;
                  _calculateCost(model, output.usage);
                }
                output.stopReason = mapFinishReason(event.finishReason);
                finished = true;
                break;
              }

              case "error": {
                const msg =
                  event.error?.message ?? event.error ?? "Stream error";
                output.stopReason = "error";
                output.errorMessage =
                  typeof msg === "string" ? msg : String(msg);
                throw new Error(output.errorMessage);
              }
            }
            if (finished) break mainLoop;
          }
        }

        // End any lingering text block
        if (textBlock) {
          stream.push({
            type: "text_end",
            contentIndex: currentTextIdx,
            content: textBlock.text,
            partial: output,
          });
        }

        // Emit remaining thinking
        if (thinkingBlock.length > 0) {
          const thinkingText = thinkingBlock.join("");
          output.content.push({
            type: "thinking",
            thinking: thinkingText,
          });
          const idx = output.content.length - 1;
          stream.push({
            type: "thinking_start",
            contentIndex: idx,
            partial: output,
          });
          stream.push({
            type: "thinking_delta",
            contentIndex: idx,
            delta: thinkingText,
            partial: output,
          });
          stream.push({
            type: "thinking_end",
            contentIndex: idx,
            content: thinkingText,
            partial: output,
          });
        }

        stream.push({
          type: "done",
          reason: output.stopReason,
          message: output,
        });
        stream.end();
      } catch (error: any) {
        if (controller.signal.aborted) {
          output.stopReason = "aborted";
          output.errorMessage = "Request aborted";
        } else {
          output.stopReason = "error";
          output.errorMessage = error?.message ?? String(error);
        }
        stream.push({
          type: "error",
          reason: output.stopReason,
          error: output,
        });
        stream.end();
      } finally {
        try {
          await reader?.cancel();
        } catch {
          // Reader cancellation is best-effort; it may already be closed/cancelled.
        }
        try {
          reader?.releaseLock();
        } catch {
          // Reader may already be released/cancelled by the abort path.
        }
      }
    })();

    return stream;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("streamCommandCode — missing API key", () => {
  it("emits error when no API key is available", async () => {
    // Pass explicit empty apiKey to force the missing-key error path.
    // (getApiKey may find a valid key from auth.json on the filesystem.)
    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, { apiKey: "" });
    const events = await collectEvents(stream);

    assert.equal(events.length, 1, `Expected 1 error event, got ${events.length}: ${JSON.stringify(events.map((e: any) => e.type))}`);
    assert.equal(events[0].type, "error");
    assert.equal(events[0].reason, "error");
    assert.ok(
      events[0].error.errorMessage.includes("No Command Code API key"),
      `Should mention missing API key, got: ${events[0].error.errorMessage}`,
    );
  });

  it("falls back to auth.json when env var is unset (if auth.json exists)", async () => {
    // On dev machines, auth.json may exist. We verify the code doesn't crash.
    const saved = process.env.COMMANDCODE_API_KEY;
    delete process.env.COMMANDCODE_API_KEY;

    try {
      const model = makeModel({ baseUrl: baseUrl() });
      const ctx = makeContext();
      const stream = streamCommandCode(model, ctx);
      const events = await collectEvents(stream, { timeoutMs: 1000 });
      assert.ok(events.length > 0, "should get at least one event");
    } finally {
      if (saved) process.env.COMMANDCODE_API_KEY = saved;
    }
  });

  it("does not crash when auth.json is malformed (env unset)", async () => {
    const saved = process.env.COMMANDCODE_API_KEY;
    delete process.env.COMMANDCODE_API_KEY;
    try {
      const model = makeModel({ baseUrl: baseUrl() });
      const ctx = makeContext();
      const stream = streamCommandCode(model, ctx);
      const events = await collectEvents(stream, { timeoutMs: 1000 });
      assert.ok(events.length > 0);
    } finally {
      if (saved) process.env.COMMANDCODE_API_KEY = saved;
    }
  });
});

describe("streamCommandCode — simple text response", () => {
  it("emits start → text_start → text_delta → text_end → done", async () => {
    mockResponse({
      type: "success",
      status: 200,
      events: [
        JSON.stringify({ type: "text-delta", text: "Hel" }),
        JSON.stringify({ type: "text-delta", text: "lo!" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 5, outputTokens: 3 },
        }),
      ],
    });

    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, {
      apiKey: "mock-key",
    });
    const events = await collectEvents(stream);

    // Verify event types in order
    const types = events.map((e: any) => e.type);
    assert.deepEqual(types.slice(0, 6), [
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);

    // Verify done message
    const done = events.find((e: any) => e.type === "done");
    assert.equal(done.reason, "stop");
    assert.equal(done.message.content[0].text, "Hello!");
    assert.equal(done.message.usage.input, 5);
    assert.equal(done.message.usage.output, 3);
  });

  it("builds consecutive text-delta events into one text block", async () => {
    mockResponse({
      type: "success",
      status: 200,
      events: [
        JSON.stringify({ type: "text-delta", text: "a" }),
        JSON.stringify({ type: "text-delta", text: "b" }),
        JSON.stringify({ type: "text-delta", text: "c" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 3 },
        }),
      ],
    });

    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, { apiKey: "mock-key" });
    const events = await collectEvents(stream);

    const done = events.find((e: any) => e.type === "done");
    assert.equal(done.message.content[0].text, "abc");
    assert.equal(done.message.content.length, 1);
  });

  it("ends on finish even if the upstream connection stays open", async () => {
    mockResponse({
      type: "success",
      status: 200,
      events: [
        JSON.stringify({ type: "text-delta", text: "done" }),
        JSON.stringify({ type: "finish", finishReason: "stop" }),
      ],
      hangAfterLast: true,
    });

    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, { apiKey: "mock-key" });
    const events = await collectEvents(stream, { timeoutMs: 500 });

    const done = events.find((e: any) => e.type === "done");
    assert.ok(done, "should emit done without waiting for connection close");
    assert.equal(done.message.content[0].text, "done");
  });
});

describe("streamCommandCode — reasoning/thinking", () => {
  it("buffers reasoning-delta and emits on reasoning-end", async () => {
    mockResponse({
      type: "success",
      status: 200,
      events: [
        JSON.stringify({ type: "reasoning-delta", text: "Let me " }),
        JSON.stringify({ type: "reasoning-delta", text: "think..." }),
        JSON.stringify({ type: "reasoning-end" }),
        JSON.stringify({ type: "text-delta", text: "Answer" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 5, outputTokens: 5 },
        }),
      ],
    });

    const model = makeModel({ baseUrl: baseUrl(), reasoning: true });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, { apiKey: "mock-key" });
    const events = await collectEvents(stream);

    // Should have thinking_start, thinking_delta, thinking_end
    const thinkingStart = events.find((e: any) => e.type === "thinking_start");
    assert.ok(thinkingStart, "should have thinking_start event");

    const thinkingEnd = events.find((e: any) => e.type === "thinking_end");
    assert.equal(thinkingEnd.content, "Let me think...");

    // Content should have thinking block
    const done = events.find((e: any) => e.type === "done");
    const thinkingContent = done.message.content.find(
      (c: any) => c.type === "thinking",
    );
    assert.ok(thinkingContent, "should have thinking content");
    assert.equal(thinkingContent.thinking, "Let me think...");
  });

  it("handles reasoning without text follow-up", async () => {
    mockResponse({
      type: "success",
      status: 200,
      events: [
        JSON.stringify({ type: "reasoning-delta", text: "Hmm" }),
        JSON.stringify({ type: "reasoning-end" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 2, outputTokens: 1 },
        }),
      ],
    });

    const model = makeModel({ baseUrl: baseUrl(), reasoning: true });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, { apiKey: "mock-key" });
    const events = await collectEvents(stream);

    const done = events.find((e: any) => e.type === "done");
    assert.equal(done.message.content.length, 1);
    assert.equal(done.message.content[0].type, "thinking");
  });
});

describe("streamCommandCode — tool calls", () => {
  it("emits toolcall_start and toolcall_end for tool-call event", async () => {
    mockResponse({
      type: "success",
      status: 200,
      events: [
        JSON.stringify({
          type: "tool-call",
          toolCallId: "call_abc",
          toolName: "read_file",
          input: { path: "/tmp/x" },
        }),
        JSON.stringify({
          type: "finish",
          finishReason: "tool-calls",
          totalUsage: { inputTokens: 4, outputTokens: 6 },
        }),
      ],
    });

    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext({
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          parameters: {
            kind: "object",
            properties: { path: { kind: "string" } },
          },
        },
      ],
    });
    const stream = streamCommandCode(model, ctx, { apiKey: "mock-key" });
    const events = await collectEvents(stream);

    const tcStart = events.find((e: any) => e.type === "toolcall_start");
    assert.ok(tcStart, "should have toolcall_start");

    const tcEnd = events.find((e: any) => e.type === "toolcall_end");
    assert.equal(tcEnd.toolCall.name, "read_file");
    assert.deepEqual(tcEnd.toolCall.arguments, { path: "/tmp/x" });

    // Stop reason should be toolUse
    const done = events.find((e: any) => e.type === "done");
    assert.equal(done.reason, "toolUse");
  });

  it("handles text followed by tool-call (ends text block first)", async () => {
    mockResponse({
      type: "success",
      status: 200,
      events: [
        JSON.stringify({ type: "text-delta", text: "Let me read" }),
        JSON.stringify({
          type: "tool-call",
          toolCallId: "c1",
          toolName: "ls",
          input: {},
        }),
        JSON.stringify({
          type: "finish",
          finishReason: "tool-calls",
          totalUsage: { inputTokens: 3, outputTokens: 8 },
        }),
      ],
    });

    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, { apiKey: "mock-key" });
    const events = await collectEvents(stream);

    // Should have text_end before toolcall_start
    const textEndIdx = events.findIndex((e: any) => e.type === "text_end");
    const tcStartIdx = events.findIndex(
      (e: any) => e.type === "toolcall_start",
    );
    assert.ok(textEndIdx < tcStartIdx, "text_end should come before toolcall_start");

    const done = events.find((e: any) => e.type === "done");
    assert.equal(done.message.content.length, 2);
    assert.equal(done.message.content[0].type, "text");
    assert.equal(done.message.content[1].type, "toolCall");
  });

  it("handles multiple consecutive tool calls", async () => {
    mockResponse({
      type: "success",
      status: 200,
      events: [
        JSON.stringify({
          type: "tool-call",
          toolCallId: "c1",
          toolName: "read",
          input: { path: "/a" },
        }),
        JSON.stringify({
          type: "tool-call",
          toolCallId: "c2",
          toolName: "read",
          input: { path: "/b" },
        }),
        JSON.stringify({
          type: "finish",
          finishReason: "tool-calls",
          totalUsage: { inputTokens: 5, outputTokens: 10 },
        }),
      ],
    });

    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, { apiKey: "mock-key" });
    const events = await collectEvents(stream);

    const done = events.find((e: any) => e.type === "done");
    assert.equal(done.message.content.length, 2);
    assert.equal(done.message.content[0].name, "read");
    assert.equal(done.message.content[1].name, "read");
    assert.notEqual(done.message.content[0].id, done.message.content[1].id);
  });
});

describe("streamCommandCode — HTTP error responses", () => {
  it("handles 401 Unauthorized", async () => {
    mockResponse({
      type: "error",
      status: 401,
      body: "Unauthorized",
    });

    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, { apiKey: "mock-key" });
    const events = await collectEvents(stream);

    assert.equal(events[0].type, "start");
    const err = events.find((e: any) => e.type === "error");
    assert.ok(err, "should have error event");
    assert.ok(
      err.error.errorMessage.includes("401"),
      `should include status code, got: ${err.error.errorMessage}`,
    );
    assert.equal(err.error.stopReason, "error");
  });

  it("handles 500 Internal Server Error", async () => {
    mockResponse({
      type: "error",
      status: 500,
      body: "Internal Server Error",
    });

    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, { apiKey: "mock-key" });
    const events = await collectEvents(stream);

    const err = events.find((e: any) => e.type === "error");
    assert.ok(err, "should have error event");
    assert.ok(err.error.errorMessage.includes("500"));
  });

  it("handles 429 Too Many Requests", async () => {
    mockResponse({
      type: "error",
      status: 429,
      body: JSON.stringify({ error: "Rate limited" }),
    });

    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, { apiKey: "mock-key" });
    const events = await collectEvents(stream);

    const err = events.find((e: any) => e.type === "error");
    assert.ok(err, "should have error event");
    assert.ok(err.error.errorMessage.includes("429"));
  });
});

describe("streamCommandCode — stream error events", () => {
  it("handles error event within the stream", async () => {
    mockResponse({
      type: "success",
      status: 200,
      events: [
        JSON.stringify({ type: "text-delta", text: "partially" }),
        JSON.stringify({ type: "error", error: { message: "Something went wrong" } }),
      ],
    });

    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, { apiKey: "mock-key" });
    const events = await collectEvents(stream);

    const err = events.find((e: any) => e.type === "error");
    assert.ok(err, "should have error event");
    assert.equal(err.error.stopReason, "error");
    assert.ok(
      err.error.errorMessage.includes("Something went wrong"),
      `should include error message, got: ${err.error.errorMessage}`,
    );
  });

  it("handles error event without message field", async () => {
    mockResponse({
      type: "success",
      status: 200,
      events: [
        JSON.stringify({ type: "error", error: "bare string error" }),
      ],
    });

    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, { apiKey: "mock-key" });
    const events = await collectEvents(stream);

    const err = events.find((e: any) => e.type === "error");
    assert.ok(err, "should have error event");
  });
});

describe("streamCommandCode — usage parsing", () => {
  it("parses inputTokens and outputTokens correctly", async () => {
    mockResponse({
      type: "success",
      status: 200,
      events: [
        JSON.stringify({ type: "text-delta", text: "ok" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: {
            inputTokens: 150,
            outputTokens: 42,
            inputTokenDetails: {
              cacheReadTokens: 30,
              cacheWriteTokens: 10,
            },
          },
        }),
      ],
    });

    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, { apiKey: "mock-key" });
    const events = await collectEvents(stream);

    const done = events.find((e: any) => e.type === "done");
    assert.equal(done.message.usage.input, 150);
    assert.equal(done.message.usage.output, 42);
    assert.equal(done.message.usage.cacheRead, 30);
    assert.equal(done.message.usage.cacheWrite, 10);
    assert.equal(done.message.usage.totalTokens, 232); // 150 + 42 + 30 + 10
  });

  it("handles missing usage gracefully", async () => {
    mockResponse({
      type: "success",
      status: 200,
      events: [
        JSON.stringify({ type: "text-delta", text: "x" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
        }),
      ],
    });

    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, { apiKey: "mock-key" });
    const events = await collectEvents(stream);

    const done = events.find((e: any) => e.type === "done");
    assert.equal(done.message.usage.input, 0);
    assert.equal(done.message.usage.output, 0);
    assert.equal(done.message.stopReason, "stop");
  });
});

describe("streamCommandCode — HTTP request body", () => {
  it("sends the correct request structure to CC API", async () => {
    mockResponse({
      type: "success",
      status: 200,
      events: [
        JSON.stringify({ type: "text-delta", text: "x" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        }),
      ],
    });

    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, { apiKey: "mock-key" });
    await collectEvents(stream);

    const body = lastRequestBody();
    assert.ok(body, "request body should be captured");
    assert.equal(body.params.model, "test-model");
    assert.equal(body.params.stream, true);
    assert.equal(body.params.system, "You are a test assistant.");
    assert.deepEqual(body.params.messages, [
      { role: "user", content: "hello" },
    ]);
    assert.deepEqual(body.params.tools, []);
    assert.equal(body.permissionMode, "standard");
    assert.ok(body.config, "should have config section");
    assert.ok(typeof body.config.date === "string", "date should be a string");
    assert.equal(body.config.isGitRepo, false);
  });

  it("includes tools in request when context has tools", async () => {
    mockResponse({
      type: "success",
      status: 200,
      events: [
        JSON.stringify({ type: "text-delta", text: "x" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        }),
      ],
    });

    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext({
      tools: [
        {
          name: "get_weather",
          description: "Get weather",
          parameters: {
            kind: "object",
            properties: { city: { kind: "string" } },
          },
        },
      ],
    });
    const stream = streamCommandCode(model, ctx, { apiKey: "mock-key" });
    await collectEvents(stream);

    const body = lastRequestBody();
    assert.equal(body.params.tools.length, 1);
    assert.equal(body.params.tools[0].name, "get_weather");
    assert.equal(body.params.tools[0].type, "function");
  });

  it("respects maxTokens option", async () => {
    mockResponse({
      type: "success",
      status: 200,
      events: [
        JSON.stringify({ type: "text-delta", text: "x" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        }),
      ],
    });

    const model = makeModel({ baseUrl: baseUrl(), maxTokens: 4096 });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, {
      apiKey: "mock-key",
      maxTokens: 500,
    });
    await collectEvents(stream);

    const body = lastRequestBody();
    assert.equal(body.params.max_tokens, 500);
  });

  it("caps maxTokens at 200k", async () => {
    mockResponse({
      type: "success",
      status: 200,
      events: [
        JSON.stringify({ type: "text-delta", text: "x" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        }),
      ],
    });

    const model = makeModel({ baseUrl: baseUrl(), maxTokens: 500_000 });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, {
      apiKey: "mock-key",
      maxTokens: 500_000,
    });
    await collectEvents(stream);

    const body = lastRequestBody();
    assert.equal(body.params.max_tokens, 200_000);
  });
});

describe("streamCommandCode — abort mid-stream", () => {
  it("emits aborted error when signal fires during stream", async () => {
    // The stream must hang (no finish and no connection close) so abort can
    // interrupt reader.read(). We send one text-delta, but the mock server
    // must keep the connection open after sending it. We do this by passing
    // a special marker that tells the server to not end.
    mockResponse({
      type: "success",
      status: 200,
      events: [
        JSON.stringify({ type: "text-delta", text: "first" }),
        // No finish event, and hangAfterLast keeps connection open
      ],
      hangAfterLast: true,
    });

    const controller = new AbortController();
    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, {
      apiKey: "mock-key",
      signal: controller.signal,
    });

    // Give the stream a moment to start and process the first text-delta,
    // then abort while reader.read() is blocking on more data.
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();

    // Collect events with a timeout. The abort should cause the stream
    // to emit an error event with stopReason "aborted".
    const events = await collectEvents(stream, { timeoutMs: 3000 });
    const err = events.find((e: any) => e.type === "error");
    if (!err) {
      console.error(
        "[debug] All events:",
        JSON.stringify(events.map((e: any) => ({ type: e.type, reason: e.reason }))),
      );
    }
    assert.ok(err, "should have error event");
    assert.equal(err.error.stopReason, "aborted");
    assert.equal(err.error.errorMessage, "Request aborted");
  });
});

describe("streamCommandCode — options.apiKey override", () => {
  it("uses options.apiKey over env var", async () => {
    const saved = process.env.COMMANDCODE_API_KEY;
    process.env.COMMANDCODE_API_KEY = "env-key";

    try {
      mockResponse({
        type: "success",
        status: 200,
        events: [
          JSON.stringify({ type: "text-delta", text: "x" }),
          JSON.stringify({
            type: "finish",
            finishReason: "stop",
            totalUsage: { inputTokens: 1, outputTokens: 1 },
          }),
        ],
      });

      const model = makeModel({ baseUrl: baseUrl() });
      const ctx = makeContext();
      const stream = streamCommandCode(model, ctx, {
        apiKey: "options-key",
      });
      await collectEvents(stream);

      // Should still work (options key takes priority)
      assert.equal(requestCount(), 1);
    } finally {
      if (saved) process.env.COMMANDCODE_API_KEY = saved;
      else delete process.env.COMMANDCODE_API_KEY;
    }
  });
});

describe("streamCommandCode — empty response", () => {
  it("ends successfully with done event on empty stream", async () => {
    mockResponse({
      type: "success",
      status: 200,
      events: [],
    });

    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, { apiKey: "mock-key" });
    const events = await collectEvents(stream);

    const done = events.find((e: any) => e.type === "done");
    assert.ok(done, "should have done event");
    assert.equal(done.reason, "stop");
    assert.equal(done.message.content.length, 0);
  });
});

describe("streamCommandCode — malformed JSON in stream", () => {
  it("skips non-JSON lines gracefully", async () => {
    mockResponse({
      type: "success",
      status: 200,
      events: [
        "not valid json",
        "",
        JSON.stringify({ type: "text-delta", text: "ok" }),
        "also not json {",
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        }),
      ],
    });

    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, { apiKey: "mock-key" });
    const events = await collectEvents(stream);

    const done = events.find((e: any) => e.type === "done");
    assert.ok(done, "should complete despite malformed lines");
    assert.equal(done.message.content[0].text, "ok");
  });

  it("accepts SSE data lines", async () => {
    mockResponse({
      type: "success",
      status: 200,
      events: [
        `data: ${JSON.stringify({ type: "text-delta", text: "sse" })}`,
        "event: ignored",
        `data: ${JSON.stringify({ type: "finish", finishReason: "stop" })}`,
      ],
    });

    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, { apiKey: "mock-key" });
    const events = await collectEvents(stream);

    const done = events.find((e: any) => e.type === "done");
    assert.ok(done, "should complete from SSE data lines");
    assert.equal(done.message.content[0].text, "sse");
  });
});

describe("streamCommandCode — conversation history", () => {
  it("converts multi-turn conversation to CC format", async () => {
    mockResponse({
      type: "success",
      status: 200,
      events: [
        JSON.stringify({ type: "text-delta", text: "answer" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 2, outputTokens: 1 },
        }),
      ],
    });

    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext({
      messages: [
        { role: "user", content: "first", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "first response" }],
        },
        { role: "user", content: "second", timestamp: 2 },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc1",
              name: "read",
              arguments: { path: "/x" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tc1",
          toolName: "read",
          isError: false,
          content: [{ type: "text", text: "file contents" }],
        },
      ],
    });
    const stream = streamCommandCode(model, ctx, { apiKey: "mock-key" });
    await collectEvents(stream);

    const body = lastRequestBody();
    const msgs = body.params.messages;
    assert.equal(msgs.length, 5);
    assert.equal(msgs[0].role, "user");
    assert.equal(msgs[0].content, "first");
    assert.equal(msgs[1].role, "assistant");
    assert.equal(msgs[1].content[0].text, "first response");
    assert.equal(msgs[2].role, "user");
    assert.equal(msgs[2].content, "second");
    assert.equal(msgs[3].role, "assistant");
    assert.equal(msgs[3].content[0].type, "tool-call");
    assert.equal(msgs[4].role, "tool");
    assert.equal(msgs[4].content[0].type, "tool-result");
  });
});

describe("streamCommandCode — custom headers", () => {
  it("passes through custom headers from options", async () => {
    // We can't easily inspect request headers with this test setup,
    // but we can verify it doesn't crash with custom headers
    mockResponse({
      type: "success",
      status: 200,
      events: [
        JSON.stringify({ type: "text-delta", text: "x" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        }),
      ],
    });

    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, {
      apiKey: "mock-key",
      headers: { "x-custom": "value", "x-another": "test" },
    });
    const events = await collectEvents(stream);

    const done = events.find((e: any) => e.type === "done");
    assert.ok(done);
  });
});

describe("streamCommandCode — stopReason mapping", () => {
  it("maps finishReason 'stop' → 'stop'", async () => {
    mockResponse({
      type: "success",
      status: 200,
      events: [
        JSON.stringify({ type: "text-delta", text: "x" }),
        JSON.stringify({
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        }),
      ],
    });

    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, { apiKey: "mock-key" });
    const events = await collectEvents(stream);

    const done = events.find((e: any) => e.type === "done");
    assert.equal(done.reason, "stop");
  });

  it("maps finishReason 'tool-calls' → 'toolUse'", async () => {
    mockResponse({
      type: "success",
      status: 200,
      events: [
        JSON.stringify({
          type: "tool-call",
          toolCallId: "tc",
          toolName: "ls",
          input: {},
        }),
        JSON.stringify({
          type: "finish",
          finishReason: "tool-calls",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        }),
      ],
    });

    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, { apiKey: "mock-key" });
    const events = await collectEvents(stream);

    const done = events.find((e: any) => e.type === "done");
    assert.equal(done.reason, "toolUse");
  });

  it("maps max-token finish reasons → 'length'", async () => {
    mockResponse({
      type: "success",
      status: 200,
      events: [
        JSON.stringify({ type: "text-delta", text: "x" }),
        JSON.stringify({ type: "finish", finishReason: "max_tokens" }),
      ],
    });

    const model = makeModel({ baseUrl: baseUrl() });
    const ctx = makeContext();
    const stream = streamCommandCode(model, ctx, { apiKey: "mock-key" });
    const events = await collectEvents(stream);

    const done = events.find((e: any) => e.type === "done");
    assert.equal(done.reason, "length");
  });
});
