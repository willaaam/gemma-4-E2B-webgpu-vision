// gemma4-vision-inject.js — wires Gemma4Vision into the Gemma4Mobile kernel.
//
// The gemma-4-e2b.js kernel was patched with two *guarded* hook points inside
// its prefill:
//
//   1. `__gemmaVisionHook.mainEmbed(S, qatEmbedArgs, seq, hidden, host, offset)`
//      — called where token ids are embedded into the `g4-hidden` tensor. When
//      an active image override is present, this runs the normal embedding and
//      then scatters the vision features over the image-token positions.
//
//   2. `__gemmaVisionHook.perLayerEmbed(S, ne, qatEmbedArgs, seq, host)`
//      — called for the per-layer (PLE) embedding. Image tokens are replaced by
//      PAD ids for the lookup (matching transformers, which uses PAD for the
//      per-layer signal at multimodal positions).
//
// When no hook is installed (or no override is active), the text path is
// byte-for-byte identical to the unpatched kernel.
//
// Usage:
//   import { Gemma4Mobile } from "./gemma-4-e2b.js";
//   import { Gemma4Vision } from "./gemma4-vision.js";
//   import { VisionGemma4Mobile, installVisionHook } from "./gemma4-vision-inject.js";
//
//   installVisionHook();                                   // once
//   const base = await Gemma4Mobile.load(path, { onProgress });
//   const vision = await Gemma4Vision.load(WEIGHTS_URL);
//   const model = new VisionGemma4Mobile(base, vision);
//
//   for await (const { text } of model.generate([
//     { role: "user", content: [
//         { type: "image", url: "..." },                  // or a RawImage/canvas
//         { type: "text",  text: "What is this?" },
//       ] },
//   ])) { /* stream */ }

import { Gemma4Vision } from "./gemma4-vision.js";

const IMAGE_TOKEN = "<|image|>";
const BOI = "<|image>";
const EOI = "<image|>";

let activeOverride = null; // { segments: [{features, numSoft, startPos}], paddedIds }

/**
 * Install the kernel injection hooks (idempotent). Call once after the page
 * loads and before the first vision generate.
 */
