// src/lib/playground/compare.ts
//
// Fan one prompt out to several models/combos through the normal chat pipeline and
// return each output next to its latency, usage and the model that actually answered.
// The chat handler is injected so the pipeline (auth, combo routing, fallback) stays the
// single source of truth and this module stays unit-testable.

import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";
import type { PlaygroundCompareRequest } from "@/shared/schemas/playground";

export const COMPARE_TARGET_TIMEOUT_MS = 120_000;
const MAX_ERROR_CHARS = 300;

export type ChatHandler = (request: Request) => Promise<Response>;

export interface CompareUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export type PlaygroundCompareResult =
  | {
      model: string;
      ok: true;
      output: string;
      resolvedModel: string | null;
      latencyMs: number;
      usage: CompareUsage | null;
    }
  | { model: string; ok: false; error: string; latencyMs: number };

interface RunCompareOptions {
  body: PlaygroundCompareRequest;
  /** URL of the incoming compare request; the chat URL is derived from its origin. */
  url: string;
  /** Incoming request headers; forwarded so the caller's auth applies to every chat call. */
  headers: Headers;
  chat: ChatHandler;
  timeoutMs?: number;
}

function upstreamMessage(text: string): string {
  try {
    const error = JSON.parse(text)?.error;
    if (typeof error === "string") return error;
    if (typeof error?.message === "string") return error.message;
  } catch {
    // not JSON: fall through to the raw text
  }
  return text;
}

function truncate(text: string): string {
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

class CompareTimeoutError extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CompareTimeoutError("timeout")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function compareOne(
  model: string,
  { body, url, headers, chat, timeoutMs = COMPARE_TARGET_TIMEOUT_MS }: RunCompareOptions
): Promise<PlaygroundCompareResult> {
  const started = Date.now();
  const fail = (error: string): PlaygroundCompareResult => ({
    model,
    ok: false,
    error: sanitizeErrorMessage(error),
    latencyMs: Date.now() - started,
  });

  const messages = [
    ...(body.system ? [{ role: "system", content: body.system }] : []),
    { role: "user", content: body.prompt },
  ];
  const payload: Record<string, unknown> = { model, messages, stream: false };
  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (body.max_tokens !== undefined) payload.max_tokens = body.max_tokens;

  const chatHeaders = new Headers(headers);
  chatHeaders.delete("content-length");
  chatHeaders.set("content-type", "application/json");
  const request = new Request(new URL("/v1/chat/completions", url), {
    method: "POST",
    headers: chatHeaders,
    body: JSON.stringify(payload),
  });

  try {
    const { status, text } = await withTimeout(
      chat(request).then(async (res) => ({ status: res.status, text: await res.text() })),
      timeoutMs
    );
    if (status < 200 || status >= 300) {
      return fail(`upstream ${status}: ${truncate(upstreamMessage(text))}`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return fail("upstream returned invalid JSON");
    }
    const output = data?.choices?.[0]?.message?.content;
    if (typeof output !== "string") return fail("upstream response had no message content");
    return {
      model,
      ok: true,
      output,
      resolvedModel: typeof data.model === "string" ? data.model : null,
      latencyMs: Date.now() - started,
      usage: data.usage ?? null,
    };
  } catch (err) {
    if (err instanceof CompareTimeoutError) return fail("timeout");
    return fail(err instanceof Error ? err.message : "request failed");
  }
}

/** Never rejects: each model's failure becomes its own `{ ok: false }` entry, in request order. */
export function runCompare(options: RunCompareOptions): Promise<PlaygroundCompareResult[]> {
  return Promise.all(options.body.models.map((model) => compareOne(model, options)));
}
