#!/usr/bin/env node
// Static validation harness for the Qwen Lemonade thinking workaround
// (Pi issue #4862). Feeds synthetic LemonadeModelInfo records through
// mapToProviderModel and asserts the registered compat shape.
//
// Run: npm test  (or: node --import tsx scripts/test-qwen-mapping.mjs)
//
// Loads extensions/index.ts via tsx (declared in devDependencies). tsx is
// not a runtime dep — only needed for this harness.

import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const mod = await import(
  pathToFileURL(path.resolve("extensions/index.ts")).href
);
const {
  DEFAULT_CONTEXT_WINDOW,
  formatLemonadeError,
  readSseJsonError,
  loadedContextWindowsFromHealth,
  loadRequestBodyForModel,
  mapToProviderModel,
} = mod.__test__;

function mk(overrides) {
  return {
    id: "Qwen3.6-35B-A3B-MTP-GGUF-UD-Q4_K_M",
    name: "Qwen3.6 35B",
    labels: [],
    ...overrides,
  };
}

test("Qwen id with no reasoning label still gets qwen-chat-template compat", () => {
  const out = mapToProviderModel(mk({ labels: [] }));
  assert.equal(out.reasoning, true, "reasoning forced true for Qwen");
  assert.equal(out.compat?.thinkingFormat, "qwen-chat-template");
  assert.equal(out.compat?.requiresReasoningContentOnAssistantMessages, true);
  assert.equal(
    out.compat?.supportsReasoningEffort,
    undefined,
    "supportsReasoningEffort omitted: qwen-chat-template branch ignores it",
  );
  // thinkingLevelMap collapses Pi's intermediate levels.
  assert.equal(out.thinkingLevelMap?.minimal, null);
  assert.equal(out.thinkingLevelMap?.low, null);
  assert.equal(out.thinkingLevelMap?.medium, null);
  assert.equal(out.thinkingLevelMap?.xhigh, null);
});

test("Qwen name-only match (id missing qwen) still triggers compat", () => {
  const out = mapToProviderModel(
    mk({ id: "vendor-checkpoint-7b", name: "Qwen Custom Build" }),
  );
  assert.equal(out.reasoning, true);
  assert.equal(out.compat?.thinkingFormat, "qwen-chat-template");
});

test("non-Qwen reasoning model is unchanged (no qwen compat, no thinkingLevelMap)", () => {
  const out = mapToProviderModel(
    mk({
      id: "DeepSeek-R1-Distill-Llama-8B",
      name: "DeepSeek R1",
      labels: ["reasoning"],
    }),
  );
  // Sanity: id/name above intentionally lack "qwen".
  assert.equal(out.reasoning, true, "reasoning label honored");
  assert.equal(out.compat, undefined, "no Qwen compat for non-Qwen models");
  assert.equal(out.thinkingLevelMap, undefined);
});

test("non-Qwen non-reasoning model is unchanged", () => {
  const out = mapToProviderModel(
    mk({ id: "llama-3.1-8b-instruct", name: "Llama 3.1 8B", labels: [] }),
  );
  assert.equal(out.reasoning, false);
  assert.equal(out.compat, undefined);
  assert.equal(out.thinkingLevelMap, undefined);
});

test("case-insensitive matching: lowercase qwen in id triggers compat", () => {
  const out = mapToProviderModel(
    mk({ id: "qwen2-coder-7b", name: "Coder", labels: [] }),
  );
  assert.equal(out.reasoning, true);
  assert.equal(out.compat?.thinkingFormat, "qwen-chat-template");
});

test("max_context_window is the registered contextWindow default", () => {
  const windows = loadedContextWindowsFromHealth({
    status: "ok",
    version: "10.6.0",
    model_loaded: "Qwen3-Coder-Next-GGUF-Q4_K_M",
    all_models_loaded: [
      {
        model_name: "Qwen3-Coder-Next-GGUF-Q4_K_M",
        checkpoint: "unsloth/Qwen3-Coder-Next-GGUF:Q4_K_M",
        recipe: "llamacpp",
        recipe_options: { ctx_size: 4096 },
      },
    ],
  });
  const out = mapToProviderModel(
    mk({ id: "Qwen3-Coder-Next-GGUF-Q4_K_M", max_context_window: 262144 }),
    windows,
  );
  assert.equal(out.contextWindow, 262144);
});

test("unloaded models use theoretical max_context_window", () => {
  const out = mapToProviderModel(mk({ max_context_window: 262144 }));
  assert.equal(out.contextWindow, 262144);
});

test("models without max_context_window fall back to loaded health ctx_size", () => {
  const windows = loadedContextWindowsFromHealth({
    status: "ok",
    version: "10.6.0",
    model_loaded: "Qwen Custom Build",
    all_models_loaded: [
      {
        model_name: "Qwen Custom Build",
        recipe: "llamacpp",
        recipe_options: { ctx_size: "32768" },
      },
    ],
  });
  const out = mapToProviderModel(
    mk({ id: "vendor-checkpoint-7b", name: "Qwen Custom Build" }),
    windows,
  );
  assert.equal(out.contextWindow, 32768);
});

test("models without max_context_window or loaded ctx_size use conservative fallback", () => {
  const out = mapToProviderModel(mk({ max_context_window: undefined }));
  assert.equal(out.contextWindow, DEFAULT_CONTEXT_WINDOW);
});

test("load request includes max_context_window as ctx_size for context-size recipes", () => {
  const body = loadRequestBodyForModel(
    "Qwen3-Coder-Next-GGUF-Q4_K_M",
    mk({ id: "Qwen3-Coder-Next-GGUF-Q4_K_M", recipe: "llamacpp", max_context_window: 262144 }),
  );
  assert.deepEqual(body, {
    model_name: "Qwen3-Coder-Next-GGUF-Q4_K_M",
    ctx_size: 262144,
  });
});

test("load request omits ctx_size for recipes that do not support it", () => {
  const body = loadRequestBodyForModel(
    "stable-diffusion-xl",
    mk({ id: "stable-diffusion-xl", recipe: "sd-cpp", max_context_window: 262144 }),
  );
  assert.deepEqual(body, { model_name: "stable-diffusion-xl" });
});

test("Lemonade context overflow error is normalized for pi auto-compaction", () => {
  const message = formatLemonadeError({
    error: {
      code: 400,
      message: "request (16047 tokens) exceeds the available context size (4096 tokens), try increasing it",
      type: "exceed_context_size_error",
      n_prompt_tokens: 16047,
      n_ctx: 4096,
    },
  });
  assert.match(message, /^context_length_exceeded:/);
  assert.match(message, /exceed_context_size_error/);
  assert.match(message, /code=400/);
  assert.match(message, /prompt tokens=16047, ctx=4096/);
});

test("SSE-wrapped raw JSON error body is detected", async () => {
  const response = new Response(
    JSON.stringify({
      error: {
        code: 400,
        message: "bad request",
        type: "bad_request_error",
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
  const message = await readSseJsonError(response);
  assert.equal(message, "Lemonade API error: bad request (bad_request_error, code=400)");
});
