/**
 * @lemonade/lemonade-provider
 *
 * Pi.dev extension for Lemonade local LLM server.
 *
 * Integrates with Pi's built-in /login selector by registering Lemonade as a
 * custom provider with an oauth block. Picking "Lemonade" in /login runs the
 * login flow below, which:
 *   1. Discovers servers via Lemonade's UDP beacon (port 13305).
 *   2. Falls back to an HTTP port scan (8000, 1234, 9000, 8080).
 *   3. Lets the user confirm / pick / type a URL.
 *   4. Optionally collects an API key.
 *   5. Verifies, fetches the model list, re-registers the provider.
 *
 * Admin commands live under /lemonade (status, models, load, pull, etc.).
 */

import dgram from "node:dgram";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Pi's ExtensionAPI shape — only the surface we actually use. Pi resolves the
// real type at runtime via jiti; declaring a local interface keeps this file
// type-checkable without the peerDependency installed in the extension dir.
interface ExtensionAPI {
  registerProvider(id: string, config: Record<string, unknown>): void;
  unregisterProvider(id: string): void;
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: PiCommandContext) => Promise<void>;
    },
  ): void;
  on(
    event: "before_provider_request",
    handler: (event: { payload: unknown }, ctx: PiProviderRequestContext) => Promise<void> | void,
  ): void;
}

interface PiCommandContext {
  ui: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
    input?(prompt: string, placeholder?: string): Promise<string>;
    select?<T>(prompt: string, options: T[]): Promise<T>;
  };
  signal?: AbortSignal;
}

interface PiProviderRequestContext {
  model?: { provider?: string; id?: string };
  signal?: AbortSignal;
}

const PROVIDER_ID = "lemonade";
const PROVIDER_LABEL = "Lemonade";
const BEACON_PORT = 13305;
// Lemonade's default HTTP port is 13305 (same port as the UDP beacon, but TCP).
// Listed first so the local-fallback scan finds it immediately. Other ports
// covered for users running a custom --port.
const HTTP_FALLBACK_PORTS = [13305, 8000, 1234, 9000, 8080];
const DEFAULT_HTTP_URL = "http://localhost:13305";
const CREDS_TTL_MS = 24 * 60 * 60 * 1000;
const LOAD_TIMEOUT_MS = 10 * 60 * 1000;
// Conservative fallback for models whose context metadata is unknown. When
// Lemonade reports max_context_window for a model, we use that as the default
// and explicitly pass it as ctx_size when loading via /api/v1/load so the
// backend does not fall back to Lemonade's hardcoded 4k default.
const DEFAULT_CONTEXT_WINDOW = 8192;

// ─── Types ──────────────────────────────────────────────────────────────────

interface LemonadeLoadedModelInfo {
  backend_url?: string;
  checkpoint?: string;
  device?: string;
  last_use?: number;
  model_name?: string;
  recipe?: string;
  recipe_options?: Record<string, unknown>;
  type?: string;
}

interface LemonadeHealth {
  status: string;
  version: string;
  model_loaded: string | null;
  all_models_loaded?: (string | LemonadeLoadedModelInfo)[] | null;
  websocket_port?: number;
}

interface LemonadeModelInfo {
  id: string;
  name?: string;
  category?: string;
  backend?: string;
  recipe?: string;
  loaded?: boolean;
  size?: number;
  labels?: string[];
  max_context_window?: number;
  config?: Record<string, unknown>;
}

interface ProviderModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>>;
  // Subset of Pi's OpenAICompletionsCompat. Kept local because the
  // @earendil-works/pi-ai peerDep is not installed in extensions/. Shape
  // mirrors upstream types.ts on main.
  compat?: {
    thinkingFormat?: "qwen" | "qwen-chat-template";
    supportsReasoningEffort?: boolean;
    requiresReasoningContentOnAssistantMessages?: boolean;
  };
}

interface OAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
}

interface OAuthLoginCallbacks {
  onAuth(params: { url: string }): void;
  onDeviceCode(params: { userCode: string; verificationUri: string }): void;
  onPrompt(params: { message: string }): Promise<string>;
}

interface CredsPayload {
  baseUrl: string;
  apiKey: string;
  serverName: string;
}

interface BeaconResult {
  hostname: string;
  baseUrl: string;
}

type LemonadeModelIndex = Map<string, LemonadeModelInfo>;

let currentPayload: CredsPayload | null = null;
let currentModelsById: LemonadeModelIndex = new Map();
const inFlightLoads = new Map<string, Promise<void>>();

// ─── Credential encoding ────────────────────────────────────────────────────