export function installVisionHook() {
  if (globalThis.__gemmaVisionHook) return;
  globalThis.__gemmaVisionHook = {
    mainEmbed(S, args, seq, hidden, host, offset = 0) {
      // 1) normal text embedding for all tokens (unchanged text path)
      S.qatEmbed(args);
      // 2) scatter vision features over the image-token rows of the embedding
      const ov = activeOverride;
      if (globalThis.__G4V_INJECT_DEBUG) {
        const hasSeg = !!ov && ov.segments && ov.segments.length > 0;
        console.log(`[INJECT] mainEmbed fire: seq=${seq} hidden=${hidden} offset=${offset} ov=${hasSeg} qatEmbed=${typeof S.qatEmbed} strided=${typeof S.strided} tensorFromTypedArray=${typeof host?.tensorFromTypedArray}`);
      }
      if (!ov || !ov.segments || ov.segments.length === 0) return;
      for (const seg of ov.segments) {
        const localStart = seg.startPos - offset;
        const inRange = localStart >= 0 && localStart + seg.numSoft <= seq;
        if (globalThis.__G4V_INJECT_DEBUG) {
          console.log(`[INJECT] seg startPos=${seg.startPos} numSoft=${seg.numSoft} hidden=${seg.hidden} localStart=${localStart} seq=${seq} inRange=${inRange} feats0=${Array.from(seg.features.slice(0, 4)).map((x) => x.toFixed(3))}`);
        }
        if (!inRange) continue; // not in this prefill segment
        const featT = host.tensorFromTypedArray("float32", [seg.numSoft, seg.hidden], seg.features);
        S.strided({
          srcT: featT,
          dstT: args.yT,
          rows: seg.numSoft,
          srcStride: seg.hidden,
          srcStart: 0,
          dstStride: seg.hidden,
          dstStart: localStart * seg.hidden,
          copyCols: seg.hidden,
        });
      }
    },
    // Build the chunk token ids for a prefill block with image tokens -> PAD
    // (both the main embed and the per-layer embed read this.idsT; the main
    // embed's image rows are overwritten by the features in `runPrefill`, and
    // the PLE lookup at multimodal positions should be PAD per the reference).
    paddedChunkIds(ids, offset, blockLen) {
      const ov = activeOverride;
      if (!ov || !ov.paddedIds) return null;
      const out = new Uint32Array(blockLen); // 0-filled = PAD id
      const maxJ = Math.min(ids.length, Math.max(0, ov.paddedIds.length - offset));
      for (let j = 0; j < maxJ; j++) out[j] = ov.paddedIds[offset + j];
      if (globalThis.__G4V_INJECT_DEBUG) {
        console.log(`[INJECT] paddedChunkIds offset=${offset} ids=${ids.length} block=${blockLen} first3=${Array.from(out.slice(0, 3)).join(",")}`);
      }
      return out;
    },

    // Live prefill path (g4p `Or.run`): the embed (steps[0]) runs alone, then the
    // vision features are scattered over the image rows of `hiddenT`, then the
    // rest of the prefill (PLE, rope, layers, lm_head) runs. writeBuffer is a
    // queue operation ordered after the embed submit and before the rest submit.
    runPrefill(or, s, ids, offset, blockLen) {
      const ov = activeOverride;
      if (!ov || !ov.segments || ov.segments.length === 0) return false;
      const chunkStart = offset, chunkEnd = offset + ids.length;
      let overlap = false;
      for (const seg of ov.segments) {
        const segStart = seg.startPos, segEnd = seg.startPos + seg.numSoft;
        if (segEnd > chunkStart && segStart < chunkEnd) { overlap = true; break; }
      }
      if (!overlap) return false;
      if (!or.steps || or.steps.length < 2 || !or.hiddenT) return false;
      // capture full GPU validation error messages (one-time)
      try {
        const dev = or.col?.rt?.host?.device;
        if (dev && !globalThis.__g4vErrHooked) {
          globalThis.__g4vErrHooked = true;
          dev.addEventListener("uncapturederror", (e) => {
            console.error("[INJECT] GPU error:", e.error?.message || e.message || String(e.error));
          });
        }
      } catch (_) {}
      if (globalThis.__G4V_INJECT_DEBUG) {
        console.log(`[INJECT] runPrefill offset=${offset} ids=${ids.length} block=${blockLen} steps=${or.steps.length} hiddenT=${!!or.hiddenT}`);
      }
      // 1) run the embed alone so hiddenT = embed(ids) for this block
      or.col.enqueue([or.steps[0]]);
      // 2) scatter the vision features over the image rows (queue-ordered after the embed)
      for (const seg of ov.segments) {
        const segStart = seg.startPos, segEnd = seg.startPos + seg.numSoft;
        if (segEnd <= chunkStart || segStart >= chunkEnd) continue;
        const srcRow0 = Math.max(segStart, chunkStart) - segStart;   // feature row to start from
        const dstRow0 = Math.max(segStart, chunkStart) - chunkStart; // local hidden row
        const rows = Math.min(segEnd, chunkEnd) - Math.max(segStart, chunkStart);
        const H = seg.hidden;
        // host.writeBuffer(buffer, bufferOffset, data) writes the WHOLE `data`
        // array, so pass a subarray covering exactly the rows we need.
        const slice = seg.features.subarray(srcRow0 * H, srcRow0 * H + rows * H);
        s.writeBuffer(or.hiddenT.buffer, dstRow0 * H * 4, slice);
        if (globalThis.__G4V_INJECT_DEBUG) {
          console.log(`[INJECT] scatter seg@${seg.startPos}+${seg.numSoft}: srcRow0=${srcRow0} dstRow0=${dstRow0} rows=${rows} dstByte=${dstRow0 * H * 4} sliceLen=${slice.length}`);
        }
      }
      // 3) run the rest of the prefill
      or.col.enqueue(or.steps.slice(1));
      return true;
    },

    perLayerEmbed(S, ne, args, seq, host) {
      const ov = activeOverride;
      if (globalThis.__G4V_INJECT_DEBUG) {
        console.log(`[INJECT] perLayerEmbed fire: seq=${seq} paddedLen=${ov?.paddedIds?.length} match=${!!(ov && ov.paddedIds && ov.paddedIds.length === seq)}`);
      }
      if (ov && ov.paddedIds && ov.paddedIds.length === seq) {
        // image tokens -> PAD for the per-layer embedding lookup
        const ne2 = host.tensorFromTypedArray("uint32", [seq], ov.paddedIds);
        S.qatEmbed({ ...args, idsT: ne2 });
      } else {
        S.qatEmbed(args);
      }
    },
  };
}

