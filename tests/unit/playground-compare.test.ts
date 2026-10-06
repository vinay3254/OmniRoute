import assert from "node:assert/strict";
import { test } from "node:test";

import { runCompare } from "../../src/lib/playground/compare.ts";
import { PlaygroundCompareRequestSchema } from "../../src/shared/schemas/playground.ts";

type ChatBody = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
};

const URL_ = "http://localhost:20128/api/playground/compare";

function completion(model: string, content: string | null) {
  return {
    model,
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function incomingHeaders(): Headers {
  return new Headers({ authorization: "Bearer caller-key", "content-length": "999" });
}

const echoChat = async (request: Request) => {
  const body = (await request.json()) as ChatBody;
  return json(200, completion(`real/${body.model}`, `answer from ${body.model}`));
};

test("fans out in parallel, keeps request order, reports the answering model", async () => {
  const chat = async (request: Request) => {
    const body = (await request.json()) as ChatBody;
    if (body.model === "slow") await new Promise((r) => setTimeout(r, 150));
    return json(200, completion(`real/${body.model}`, `answer from ${body.model}`));
  };
  const started = Date.now();
  const results = await runCompare({
    body: { prompt: "hi", models: ["slow", "fast"] },
    url: URL_,
    headers: incomingHeaders(),
    chat,
  });
  assert.deepEqual(
    results.map((r) => r.model),
    ["slow", "fast"]
  );
  const [slow, fast] = results;
  assert.equal(slow.ok, true);
  assert.equal(slow.ok && slow.output, "answer from slow");
  assert.equal(slow.ok && slow.resolvedModel, "real/slow");
  assert.deepEqual(fast.ok && fast.usage, {
    prompt_tokens: 1,
    completion_tokens: 2,
    total_tokens: 3,
  });
  assert.ok(slow.latencyMs >= 100, "slow latency is measured");
  assert.ok(Date.now() - started < 1000, "models run in parallel");
});

test("duplicate models both run and both appear", async () => {
  let calls = 0;
  const results = await runCompare({
    body: { prompt: "hi", models: ["smart", "smart"] },
    url: URL_,
    headers: incomingHeaders(),
    chat: async (request) => {
      calls++;
      return echoChat(request);
    },
  });
  assert.equal(results.length, 2);
  assert.equal(calls, 2);
});

test("forwards caller auth, system message and params; non-streaming", async () => {
  let seen: ChatBody | undefined;
  let seenAuth: string | null = null;
  let seenUrl = "";
  await runCompare({
    body: { prompt: "hi", system: "be brief", models: ["a"], temperature: 0.2, max_tokens: 50 },
    url: URL_,
    headers: incomingHeaders(),
    chat: async (request) => {
      seen = (await request.clone().json()) as ChatBody;
      seenAuth = request.headers.get("authorization");
      seenUrl = request.url;
      return echoChat(request);
    },
  });
  assert.deepEqual(seen?.messages, [
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(seen?.temperature, 0.2);
  assert.equal(seen?.max_tokens, 50);
  assert.equal(seen?.stream, false);
  assert.equal(seenAuth, "Bearer caller-key");
  assert.equal(new URL(seenUrl).pathname, "/v1/chat/completions");
});

test("a failing model becomes an error entry with a sanitized message", async () => {
  const HOSTILE_PATH = "/home/runner/work/OmniRoute/src/lib/db/secret-internals.ts";
  const HOSTILE_TOKEN = "sk-live-ABC123SUPERSECRETTOKEN";
  const chat = async (request: Request) => {
    const body = (await request.json()) as ChatBody;
    if (body.model === "bad") {
      return json(500, {
        error: { message: `boom at ${HOSTILE_PATH}:42:7 token=${HOSTILE_TOKEN}` },
      });
    }
    return json(200, completion(body.model, "ok"));
  };
  const results = await runCompare({
    body: { prompt: "hi", models: ["bad", "good"] },
    url: URL_,
    headers: incomingHeaders(),
    chat,
  });
  const [bad, good] = results;
  assert.equal(bad.ok, false);
  const error = bad.ok ? "" : bad.error;
  assert.ok(error.startsWith("upstream 500:"), error);
  assert.ok(!error.includes(HOSTILE_PATH), `path leaked: ${error}`);
  assert.ok(!error.includes(HOSTILE_TOKEN), `token leaked: ${error}`);
  assert.equal(good.ok, true);
});

test("a handler that throws becomes an error entry and does not reject the batch", async () => {
  const results = await runCompare({
    body: { prompt: "hi", models: ["boom", "ok"] },
    url: URL_,
    headers: incomingHeaders(),
    chat: async (request) => {
      const body = (await request.clone().json()) as ChatBody;
      if (body.model === "boom") throw new Error("kaboom");
      return echoChat(request);
    },
  });
  assert.equal(results[0].ok, false);
  assert.equal(results[1].ok, true);
});

test("a hanging model times out without blocking the others", async () => {
  const results = await runCompare({
    body: { prompt: "hi", models: ["hang", "ok"] },
    url: URL_,
    headers: incomingHeaders(),
    timeoutMs: 100,
    chat: async (request) => {
      const body = (await request.clone().json()) as ChatBody;
      if (body.model === "hang") return new Promise<Response>(() => {});
      return echoChat(request);
    },
  });
  assert.equal(results[0].ok, false);
  assert.equal(results[0].ok === false && results[0].error, "timeout");
  assert.equal(results[1].ok, true);
});

test("HTTP 200 with null content is reported as an error entry", async () => {
  const results = await runCompare({
    body: { prompt: "hi", models: ["a"] },
    url: URL_,
    headers: incomingHeaders(),
    chat: async () => json(200, completion("x", null)),
  });
  assert.equal(results[0].ok, false);
  assert.equal(
    results[0].ok === false && results[0].error,
    "upstream response had no message content"
  );
});

test("request schema accepts 1-8 models and rejects bad bodies", () => {
  const eight = Array.from({ length: 8 }, (_, i) => `m${i}`);
  const nine = Array.from({ length: 9 }, (_, i) => `m${i}`);
  assert.ok(PlaygroundCompareRequestSchema.safeParse({ prompt: "hi", models: eight }).success);
  const bad = [
    { prompt: "", models: ["a"] },
    { prompt: "   ", models: ["a"] },
    { prompt: "hi", models: [] },
    { prompt: "hi" },
    { prompt: "hi", models: [""] },
    { prompt: "hi", models: nine },
    { prompt: "hi", models: ["a"], system: 5 },
    { prompt: "hi", models: ["a"], temperature: "hot" },
    { prompt: "hi", models: ["a"], max_tokens: 0 },
    { prompt: "hi", models: ["a"], max_tokens: 1.5 },
  ];
  for (const body of bad) {
    assert.equal(
      PlaygroundCompareRequestSchema.safeParse(body).success,
      false,
      JSON.stringify(body)
    );
  }
});