function encodeCreds(payload: CredsPayload): OAuthCredentials {
  return {
    refresh: JSON.stringify(payload),
    access: payload.apiKey,
    expires: Date.now() + CREDS_TTL_MS,
  };
}

function decodeCreds(creds: OAuthCredentials): CredsPayload {
  try {
    const parsed = JSON.parse(creds.refresh ?? "");
    return {
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : (creds.access ?? ""),
      serverName: typeof parsed.serverName === "string" ? parsed.serverName : "Lemonade",
    };
  } catch {
    return { baseUrl: "", apiKey: creds.access ?? "", serverName: "Lemonade" };
  }
}

// ─── URL helpers ────────────────────────────────────────────────────────────

function buildBaseUrl(raw: string): string {
  let url = (raw ?? "").trim();
  if (!url) return "";
  url = url.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) {
    url = `http://${url}`;
  }
  // Strip any path the user (or the beacon) appended. Order matters — strip
  // the most specific prefix first.
  //   http://host:port/api/v1/  → http://host:port
  //   http://host:port/api/v0   → http://host:port
  //   http://host:port/v1       → http://host:port (user pasted from OpenAI URL)
  //   http://host:port/api      → http://host:port
  for (const re of [/\/api\/v\d+\/?$/i, /\/v\d+\/?$/i, /\/api\/?$/i]) {
    url = url.replace(re, "");
  }
  return url.replace(/\/+$/, "");
}

function authHeaders(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (apiKey) h["Authorization"] = `Bearer ${apiKey}`;
  return h;
}

// ─── UDP beacon discovery ───────────────────────────────────────────────────

/**
 * Listen on UDP 13305 for Lemonade beacons.
 * Lemonade broadcasts {"service":"lemonade","hostname":"...","url":"http://.../api/v1/"}
 * roughly every second to loopback and every RFC1918 broadcast address.
 *
 * localOnly=true accepts only loopback senders (matches the lemonade CLI's
 * discover_local_server_port). false accepts any sender, for LAN-wide scans.
 */
function discoverViaBeacon(timeoutMs: number, localOnly: boolean): Promise<BeaconResult[]> {
  return new Promise((resolve) => {
    const found = new Map<string, BeaconResult>();
    let sock: ReturnType<typeof dgram.createSocket> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (sock) {
        try {
          sock.close();
        } catch {
          // ignore
        }
        sock = null;
      }
      resolve(Array.from(found.values()));
    };

    try {
      // reuseAddr → SO_REUSEADDR; reusePort → SO_REUSEPORT (Node 18+).
      // Both are required on macOS to co-bind with another listener (tray,
      // `lemonade scan`). The peer must also set them, so this only works
      // once the lemonade tray is patched to set SO_REUSEPORT before bind.
      sock = dgram.createSocket({
        type: "udp4",
        reuseAddr: true,
        reusePort: true,
      } as Parameters<typeof dgram.createSocket>[0]);
      sock.on("error", finish);
      sock.on("message", (msg: Buffer, rinfo: { address: string }) => {
        if (localOnly && rinfo.address !== "127.0.0.1") return;
        try {
          const beacon = JSON.parse(msg.toString());
          if (beacon?.service !== "lemonade") return;
          const url = String(beacon.url ?? "");
          const hostname = String(beacon.hostname ?? "unknown");
          if (!url) return;
          const baseUrl = buildBaseUrl(url);
          if (baseUrl && !found.has(baseUrl)) {
            found.set(baseUrl, { hostname, baseUrl });
          }
        } catch {
          // not JSON / not ours
        }
      });
      sock.bind(BEACON_PORT);
    } catch {
      finish();
      return;
    }

    timer = setTimeout(finish, timeoutMs);
  });
}

async function discoverViaHttp(): Promise<BeaconResult[]> {
  const checks = await Promise.all(
    HTTP_FALLBACK_PORTS.map(async (port) => {
      const baseUrl = `http://localhost:${port}`;
      const health = await checkHealth(baseUrl);
      return health ? { hostname: `localhost:${port}`, baseUrl } : null;
    }),
  );
  return checks.filter((r): r is BeaconResult => r !== null);
}

async function discoverServers(timeoutMs = 2500): Promise<BeaconResult[]> {
  const beacons = await discoverViaBeacon(timeoutMs, /*localOnly=*/ false);
  if (beacons.length > 0) return beacons;
  return await discoverViaHttp();
}

// ─── HTTP calls ─────────────────────────────────────────────────────────────