/** Load an image input (url / RawImage-like / canvas / ImageBitmap) into a form Gemma4Vision accepts. */
async function resolveImage(item) {
  if (item && (item.type === "image" || item.type === "image_url")) {
    if (item.url || item.src) {
      const url = item.url || item.src;
      if (typeof createImageBitmap === "function") {
        const resp = await fetch(url);
        const blob = await resp.blob();
        return await createImageBitmap(blob);
      }
      throw new Error("createImageBitmap unavailable for image url");
    }
    if (item.image) return item.image;
    // item itself is the image (RawImage-like / canvas / ImageData)
    return item;
  }
  return item;
}

/**
 * Wrap a Gemma4Mobile instance so `generate()` accepts multimodal messages.
 * @param {import("./gemma-4-e2b.js").Gemma4Mobile} base
 * @param {Gemma4Vision} vision
 */
export class VisionGemma4Mobile {
  constructor(base, vision) {
    this.base = base;
    this.vision = vision;
    this.imageTokenId = base._model?.config?.image_token_id ?? 258880;
    this.padTokenId = base._model?.config?.text_config?.pad_token_id ?? 0;
    // Vision encode() is the dominant part of vision TTFT (~3s). Cache features
    // per image (keyed by URL/src) so re-asking about the same image skips the
    // encode. Bounded LRU-ish: capped at 8 entries, cleared on reset/dispose.
    this._imgCache = new Map();
    this._imgCacheCap = 8;
  }
  // URL-keyed cache key for an image content item (null => not cacheable, e.g.
  // a raw canvas/RawImage that has no stable identity).
  _imageCacheKey(item) {
    const url = item?.url || item?.src;
    return typeof url === "string" && url.length > 0 ? url : null;
  }
  _imageCacheGet(key) {
    if (!key) return null;
    return this._imgCache.get(key) ?? null;
  }
  _imageCachePut(key, value) {
    if (!key) return;
    this._imgCache.set(key, value);
    if (this._imgCache.size > this._imgCacheCap) {
      // evict oldest
      const oldest = this._imgCache.keys().next().value;
      this._imgCache.delete(oldest);
    }
  }
  get runtime() { return this.base.runtime; }
  encodePrompt(messages) { return this.base.encodePrompt(messages); }
  deviceInfo() { return this.base.deviceInfo(); }
  get _model() { return this.base._model; }
  get _generationState() { return this.base._generationState; }
  get _eosTokenIds() { return this.base._eosTokenIds; }
  get _disposed() { return this.base._disposed; }
  getSpecialTokenIds() { return this.base.getSpecialTokenIds(); }
  getContextCapabilities() { return this.base.getContextCapabilities?.() ?? null; }
  ensureContextCapacity(required) { return this.base.ensureContextCapacity?.(required); }
  countTextTokens(text) { return this.base.countTextTokens?.(text) ?? this.base.countPromptTokens([{ role: "user", content: String(text ?? "") }]); }

