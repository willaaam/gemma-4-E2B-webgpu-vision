// Shared generation pipeline.
//
// The engine has ONE KV cache and ONE GPU device, so exactly one generation
// stream may run at any time across ALL apps. This module enforces that with
// a global lock and provides the streaming/thinking-split/stat plumbing that
// every app needs.

import { modelService } from "./model-service.js";
import { getTemperaturePreference } from "./temperature-preference.js";

let lockHolder = null; // human-readable label of whoever holds the lock

export function isGenerating() { return lockHolder !== null; }
export function lockHolderName() { return lockHolder; }

export class ContextLimitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ContextLimitError";
    this.code = "context_limit";
    Object.assign(this, details);
  }
}
export async function preflightGeneration({ messages, maxNewTokens = null, contextMax } = {}) {
  const model = modelService.model;
  if (!model) throw new Error("Model not loaded");
  if (typeof model.countPromptTokens !== "function") throw new Error("Model does not expose exact prompt token counting");
  modelService.refreshCapabilities?.();
  const promptTokens = Math.max(0, Math.floor(Number(await model.countPromptTokens(messages ?? [])) || 0));
  let capabilities = model.getContextCapabilities?.() ?? modelService.capabilities;
  const architecturalMax = Math.max(1, Math.floor(Number(capabilities?.architecturalMax) || 131_072));
  const requestedContextMax = Number(contextMax);
  const allowedContextMax = Number.isFinite(requestedContextMax) && requestedContextMax > 0
    ? Math.min(architecturalMax, Math.floor(requestedContextMax))
    : architecturalMax;
  const requestedValue = Number(maxNewTokens);
  const requestedMaxNewTokens = Number.isFinite(requestedValue) && requestedValue > 0
    ? Math.floor(requestedValue)
    : null;
  const safetyTokens = 1;
  let effectiveContextMax = Math.min(
    allowedContextMax,
    Math.max(1, Math.floor(Number(capabilities?.effectiveContextMax) || architecturalMax))
  );
  const requiredCapacity = requestedMaxNewTokens == null
    ? promptTokens + safetyTokens
    : promptTokens + requestedMaxNewTokens + safetyTokens;
  if (requestedMaxNewTokens != null && requiredCapacity > effectiveContextMax && requiredCapacity <= allowedContextMax && model.ensureContextCapacity) {
    try { await model.ensureContextCapacity(requiredCapacity); } catch (_) {}
    modelService.refreshCapabilities?.();
    capabilities = model.getContextCapabilities?.() ?? modelService.capabilities;
    effectiveContextMax = Math.min(
      allowedContextMax,
      Math.max(1, Math.floor(Number(capabilities?.effectiveContextMax) || effectiveContextMax))
    );
  }
  const availableTokens = effectiveContextMax - promptTokens - safetyTokens;
  if (promptTokens > effectiveContextMax || availableTokens < 1) {
    throw new ContextLimitError(
      `Prompt uses ${promptTokens.toLocaleString()} tokens, but this device can fit ${effectiveContextMax.toLocaleString()} context tokens.`,
      { promptTokens, effectiveContextMax, architecturalMax, contextMax: allowedContextMax, requestedMaxNewTokens, availableTokens: Math.max(0, availableTokens) }
    );
  }
  return {
    promptTokens,
    requestedMaxNewTokens,
    maxNewTokens: requestedMaxNewTokens == null ? availableTokens : Math.min(requestedMaxNewTokens, availableTokens),
    safetyTokens,
    effectiveContextMax,
    architecturalMax,
    contextMax: allowedContextMax,
  };
}
// Acquire the global generation lock. Returns an unlock function, or null if busy.
export function acquireLock(owner = "app") {
  if (lockHolder) return null;
  lockHolder = owner;
  modelService.setBusy(true);
  return () => {
    if (lockHolder === owner) {
      lockHolder = null;
      modelService.setBusy(false);
    }
  };
}

export function generationStats({ startedAt, firstTokenAt, endedAt, generatedTokens }) {
  if (generatedTokens <= 0 || !startedAt || !firstTokenAt || !endedAt) return { ttftMs: 0, decodeTokensPerSecond: 0 };
  const decodeTokens = Math.max(generatedTokens - 1, 0);
  const decodeSeconds = Math.max((endedAt - firstTokenAt) / 1000, 1e-9);
  return { ttftMs: firstTokenAt - startedAt, decodeTokensPerSecond: decodeTokens > 0 ? decodeTokens / decodeSeconds : 0 };
}

// Split the engine's token stream into thinking vs answer text using the
// special soc/eoc token ids (the engine strips the literal delimiters).
// Returns { run, result } where result resolves to { reply, thinkingText, answerText, stats }.
export async function streamGeneration({ messages, maxNewTokens = null, contextMax, temperature = null, signal, onToken }) {
  const model = modelService.model;
  if (!model) throw new Error("Model not loaded");
  const preflight = await preflightGeneration({ messages, maxNewTokens, contextMax });
  const thoughtTokenIds = modelService.thoughtTokenIds;
  const effTemperature = Number.isFinite(Number(temperature)) ? Number(temperature) : getTemperaturePreference();

  let reply = "";
  let thinkingText = "";
  let answerText = "";
  let inThought = false;
  let startedAt = performance.now();
  let firstTokenAt = 0;
  let generatedTokens = 0;

  try {
    const stream = model.generate(messages, { maxNewTokens: preflight.maxNewTokens, temperature: effTemperature, signal });
    for await (const { text: full, token, delta } of stream) {
      const now = performance.now();
      if (!firstTokenAt) firstTokenAt = now;
      generatedTokens++;
      reply = full;
      // The engine strips the thought-block delimiters (<|channel> / <channel|>)
      // from the decoded text, so split on the token stream instead: the soc token
      // opens the thought block, the eoc token closes it.
      if (thoughtTokenIds && typeof token === "number") {
        if (token === thoughtTokenIds.soc) inThought = true;
        else if (token === thoughtTokenIds.eoc) inThought = false;
        else if (typeof delta === "string") {
          if (inThought) thinkingText += delta;
          else answerText += delta;
        }
      }
      if (onToken) onToken({ full, delta, thinkingText, answerText, startedAt, firstTokenAt, now, generatedTokens });
    }
  } catch (error) {
    modelService.refreshCapabilities?.();
    throw error;
  } finally {
    modelService.refreshCapabilities?.();
  }
  return {
    reply,
    thinkingText,
    answerText,
    preflight,
    stats: { startedAt, firstTokenAt, endedAt: performance.now(), generatedTokens },
  };
}

// Convenience: run a full completion under the global lock.
// onToken receives incremental updates for live rendering.
// Pass skipLock:true when the CALLER already holds the lock (e.g. the agent
// loop inside an app that acquired it) — otherwise re-acquiring throws "busy".
export async function complete({ messages, maxNewTokens = null, contextMax, temperature = null, signal, owner = "app", onToken, skipLock = false }) {
  const unlock = skipLock ? null : acquireLock(owner);
  if (!skipLock && !unlock) throw new Error("busy");
  try {
    return await streamGeneration({ messages, maxNewTokens, contextMax, temperature, signal, onToken });
  } finally {
    unlock?.();
  }
}