// Lemonade's streaming chat-completions endpoint sometimes returns HTTP 200 +
// `Content-Type: text/event-stream` with a body that is *not* SSE-framed but a
// raw JSON error object (e.g. `exceed_context_size_error`). Pi's openai-
// completions provider then sees a stream that ends with no `finish_reason` and
// surfaces a generic "stream ended without finish_reason" — the user gets a
// silent dead session with no actionable signal.
//
// To turn that into a proper exception we have to inspect the response body.
// Pi's extension surface gives us no clean place to do that (as of pi 0.75.4):
//
//   - ProviderConfig has no `fetch` field; Pi instantiates the OpenAI SDK
//     directly in openai-completions.ts without forwarding a custom fetch.
//   - The `after_provider_response` event exposes `{ status, headers }` only —
//     the response body / stream is not passed to extensions.
//   - `streamSimple` would replace the entire streaming implementation for the
//     provider, requiring us to reimplement message conversion, tool calls,
//     qwen-chat-template kwargs, cache handling, etc. — far too invasive.
//
// So we wrap `globalThis.fetch`. The wrapper:
//   - is installed lazily on the first `trackChatCompletionUrl` call (no
//     mutation when the plugin loads but the user never connects),
//   - is idempotent across module re-loads via a Symbol.for guard,
//   - short-circuits to the original fetch for any URL not on the tracked set
//     (only this plugin's chat-completions endpoint is inspected).
//
// Follow-up tracked in TASKS.org: raise an upstream Pi feature request for a
// per-provider fetch hook or a body-aware response interceptor so we can drop
// the global mutation.

const TRACKED_CHAT_COMPLETION_URLS = Symbol.for("lemonade-pi-plugin.trackedChatCompletionUrls");
const FETCH_WRAPPER_INSTALLED = Symbol.for("lemonade-pi-plugin.fetchWrapperInstalled");
const trackedChatCompletionUrls = (((globalThis as Record<symbol, unknown>)[TRACKED_CHAT_COMPLETION_URLS] ??=
  new Set<string>()) as Set<string>);

function trackChatCompletionUrl(baseUrl: string): void {
  if (!baseUrl) return;
  trackedChatCompletionUrls.add(`${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`);
  // Lazy install: the wrapper only matters once we have at least one tracked
  // URL to inspect. Repeated calls are no-ops thanks to FETCH_WRAPPER_INSTALLED.
  installLemonadeFetchErrorWrapper();
}

function requestUrl(input: unknown): string | null {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return null;
}

function isTrackedChatCompletionRequest(input: unknown): boolean {
  const raw = requestUrl(input);
  if (!raw) return false;
  try {
    const url = new URL(raw);
    for (const tracked of trackedChatCompletionUrls) {
      const target = new URL(tracked);
      if (url.origin === target.origin && url.pathname === target.pathname) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function formatLemonadeError(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const rawError = (payload as { error?: unknown }).error;
  if (!rawError || typeof rawError !== "object") return null;
  const error = rawError as Record<string, unknown>;
  const code = error.code;
  const message = error.message;
  const type = error.type;
  if (typeof message !== "string" || message.length === 0) return null;
  const prefix =
    type === "exceed_context_size_error" ? "context_length_exceeded: " : "Lemonade API error: ";
  const parts = [
    typeof type === "string" ? type : undefined,
    typeof code === "number" || typeof code === "string" ? `code=${code}` : undefined,
  ].filter(Boolean);
  const details = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  const tokenDetails =
    typeof error.n_prompt_tokens === "number" && typeof error.n_ctx === "number"
      ? `; prompt tokens=${error.n_prompt_tokens}, ctx=${error.n_ctx}`
      : "";
  return `${prefix}${message}${details}${tokenDetails}`;
}

async function readSseJsonError(response: Response): Promise<string | null> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) return null;
  const reader = response.clone().body?.getReader();
  if (!reader) return null;

  const timeout = Symbol("timeout");
  const first = await Promise.race([
    reader.read(),
    new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 250)),
  ]);
  if (first === timeout) {
    await reader.cancel().catch(() => undefined);
    return null;
  }
  if (first.done || !first.value) {
    await reader.cancel().catch(() => undefined);
    return null;
  }

  const decoder = new TextDecoder();
  let text = decoder.decode(first.value, { stream: true });
  if (!text.trimStart().startsWith("{")) {
    await reader.cancel().catch(() => undefined);
    return null;
  }

  while (true) {
    const next = await Promise.race([
      reader.read(),
      new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), 250)),
    ]);
    if (next === timeout) break;
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  text += decoder.decode();

  try {
    return formatLemonadeError(JSON.parse(text));
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function installLemonadeFetchErrorWrapper(): void {
  const globalSymbols = globalThis as Record<symbol, unknown>;
  if (globalSymbols[FETCH_WRAPPER_INSTALLED] || typeof fetch !== "function") return;
  globalSymbols[FETCH_WRAPPER_INSTALLED] = true;
  const originalFetch = fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    if (!isTrackedChatCompletionRequest(input)) return response;
    const message = await readSseJsonError(response);
    if (message) throw new Error(message);
    return response;
  }) as typeof fetch;
}