  async _expandMessages(messages) {
    const expanded = [];
    const segments = [];
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) { expanded.push(msg); continue; }
      const newContent = [];
      for (const item of msg.content) {
        if (item && (item.type === "image" || item.type === "image_url")) {
          const cacheKey = this._imageCacheKey(item);
          let encoded = this._imageCacheGet(cacheKey);
          if (!encoded) {
            const img = await resolveImage(item);
            const { image_features, num_soft_tokens } = await this.vision.encode(img);
            encoded = { features: image_features, numSoft: num_soft_tokens };
            this._imageCachePut(cacheKey, encoded);
          }
          segments.push({ features: encoded.features, numSoft: encoded.numSoft, hidden: 1536, startPos: -1 });
          newContent.push({ type: "text", text: `\n${BOI}${IMAGE_TOKEN.repeat(encoded.numSoft)}${EOI}\n` });
        } else {
          newContent.push(item);
        }
      }
      expanded.push({ ...msg, content: newContent });
    }
    return { expanded, segments };
  }

  countPromptTokens(messages) {
    const hasImages = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((c) => c && (c.type === "image" || c.type === "image_url"))
    );
    if (!hasImages) return this.base.countPromptTokens(messages);
    return this._expandMessages(messages).then(({ expanded }) => this.base.countPromptTokens(expanded));
  }

  async* generate(messages, opts = {}) {
    const hasImages = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((c) => c && (c.type === "image" || c.type === "image_url"))
    );
    if (!hasImages) {
      yield* this.base.generate(messages, opts);
      return;
    }

    // Expand images once here; the same operation is used by exact token counting.
    const { expanded, segments } = await this._expandMessages(messages);

    // 2) tokenize the expanded prompt to find the image-token positions.
    const ids = this.base.encodePrompt(expanded);
    const imgId = this.imageTokenId;
    const imgPositions = [];
    for (let i = 0; i < ids.length; i++) if (ids[i] === imgId) imgPositions.push(i);
    if (imgPositions.length !== segments.reduce((a, s) => a + s.numSoft, 0)) {
      throw new Error(
        `image token mismatch: prompt has ${imgPositions.length} image tokens, features need ${segments.reduce((a, s) => a + s.numSoft, 0)}`
      );
    }
    // assign each segment a contiguous run of image positions (in order)
    let cursor = 0;
    for (const seg of segments) {
      seg.startPos = imgPositions[cursor];
      cursor += seg.numSoft;
    }

    // 3) build the padded per-layer ids (image -> PAD) and arm the override.
    const paddedIds = new Uint32Array(ids.length);
    for (let i = 0; i < ids.length; i++) paddedIds[i] = ids[i] === imgId ? this.padTokenId : ids[i];
    activeOverride = { segments, paddedIds };
    if (globalThis.__G4V_INJECT_DEBUG) {
      console.log(`[INJECT] prompt ids len=${ids.length} imgId=${imgId} padId=${this.padTokenId} imgPositions=${imgPositions.length} firstImgPos=${imgPositions[0]} lastImgPos=${imgPositions[imgPositions.length - 1]} segments=${segments.map((s) => `${s.startPos}+${s.numSoft}`).join(",")} paddedLen=${paddedIds.length} textBefore=${ids.slice(0, imgPositions[0] ?? 0).length} textAfter=${ids.length - (imgPositions[imgPositions.length - 1] ?? 0) - 1}`);
    }

    // 4) Generate WITHOUT resetting. The expanded prompt is a strict extension of
    //    the previous one (append-only chat), so the kernel's own overlap
    //    detection incrementally prefills only the new suffix:
    //      - text-only follow-ups: no image in the new chunk -> normal prefill;
    //        historical image features are already in the KV cache.
    //      - a NEW image in this turn: its tokens are in the newly-prefilled
    //        chunk and `runPrefill`/`paddedChunkIds` inject the features at the
    //        correct (offset-aware) rows.
    //    If a prompt ever isn't a clean continuation, the kernel falls back to a
    //    full reset + re-prefill (all segments are armed, so features still land
    //    at the right rows).
    if (globalThis.__G4V_INJECT_DEBUG) {
      console.log(`[INJECT] generate (no reset) ids=${ids.length} segments=${segments.map((s) => `${s.startPos}+${s.numSoft}`).join(",")}`);
    }
    try {
      yield* this.base.generate(expanded, opts);
    } finally {
      activeOverride = null;
    }
  }

  async complete(messages, opts = {}) {
    let text = "";
    for await (const x of this.generate(messages, opts)) text = x.text;
    return text;
  }

  reset() { this.base.reset(); this._imgCache?.clear(); }
  dispose() { this.base.dispose(); this._imgCache?.clear(); }
}
