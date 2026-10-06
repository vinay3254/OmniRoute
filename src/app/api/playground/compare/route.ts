/**
 * POST /api/playground/compare
 *
 * Sends one prompt to several models/combos (max 8) in parallel through the normal
 * /v1/chat/completions pipeline and returns each output with latency, token usage and the
 * model that actually answered (a combo can fall back to a different model).
 *
 * Auth: the caller's credentials (API key or dashboard session) are forwarded to every
 * chat call, so the chat route enforces the same auth/policy as a direct request.
 */

import { buildErrorBody, sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { POST as chatCompletions } from "@/app/api/v1/chat/completions/route";
import { runCompare } from "@/lib/playground/compare";
import { PlaygroundCompareRequestSchema } from "@/shared/schemas/playground";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function errorResp(status: number, message: string): Response {
  return new Response(JSON.stringify(buildErrorBody(status, sanitizeErrorMessage(message))), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResp(HTTP_STATUS.BAD_REQUEST, "Request body must be valid JSON");
  }

  const validation = validateBody(PlaygroundCompareRequestSchema, raw);
  if (isValidationFailure(validation)) {
    return new Response(JSON.stringify(validation.error), {
      status: HTTP_STATUS.BAD_REQUEST,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  try {
    const results = await runCompare({
      body: validation.data,
      url: request.url,
      headers: request.headers,
      chat: chatCompletions,
    });
    return new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  } catch (err: unknown) {
    return errorResp(
      HTTP_STATUS.SERVER_ERROR,
      err instanceof Error ? err.message : "Compare failed"
    );
  }
}