async function checkHealth(baseUrl: string, apiKey?: string): Promise<LemonadeHealth | null> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/health`, {
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return (await res.json()) as LemonadeHealth;
  } catch {
    return null;
  }
}

async function fetchModels(baseUrl: string, apiKey?: string): Promise<LemonadeModelInfo[]> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/models`, {
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: LemonadeModelInfo[] };
    return Array.isArray(data?.data) ? data.data : [];
  } catch {
    return [];
  }
}

// ─── Provider model mapping ─────────────────────────────────────────────────

function modelHasLabel(m: LemonadeModelInfo, label: string): boolean {
  return (m.labels ?? []).some((l) => l.toLowerCase() === label);
}

function isReasoningModel(m: LemonadeModelInfo): boolean {
  // Lemonade's OpenAI-compatible /v1/models response marks reasoning-capable
  // models with labels: ["reasoning"]. Model ids/checkpoints are not a stable
  // capability signal.
  return modelHasLabel(m, "reasoning");
}

// Match any model whose id or name contains "qwen" (case-insensitive).
// Intentionally ignores Lemonade's reasoning label: the qwen-chat-template
// workaround for upstream Pi issue #4862 must apply to every Qwen model
// regardless of how Lemonade tags it. False positives (e.g. qwen-coder,
// qwen-vl) get the thinking-control UI but Lemonade will ignore unknown
// chat_template_kwargs, so requests still succeed.
function isQwenModel(m: LemonadeModelInfo): boolean {
  return /qwen/i.test(m.id ?? "") || /qwen/i.test(m.name ?? "");
}

type LoadedContextWindows = Map<string, number>;

const CONTEXT_SIZE_RECIPES = new Set(["llamacpp", "flm", "ryzenai-llm"]);

