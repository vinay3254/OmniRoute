import assert from "node:assert/strict";
import { test } from "node:test";

const URL_ = "http://localhost:20128/api/playground/compare";

function post(body: string): Request {
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("compare route: invalid JSON returns 400 without leaking internals", async () => {
  const { POST } = await import("../../src/app/api/playground/compare/route.ts");
  const response = await POST(post("{not json"));
  assert.equal(response.status, 400);
  const raw = await response.text();
  assert.ok(!raw.includes("at /"), `stack trace leaked: ${raw}`);
  assert.ok(!raw.includes("Unexpected token"), `parser internals leaked: ${raw}`);
});

test("compare route: body failing the schema returns 400", async () => {
  const { POST } = await import("../../src/app/api/playground/compare/route.ts");
  for (const body of [
    { prompt: "", models: ["a"] },
    { prompt: "hi", models: [] },
    { prompt: "hi" },
  ]) {
    const response = await POST(post(JSON.stringify(body)));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
});

test("compare route: OPTIONS answers the CORS preflight", async () => {
  const { OPTIONS } = await import("../../src/app/api/playground/compare/route.ts");
  const response = await OPTIONS();
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
});
