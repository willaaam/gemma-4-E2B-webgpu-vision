// Load the generated engine and fail early if the checked-in artifact is stale.

const ENGINE_URL = new URL("../../gemma-4-e2b.js", import.meta.url);
const source = await (await fetch(ENGINE_URL)).text();
if (!source.includes("getContextCapabilities") || !source.includes("countPromptTokens")) {
  throw new Error("Unsupported Gemma engine bundle: runtime capability API is missing");
}
const cachePrefixSource = "o!==this.#u.length&&(this.#c(),o=0)";
const cachePrefixReplacement = "o<this.#u.length&&this.#o.cache.truncate(o)";
const patchedSource = source.replace(cachePrefixSource, cachePrefixReplacement);
if (patchedSource === source) throw new Error("Gemma engine bundle is missing common-prefix cache handling");
const moduleUrl = URL.createObjectURL(new Blob([patchedSource], { type: "text/javascript" }));
let engine;
try {
  engine = await import(moduleUrl);
} finally {
  URL.revokeObjectURL(moduleUrl);
}

export const Gemma4Mobile = engine.Gemma4Mobile;
export const DEFAULT_MODEL_ID = engine.DEFAULT_MODEL_ID;
export const resolveModelRoot = engine.resolveModelRoot;
export default engine.default;