function asPositiveInteger(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

function loadedContextWindowsFromHealth(health: LemonadeHealth | null | undefined): LoadedContextWindows {
  const windows: LoadedContextWindows = new Map();
  for (const loaded of health?.all_models_loaded ?? []) {
    if (!loaded || typeof loaded !== "object") continue;
    const ctxSize = asPositiveInteger(loaded.recipe_options?.ctx_size);
    if (!ctxSize) continue;
    const names = [loaded.model_name, loaded.checkpoint].filter(
      (name): name is string => typeof name === "string" && name.length > 0,
    );
    for (const name of names) windows.set(name, ctxSize);
  }
  return windows;
}

function loadedContextWindowForModel(
  m: LemonadeModelInfo,
  loadedContextWindows?: LoadedContextWindows,
): number | undefined {
  return loadedContextWindows?.get(m.id) ?? (m.name ? loadedContextWindows?.get(m.name) : undefined);
}

function recipeSupportsContextSize(recipe: string | undefined): boolean {
  return !recipe || CONTEXT_SIZE_RECIPES.has(recipe);
}

function maxContextWindowForModel(m: LemonadeModelInfo | undefined): number | undefined {
  return asPositiveInteger(m?.max_context_window);
}

function loadRequestBodyForModel(
  modelName: string,
  modelInfo: LemonadeModelInfo | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = { model_name: modelName };
  const maxContextWindow = maxContextWindowForModel(modelInfo);
  if (maxContextWindow && recipeSupportsContextSize(modelInfo?.recipe)) {
    body.ctx_size = maxContextWindow;
  }
  return body;
}

function mapToProviderModel(m: LemonadeModelInfo, loadedContextWindows?: LoadedContextWindows): ProviderModel {
  const input: ("text" | "image")[] = ["text"];
  if (m.category === "image" || (m.backend ?? "").toLowerCase().includes("sd")) {
    input.push("image");
  }
  const cfg = m.config ?? {};
  const contextWindow =
    maxContextWindowForModel(m) ??
    loadedContextWindowForModel(m, loadedContextWindows) ??
    asPositiveInteger(cfg["context_window"]) ??
    asPositiveInteger(cfg["context_len"]) ??
    DEFAULT_CONTEXT_WINDOW;
  const maxTokens =
    asPositiveInteger(cfg["max_new_tokens"]) ?? asPositiveInteger(cfg["max_tokens"]) ?? 4096;
  const isReasoning = isReasoningModel(m);
  const isQwen = isQwenModel(m);
  const result: ProviderModel = {
    id: m.id,
    // Force reasoning:true for any Qwen model so Pi's openai-completions
    // qwen-chat-template branch (gated on model.reasoning) emits
    // chat_template_kwargs. See upstream Pi issue #4862 + PR #2769.
    name: m.name || m.id,
    reasoning: isReasoning || isQwen,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
  // Qwen models use binary `enable_thinking` via chat_template_kwargs.
  // Expose only off/high in Pi's UI rather than advertising several levels
  // that all collapse to truthy/falsy at the wire.
  if (isQwen) {
    result.thinkingLevelMap = {
      minimal: null,
      low: null,
      medium: null,
      xhigh: null,
    };
    // qwen-chat-template makes Pi send
    //   chat_template_kwargs: { enable_thinking, preserve_thinking: true }
    // instead of top-level reasoning_effort / enable_thinking, which is what
    // Lemonade actually honors (Pi issue #4862).
    // requiresReasoningContentOnAssistantMessages preserves reasoning_content
    // on assistant turns so multi-turn Qwen sessions don't degrade once
    // preserve_thinking is in play (Pi PR #2769, issue #4526).
    result.compat = {
      thinkingFormat: "qwen-chat-template",
      requiresReasoningContentOnAssistantMessages: true,
    };
  }
  return result;
}

// Exported for the synthetic-model test harness under scripts/.
export const __test__ = {
  DEFAULT_CONTEXT_WINDOW,
  formatLemonadeError,
  readSseJsonError,
  loadedContextWindowsFromHealth,
  loadRequestBodyForModel,
  mapToProviderModel,
  maxContextWindowForModel,
  recipeSupportsContextSize,
  isQwenModel,
  isReasoningModel,
};

// ─── Provider (re-)registration ─────────────────────────────────────────────

async function registerLemonadeProvider(
  pi: ExtensionAPI,
  payload: CredsPayload | null,
  oauthBlock: unknown,
): Promise<number> {
  const baseUrl = payload?.baseUrl ?? "";
  let providerModels: ProviderModel[] = [];
  currentPayload = payload;
  currentModelsById = new Map();
  if (baseUrl) {
    const [raw, health] = await Promise.all([
      fetchModels(baseUrl, payload?.apiKey),
      checkHealth(baseUrl, payload?.apiKey),
    ]);
    currentModelsById = new Map(raw.map((m) => [m.id, m]));
    const loadedContextWindows = loadedContextWindowsFromHealth(health);
    providerModels = raw.map((m) => mapToProviderModel(m, loadedContextWindows));
  }

  try {
    pi.unregisterProvider(PROVIDER_ID);
  } catch {
    // not previously registered; ignore
  }

  if (baseUrl) trackChatCompletionUrl(baseUrl);

  const config: Record<string, unknown> = {
    name: payload?.serverName ? `Lemonade (${payload.serverName})` : "Lemonade",
    baseUrl: baseUrl ? `${baseUrl}/v1` : "http://localhost:8000/v1",
    api: "openai-completions",
    models: providerModels,
    oauth: oauthBlock,
  };
  if (payload?.apiKey) {
    config.headers = { Authorization: `Bearer ${payload.apiKey}` };
  }
  pi.registerProvider(PROVIDER_ID, config);
  return providerModels.length;
}

function providerRequestModelId(payload: unknown, ctx: PiProviderRequestContext): string | null {
  if (ctx.model?.provider === PROVIDER_ID && typeof ctx.model.id === "string") {
    return ctx.model.id;
  }
  if (!payload || typeof payload !== "object") return null;
  const model = (payload as { model?: unknown }).model;
  return typeof model === "string" && currentModelsById.has(model) ? model : null;
}

async function refreshModelIndex(baseUrl: string, apiKey?: string): Promise<void> {
  const models = await fetchModels(baseUrl, apiKey);
  currentModelsById = new Map(models.map((m) => [m.id, m]));
}

async function ensureModelLoadedWithMaxContext(
  baseUrl: string,
  apiKey: string | undefined,
  modelName: string,
): Promise<void> {
  let modelInfo = currentModelsById.get(modelName);
  if (!modelInfo || !maxContextWindowForModel(modelInfo)) {
    await refreshModelIndex(baseUrl, apiKey);
    modelInfo = currentModelsById.get(modelName);
  }

  const body = loadRequestBodyForModel(modelName, modelInfo);
  if (typeof body.ctx_size !== "number") return;

  const key = `${baseUrl}\n${modelName}\n${body.ctx_size}`;
  const existing = inFlightLoads.get(key);
  if (existing) return existing;

  const load = (async () => {
    const response = await fetch(`${baseUrl}/api/v1/load`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}) as Record<string, unknown>);
      const message = extractErrorMessage(data) ?? response.statusText;
      throw new Error(`Failed to load ${modelName} with ctx_size=${body.ctx_size}: ${message}`);
    }
  })();

  inFlightLoads.set(key, load);
  try {
    await load;
  } finally {
    inFlightLoads.delete(key);
  }
}

async function ensureRequestModelLoadedWithMaxContext(event: { payload: unknown }, ctx: PiProviderRequestContext): Promise<void> {
  const modelName = providerRequestModelId(event.payload, ctx);
  if (!modelName) return;

  let payload = currentPayload;
  if (!payload?.baseUrl) {
    payload = await readStoredPayload();
    currentPayload = payload;
  }
  if (!payload?.baseUrl) return;

  await ensureModelLoadedWithMaxContext(payload.baseUrl, payload.apiKey || undefined, modelName);
}

// ─── OAuth login flow (runs when user picks "Lemonade" in /login) ───────────

async function oauthLogin(
  pi: ExtensionAPI,
  callbacks: OAuthLoginCallbacks,
  oauthBlock: unknown,
): Promise<OAuthCredentials> {
  const discovered = await discoverServers(2500);

  let baseUrl = "";
  let serverName = "Lemonade";

  if (discovered.length === 0) {
    const input = await callbacks.onPrompt({
      message:
        "No Lemonade server found via UDP beacon (port 13305) or local port scan.\n" +
        "Enter Lemonade server URL (press Enter for http://localhost:8000):",
    });
    const trimmed = input.trim();
    baseUrl = trimmed ? buildBaseUrl(trimmed) : "http://localhost:8000";
  } else if (discovered.length === 1) {
    const only = discovered[0];
    const confirm = await callbacks.onPrompt({
      message:
        `Found Lemonade server: ${only.hostname} at ${only.baseUrl}\n` +
        `Press Enter to use this, or type a different URL:`,
    });
    const trimmed = confirm.trim();
    if (trimmed) {
      baseUrl = buildBaseUrl(trimmed);
      serverName = "Lemonade";
    } else {
      baseUrl = only.baseUrl;
      serverName = only.hostname;
    }
  } else {
    let menu = `Found ${discovered.length} Lemonade servers:\n`;
    discovered.forEach((d, i) => {
      menu += `  [${i + 1}] ${d.hostname} — ${d.baseUrl}\n`;
    });
    menu += "Enter number to select, or type a custom URL:";
    const choice = (await callbacks.onPrompt({ message: menu })).trim();
    const num = parseInt(choice, 10);
    if (!isNaN(num) && num >= 1 && num <= discovered.length) {
      baseUrl = discovered[num - 1].baseUrl;
      serverName = discovered[num - 1].hostname;
    } else if (choice) {
      baseUrl = buildBaseUrl(choice);
      serverName = "Lemonade";
    } else {
      baseUrl = discovered[0].baseUrl;
      serverName = discovered[0].hostname;
    }
  }

  const apiKeyInput = await callbacks.onPrompt({
    message:
      "Enter API key (optional — press Enter to skip if your server doesn't require one):",
  });
  const apiKey = apiKeyInput.trim();

  const health = await checkHealth(baseUrl, apiKey || undefined);
  if (!health) {
    throw new Error(
      `Cannot reach Lemonade at ${baseUrl}. Check that the server is running` +
        (apiKey ? " and that the API key is correct." : "") +
        ".",
    );
  }

  const payload: CredsPayload = {
    baseUrl,
    apiKey,
    serverName: `${serverName} v${health.version}`,
  };
  await registerLemonadeProvider(pi, payload, oauthBlock);

  return encodeCreds(payload);
}

// ─── /lemonade admin command ────────────────────────────────────────────────

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "—";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Best-effort: read Pi's persisted OAuth credentials so the admin command
 * works without making a network call to the OAuth flow. The on-disk format
 * is undocumented; we try a couple of reasonable shapes.
 */
async function readStoredPayload(): Promise<CredsPayload | null> {
  try {
    const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
    const raw = await fs.readFile(authPath, "utf8");
    const data = JSON.parse(raw);
    const candidates: unknown[] = [
      data?.[PROVIDER_ID],
      data?.providers?.[PROVIDER_ID],
      data?.oauth?.[PROVIDER_ID],
    ];
    for (const c of candidates) {
      if (
        c &&
        typeof c === "object" &&
        typeof (c as OAuthCredentials).refresh === "string"
      ) {
        return decodeCreds(c as OAuthCredentials);
      }
    }
  } catch {
    // no auth.json yet, or unreadable
  }
  return null;
}

function loadedModelName(loaded: string | LemonadeLoadedModelInfo): string {
  if (typeof loaded === "string") return loaded;
  const ctxSize = asPositiveInteger(loaded.recipe_options?.ctx_size);
  return `${loaded.model_name ?? loaded.checkpoint ?? "unknown"}${ctxSize ? ` (ctx ${ctxSize})` : ""}`;
}

function registerAdminCommand(pi: ExtensionAPI, oauthBlock: unknown) {
  pi.registerCommand("lemonade", {
    description: "Lemonade server administration (status, models, load/pull/delete)",
    handler: async (args: string, ctx: { ui: { notify(msg: string, level?: string): void } }) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const cmd = (parts[0] ?? "").toLowerCase();
      const rest = parts.slice(1);

      if (cmd === "" || cmd === "help") {
        ctx.ui.notify(
          "/lemonade <command>\n" +
            "  status             — server health\n" +
            "  models             — list models\n" +
            "  load <id>          — load a model into memory\n" +
            "  unload [id]        — unload a model (or all if no id)\n" +
            "  pull <id>          — download a model\n" +
            "  delete <id>        — remove a model from disk\n" +
            "  refresh            — re-fetch model list and re-register provider\n" +
            "  discover           — UDP beacon + HTTP port scan",
          "info",
        );
        return;
      }

      if (cmd === "discover") {
        ctx.ui.notify("Scanning UDP beacons (3s) + local port fallback…", "info");
        const beacons = await discoverViaBeacon(3000, /*localOnly=*/ false);
        const http = beacons.length === 0 ? await discoverViaHttp() : [];
        const all = [...beacons, ...http];
        if (all.length === 0) {
          ctx.ui.notify("No Lemonade servers found.", "warning");
          return;
        }
        let msg = `Found ${all.length} server(s):\n`;
        for (const s of all) msg += `  • ${s.hostname} — ${s.baseUrl}\n`;
        ctx.ui.notify(msg, "info");
        return;
      }

      const payload = await readStoredPayload();
      if (!payload?.baseUrl) {
        ctx.ui.notify(
          "Not connected to Lemonade. Run /login and pick Lemonade.",
          "warning",
        );
        return;
      }
      const baseUrl = payload.baseUrl;
      const apiKey = payload.apiKey || undefined;

      switch (cmd) {
        case "status": {
          const h = await checkHealth(baseUrl, apiKey);
          if (!h) {
            ctx.ui.notify(`Cannot reach ${baseUrl}`, "error");
            return;
          }
          ctx.ui.notify(
            `Lemonade v${h.version} @ ${baseUrl}\n` +
              `Status: ${h.status}\n` +
              `Loaded: ${h.model_loaded ?? "(none)"}\n` +
              `All loaded: ${(h.all_models_loaded ?? []).map(loadedModelName).join(", ") || "(none)"}` +
              (h.websocket_port ? `\nWebSocket port: ${h.websocket_port}` : ""),
            "info",
          );
          return;
        }

        case "models":
        case "list": {
          const models = await fetchModels(baseUrl, apiKey);
          if (models.length === 0) {
            ctx.ui.notify("No models found.", "warning");
            return;
          }
          let out = `${models.length} model(s):\n`;
          for (const m of models) {
            const status = m.loaded ? "●" : "○";
            const size = m.size ? ` (${formatBytes(m.size)})` : "";
            out += `  ${status} ${m.name || m.id}${size}\n`;
            if (m.recipe) {
              out += `      recipe: ${m.recipe}, backend: ${m.backend ?? "—"}\n`;
            }
          }
          ctx.ui.notify(out, "info");
          return;
        }

        case "load": {
          const id = rest[0];
          if (!id) {
            ctx.ui.notify("Usage: /lemonade load <model_id>", "warning");
            return;
          }
          let modelInfo = currentModelsById.get(id);
          if (!modelInfo) {
            const models = await fetchModels(baseUrl, apiKey);
            currentModelsById = new Map(models.map((m) => [m.id, m]));
            modelInfo = currentModelsById.get(id);
          }
          const body = loadRequestBodyForModel(id, modelInfo);
          const ctxSuffix = typeof body.ctx_size === "number" ? ` with ctx_size=${body.ctx_size}` : "";
          ctx.ui.notify(`Loading ${id}${ctxSuffix}…`, "info");
          await postModelOp(ctx, `${baseUrl}/api/v1/load`, apiKey, body, "load");
          return;
        }

        case "unload": {
          const id = rest[0];
          ctx.ui.notify(id ? `Unloading ${id}…` : "Unloading all models…", "info");
          await postModelOp(
            ctx,
            `${baseUrl}/api/v1/unload`,
            apiKey,
            id ? { model_name: id } : {},
            "unload",
          );
          return;
        }

        case "pull": {
          const id = rest[0];
          if (!id) {
            ctx.ui.notify("Usage: /lemonade pull <model_id>", "warning");
            return;
          }
          ctx.ui.notify(`Pulling ${id} (this may take a while)…`, "info");
          await postModelOp(
            ctx,
            `${baseUrl}/api/v1/pull`,
            apiKey,
            { model_name: id },
            "pull",
          );
          return;
        }

        case "delete": {
          const id = rest[0];
          if (!id) {
            ctx.ui.notify("Usage: /lemonade delete <model_id>", "warning");
            return;
          }
          ctx.ui.notify(`Deleting ${id} from disk…`, "info");
          await postModelOp(
            ctx,
            `${baseUrl}/api/v1/delete`,
            apiKey,
            { model_name: id },
            "delete",
          );
          return;
        }

        case "refresh": {
          const count = await registerLemonadeProvider(pi, payload, oauthBlock);
          ctx.ui.notify(`Re-synced: ${count} models registered.`, "info");
          return;
        }

        default:
          ctx.ui.notify(`Unknown command: /lemonade ${cmd}\nType /lemonade help`, "warning");
      }
    },
  });
}

function extractErrorMessage(data: Record<string, unknown>): string | undefined {
  const error = data.error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return typeof error === "string" ? error : undefined;
}

async function postModelOp(
  ctx: { ui: { notify(msg: string, level?: string): void } },
  url: string,
  apiKey: string | undefined,
  body: Record<string, unknown>,
  label: string,
) {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(label === "load" ? LOAD_TIMEOUT_MS : 60_000),
    });
    const data = await r.json().catch(() => ({}) as Record<string, unknown>);
    if (!r.ok) {
      const msg = extractErrorMessage(data) ?? r.statusText;
      ctx.ui.notify(`${label} failed: ${msg}`, "error");
      return;
    }
    const successMsg =
      (data as { message?: string }).message ??
      `${label} succeeded${(data as { model_name?: string }).model_name ? `: ${(data as { model_name?: string }).model_name}` : ""}`;
    ctx.ui.notify(successMsg, "info");
  } catch (e) {
    ctx.ui.notify(`${label} failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

// ─── Extension factory ──────────────────────────────────────────────────────

export default async function lemonadeProvider(pi: ExtensionAPI) {
  // installLemonadeFetchErrorWrapper() runs lazily inside trackChatCompletionUrl
  // once a real Lemonade baseUrl is registered. No global fetch mutation happens
  // at module load if the user never logs in.

  pi.on("before_provider_request", ensureRequestModelLoadedWithMaxContext);

  const oauthBlock = {
    name: PROVIDER_LABEL,
    login: (callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> =>
      oauthLogin(pi, callbacks, oauthBlock),
    refreshToken: async (creds: OAuthCredentials): Promise<OAuthCredentials> => {
      const payload = decodeCreds(creds);
      if (payload.baseUrl) {
        try {
          await registerLemonadeProvider(pi, payload, oauthBlock);
        } catch {
          // network blip — keep creds, retry on next refresh
        }
      }
      return encodeCreds(payload);
    },
    getApiKey: (creds: OAuthCredentials): string => {
      const payload = decodeCreds(creds);
      return payload.apiKey || "";
    },
  };

  // Initial stub registration so "Lemonade" appears in Pi's /login selector
  // even before the user has connected.
  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_LABEL,
    baseUrl: "http://localhost:8000/v1",
    api: "openai-completions",
    models: [],
    oauth: oauthBlock,
  });

  // Best-effort: if Pi already has saved creds for us, re-register eagerly so
  // the model picker is populated without waiting for the next refresh tick.
  const stored = await readStoredPayload();
  if (stored?.baseUrl) {
    try {
      await registerLemonadeProvider(pi, stored, oauthBlock);
    } catch {
      // ignore — refreshToken will retry
    }
  }

  registerAdminCommand(pi, oauthBlock);
}
