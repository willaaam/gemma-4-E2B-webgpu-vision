// gemma4-sg-guard.js: portable subgroup-correctness guard for the gemma-4-e2b QAT engine.
//
// THE BUG (localized July 11 2026, RTX 5070 / D3D12, real-kernel A/B + mutation lab):
// the engine's QatMatMul template family emits a BARE `subgroupAdd` in `fn reduce`
// (no sgExact32 guard, while every other kernel family swaps in a 32-lane subgroupShuffleXor
// butterfly on ranged-width adapters). On NVIDIA D3D12 the compiled kernel runs at
// subgroup_size 32 (measured in-kernel), yet every N_ROWS=2 instantiation returns
// corrupt sums for the second output row: a WaveActiveSum executed after a lane-
// divergent `if (tid==0)` store is miscompiled (reconvergence failure). Swapping the
// reduce body for the engine's own butterfly fixes all instantiations (6/6 divergent
// -> OK, verified on-device); hoisting reductions above the stores also fixes it.
//
// THE GUARD (behavior-verified ladder, no vendor sniffing):
//   exact-32 adapter (e.g. Apple)          -> do nothing; engine untouched, bit-identical
//   ranged-width adapter, self-test PASSes -> patch bare reduce -> butterfly, keep subgroups
//   self-test FAILs even patched           -> disable subgroup features entirely (safe mode)
//
// Usage (before Gemma4Mobile.load):
//   import { gemma4SgGuard } from './gemma4-sg-guard.js';
//   const guard = await gemma4SgGuard();
//   const model = await Gemma4Mobile.load(null, { ...guard.loadOpts, onProgress });
//   console.log(guard.mode, guard.selfTest);

const BARE_REDUCE =
`fn reduce(value: f32, tid: u32) -> f32 {
  return subgroupAdd(value);
}`;

// the engine's own ranged-width reduction body (identical to its sgExact32-guarded families)
const BFLY_BODY =
`  var x = value;
  x = x + subgroupShuffleXor(x, 1u);
  x = x + subgroupShuffleXor(x, 2u);
  x = x + subgroupShuffleXor(x, 4u);
  x = x + subgroupShuffleXor(x, 8u);
  x = x + subgroupShuffleXor(x, 16u);
  return x;`;

const BFLY_REDUCE =
`fn reduce(value: f32, tid: u32) -> f32 {
${BFLY_BODY}
}`;

// any bare single-subgroupAdd reduce helper, whatever its name (reduce / reduce_sum / …);
// the guarded families' helpers have multi-line bodies and never match
const BARE_RE = /fn (reduce\w*)\(value: f32, tid: u32\) -> f32 \{\n  return subgroupAdd\(value\);\n\}/g;

// Minimal faithful instantiation of the QatMatMul prefill template (M_TILE>1 branch):
// same uniform K-loop, same nibble unpack, same INTERLEAVED reduce -> tid==0-store tail
// that triggers the reconvergence bug. IN=512, OUT=4, M=2, N_ROWS=2, WG=32.
const MINI_QATMATMUL = (reduceFn) => `enable subgroups;
struct Params { inScale: f32, outScale: f32, _pad0: u32, _pad1: u32 };
@group(0) @binding(0) var<storage, read> a: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> bits_buf: array<u32>;
@group(0) @binding(2) var<storage, read> scale: array<f32>;
@group(0) @binding(3) var<storage, read_write> out: array<f32>;
@group(0) @binding(4) var<uniform> params: Params;

const M: u32 = 2u;
const M_TILE: u32 = 2u;
const IN_FEATURES: u32 = 512u;
const OUT_FEATURES: u32 = 4u;
const VALS_PER_WORD: u32 = 8u;
const CHUNKS: u32 = 2u;
const WORDS_PER_ROW: u32 = 64u;
const ZP: f32 = 8.0;
const GRID_X: u32 = 2u;
const WG: u32 = 32u;
const N_ROWS: u32 = 2u;

fn srq(x: f32, s: f32) -> f32 {
  if (s == 0.0) { return x; }
  return clamp(round(x / s), -128.0, 127.0) * s;
}
fn srq4(x: vec4<f32>, s: f32) -> vec4<f32> {
  if (s == 0.0) { return x; }
  return clamp(round(x / s), vec4<f32>(-128.0), vec4<f32>(127.0)) * s;
}

${reduceFn}

@compute @workgroup_size(32, 1, 1)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let wgId = wg.y * GRID_X + wg.x;
  let rowBase = wgId * N_ROWS;
  if (rowBase >= OUT_FEATURES) {
    return;
  }
  let tid = lid.x;
  let inScale = params.inScale;
  let outScale = params.outScale;

  let mStart = wg.z * M_TILE;
  let mOk0 = mStart + 0u < M;
  var sumA_0: f32 = 0.0;
  var sumQA_0_0: f32 = 0.0;
  var sumQA_0_1: f32 = 0.0;
  let mOk1 = mStart + 1u < M;
  var sumA_1: f32 = 0.0;
  var sumQA_1_0: f32 = 0.0;
  var sumQA_1_1: f32 = 0.0;

  var w: u32 = tid;
  loop {
    if (w >= WORDS_PER_ROW) {
      break;
    }
    var packed0: u32 = 0u;
    if (rowBase + 0u < OUT_FEATURES) { packed0 = bits_buf[(rowBase + 0u) * WORDS_PER_ROW + w]; }
    let lo0 = vec4<f32>(unpack4xU8(packed0 & 0x0F0F0F0Fu));
    let hi0 = vec4<f32>(unpack4xU8((packed0 >> 4u) & 0x0F0F0F0Fu));
    let q0_0 = vec4<f32>(lo0.x, hi0.x, lo0.y, hi0.y);
    let q0_1 = vec4<f32>(lo0.z, hi0.z, lo0.w, hi0.w);
    var packed1: u32 = 0u;
    if (rowBase + 1u < OUT_FEATURES) { packed1 = bits_buf[(rowBase + 1u) * WORDS_PER_ROW + w]; }
    let lo1 = vec4<f32>(unpack4xU8(packed1 & 0x0F0F0F0Fu));
    let hi1 = vec4<f32>(unpack4xU8((packed1 >> 4u) & 0x0F0F0F0Fu));
    let q1_0 = vec4<f32>(lo1.x, hi1.x, lo1.y, hi1.y);
    let q1_1 = vec4<f32>(lo1.z, hi1.z, lo1.w, hi1.w);
    if (mOk0) {
      let aV4Base0 = (mStart + 0u) * (IN_FEATURES / 4u) + w * CHUNKS;
      let a0_0 = srq4(vec4<f32>(a[aV4Base0 + 0u]), inScale);
      sumA_0 = sumA_0 + a0_0.x + a0_0.y + a0_0.z + a0_0.w;
      sumQA_0_0 = sumQA_0_0 + dot(q0_0, a0_0);
      sumQA_0_1 = sumQA_0_1 + dot(q1_0, a0_0);
      let a0_1 = srq4(vec4<f32>(a[aV4Base0 + 1u]), inScale);
      sumA_0 = sumA_0 + a0_1.x + a0_1.y + a0_1.z + a0_1.w;
      sumQA_0_0 = sumQA_0_0 + dot(q0_1, a0_1);
      sumQA_0_1 = sumQA_0_1 + dot(q1_1, a0_1);
    }
    if (mOk1) {
      let aV4Base1 = (mStart + 1u) * (IN_FEATURES / 4u) + w * CHUNKS;
      let a1_0 = srq4(vec4<f32>(a[aV4Base1 + 0u]), inScale);
      sumA_1 = sumA_1 + a1_0.x + a1_0.y + a1_0.z + a1_0.w;
      sumQA_1_0 = sumQA_1_0 + dot(q0_0, a1_0);
      sumQA_1_1 = sumQA_1_1 + dot(q1_0, a1_0);
      let a1_1 = srq4(vec4<f32>(a[aV4Base1 + 1u]), inScale);
      sumA_1 = sumA_1 + a1_1.x + a1_1.y + a1_1.z + a1_1.w;
      sumQA_1_0 = sumQA_1_0 + dot(q0_1, a1_1);
      sumQA_1_1 = sumQA_1_1 + dot(q1_1, a1_1);
    }
    w = w + WG;
  }

  if (mOk0) {
    let rA0 = reduce(sumA_0, tid);
    {
      let rQA = reduce(sumQA_0_0, tid);
      let o = rowBase + 0u;
      if (tid == 0u && o < OUT_FEATURES) {
        out[(mStart + 0u) * OUT_FEATURES + o] = f32(srq(scale[o] * (rQA - ZP * rA0), outScale));
      }
    }
    {
      let rQA = reduce(sumQA_0_1, tid);
      let o = rowBase + 1u;
      if (tid == 0u && o < OUT_FEATURES) {
        out[(mStart + 0u) * OUT_FEATURES + o] = f32(srq(scale[o] * (rQA - ZP * rA0), outScale));
      }
    }
  }
  if (mOk1) {
    let rA1 = reduce(sumA_1, tid);
    {
      let rQA = reduce(sumQA_1_0, tid);
      let o = rowBase + 0u;
      if (tid == 0u && o < OUT_FEATURES) {
        out[(mStart + 1u) * OUT_FEATURES + o] = f32(srq(scale[o] * (rQA - ZP * rA1), outScale));
      }
    }
    {
      let rQA = reduce(sumQA_1_1, tid);
      let o = rowBase + 1u;
      if (tid == 0u && o < OUT_FEATURES) {
        out[(mStart + 1u) * OUT_FEATURES + o] = f32(srq(scale[o] * (rQA - ZP * rA1), outScale));
      }
    }
  }
}
`;

const mulberry32 = (s) => () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// Minimal faithful instantiation of the engine's subgroup-matrix (SGMat) kernels
// (DenseGemvSgmat / gemm_sgmat / decode-gate-up-norm-sgmat): f16 8x8 left/right
// matrices, f32 8x8 result, subgroupMatrixLoad/MMA/Store. Some adapters advertise
// chromium-experimental-subgroup-matrix yet reject specific configs at pipeline
// creation (e.g. Intel Xe-2 HPG: "Unknown configuration is M(0), N(8), K(8), f16").
const MINI_SGMAT = `enable f16;
enable subgroups;
enable chromium_experimental_subgroup_matrix;
diagnostic(off, chromium.subgroup_matrix_uniformity);

@group(0) @binding(0) var<storage, read> a: array<f16>;
@group(0) @binding(1) var<storage, read> b: array<f16>;
@group(0) @binding(2) var<storage, read_write> c: array<f32>;

@compute @workgroup_size(8, 1, 1)
fn main(@builtin(local_invocation_index) lid: u32) {
  var tileA: array<f16, 64>;
  var tileB: array<f16, 64>;
  var scratch: array<f32, 64>;
  var matA: subgroup_matrix_left<f16, 8, 8> = subgroupMatrixLoad<subgroup_matrix_left<f16, 8, 8>>(&tileA, 0u, false, 8u);
  var matB: subgroup_matrix_right<f16, 8, 8> = subgroupMatrixLoad<subgroup_matrix_right<f16, 8, 8>>(&tileB, 0u, true, 8u);
  var matC: subgroup_matrix_result<f32, 8, 8>;
  matC = subgroupMatrixMultiplyAccumulate(matA, matB, matC);
  subgroupMatrixStore(&scratch, 0u, matC, false, 8u);
  c[lid] = scratch[lid];
}
`;

// Returns 'PASS' | 'FAIL(...)'. Only pipeline creation matters — the engine fails at
// createComputePipeline, so we don't need to run the kernel. If the adapter doesn't
// advertise the SGMat feature the engine won't use SGMat kernels, so that's a PASS.
async function sgmatSelfTest(ad) {
  if (!ad.features.has('chromium-experimental-subgroup-matrix')) return 'PASS';
  let dev;
  try {
    dev = await ad.requestDevice({ requiredFeatures: ['subgroups', 'chromium-experimental-subgroup-matrix'] });
  } catch (e) {
    return 'FAIL(request: ' + String(e && e.message || e).slice(0, 80) + ')';
  }
  try {
    const mod = dev.createShaderModule({ code: MINI_SGMAT });
    const info = await mod.getCompilationInfo();
    const errs = info.messages.filter(m => m.type === 'error');
    if (errs.length) return 'FAIL(compile: ' + errs[0].message.slice(0, 80) + ')';
    dev.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
    return 'PASS';
  } catch (e) {
    return 'FAIL(' + String(e && e.message || e).slice(0, 80) + ')';
  } finally {
    dev.destroy();
  }
}

// run the mini kernel against a JS reference; returns 'PASS' | 'FAIL(maxRel)' | 'ERR(...)'
async function selfTest(dev, reduceFn) {
  const M = 2, IN = 512, OUT = 4, WORDS = IN / 8;
  const rnd = mulberry32(0xBEEF);
  const aF = new Float32Array(M * IN);       for (let i = 0; i < aF.length; i++) aF[i] = rnd() * 2 - 1;
  const bitsU = new Uint32Array(OUT * WORDS); for (let i = 0; i < bitsU.length; i++) bitsU[i] = (rnd() * 4294967296) >>> 0;
  const scaleF = new Float32Array(OUT);       for (let i = 0; i < OUT; i++) scaleF[i] = rnd() * 2 - 1;
  const params = new Float32Array(4);         // inScale=0, outScale=0 -> srq passthrough
  // JS reference (f64 accumulation)
  const q = (o, k) => { const word = bitsU[o * WORDS + (k >> 3)], v = k & 7, byte = (word >>> ((v >> 1) * 8)) & 0xFF;
    return (v & 1) ? (byte >>> 4) & 15 : byte & 15; };
  const ref = new Float64Array(M * OUT);
  for (let m = 0; m < M; m++) for (let o = 0; o < OUT; o++) {
    let qa = 0, asum = 0;
    for (let k = 0; k < IN; k++) { const av = aF[m * IN + k]; qa += q(o, k) * av; asum += av; }
    ref[m * OUT + o] = scaleF[o] * (qa - 8 * asum);
  }
  try {
    const mod = dev.createShaderModule({ code: MINI_QATMATMUL(reduceFn) });
    const info = await mod.getCompilationInfo();
    const errs = info.messages.filter(m => m.type === 'error');
    if (errs.length) return 'ERR(compile: ' + errs[0].message.slice(0, 80) + ')';
    const pipe = dev.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
    const mk = (arr, usage) => { const b = dev.createBuffer({ size: Math.max(arr.byteLength, 16), usage: usage | GPUBufferUsage.COPY_DST });
      dev.queue.writeBuffer(b, 0, arr); return b; };
    const bufs = [ mk(aF, GPUBufferUsage.STORAGE), mk(bitsU, GPUBufferUsage.STORAGE), mk(scaleF, GPUBufferUsage.STORAGE),
      mk(new Float32Array(M * OUT), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC), mk(params, GPUBufferUsage.UNIFORM) ];
    const bg = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: bufs.map((b, i) => ({ binding: i, resource: { buffer: b } })) });
    dev.pushErrorScope('validation'); dev.pushErrorScope('internal');
    const enc = dev.createCommandEncoder(); const pass = enc.beginComputePass();
    pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(2, 1, 1); pass.end();
    const staging = dev.createBuffer({ size: M * OUT * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyBufferToBuffer(bufs[3], 0, staging, 0, M * OUT * 4);
    dev.queue.submit([enc.finish()]);
    await dev.queue.onSubmittedWorkDone();
    const eInt = await dev.popErrorScope(), eVal = await dev.popErrorScope();
    if (eVal || eInt) { bufs.forEach(b => b.destroy()); staging.destroy(); return 'ERR(gpu: ' + (eVal || eInt).message.slice(0, 80) + ')'; }
    await staging.mapAsync(GPUMapMode.READ);
    const got = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap(); staging.destroy(); bufs.forEach(b => b.destroy());
    let maxRel = 0;
    for (let i = 0; i < ref.length; i++) {
      const denom = Math.max(Math.abs(ref[i]), Math.abs(got[i]), 1e-3);
      maxRel = Math.max(maxRel, Math.abs(got[i] - ref[i]) / denom);
    }
    return maxRel < 1e-3 ? 'PASS' : 'FAIL(' + maxRel.toExponential(2) + ')';
  } catch (e) { return 'ERR(' + String(e && e.message || e).slice(0, 80) + ')'; }
}

let installed = false;
function installPatcher(state) {
  if (installed) return;
  installed = true;
  const orig = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function (desc) {
    if (state.active && typeof desc?.code === 'string' && desc.code.includes('enable subgroups')) {
      BARE_RE.lastIndex = 0;
      if (BARE_RE.test(desc.code)) {
        state.patched++;
        BARE_RE.lastIndex = 0;
        const code = desc.code.replace(BARE_RE, (_, name) => `fn ${name}(value: f32, tid: u32) -> f32 {\n${BFLY_BODY}\n}`);
        return orig.call(this, { ...desc, code });
      }
    }
    return orig.call(this, desc);
  };
}

function isWindowsHost() {
  try {
    const uaData = navigator.userAgentData;
    if (uaData?.platform) return /Windows/i.test(uaData.platform);
  } catch (_) { /* ignore */ }
  return /Win/i.test(navigator.platform || '') || /Windows/i.test(navigator.userAgent || '');
}

export async function gemma4SgGuard({ force = false } = {}) {
  const result = { mode: 'exact32-stock', patched: 0, selfTest: {}, loadOpts: {},
                   adapter: null, error: null };
  try {
    if (!navigator.gpu) { result.mode = 'no-webgpu'; return result; }
    const ad = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!ad) { result.mode = 'no-adapter'; return result; }
    result.adapter = { vendor: ad.info?.vendor, architecture: ad.info?.architecture,
                       subgroupMinSize: ad.info?.subgroupMinSize, subgroupMaxSize: ad.info?.subgroupMaxSize };
    if (!ad.features.has('subgroups')) { result.mode = 'no-subgroups'; return result; }
    const exact32 = ad.info?.subgroupMinSize === 32 && ad.info?.subgroupMaxSize === 32;
    // Windows can report exact 32/32 yet still miscompile bare subgroupAdd after
    // divergent stores — never take the Apple bit-identical early return there.
    if (exact32 && !force && !isWindowsHost()) return result;

    // ranged-width adapter (or forced / Windows): verify on THIS machine, then patch or fall back
    const dev = await ad.requestDevice({ requiredFeatures: ['subgroups'] });
    result.selfTest.bare = await selfTest(dev, BARE_REDUCE);       // telemetry: does the stock reduce break here?
    result.selfTest.butterfly = await selfTest(dev, BFLY_REDUCE);  // the gate
    dev.destroy();

    // SGMat (subgroup-matrix) kernels are a separate feature: some adapters advertise
    // chromium-experimental-subgroup-matrix yet reject the engine's f16 8x8 config at
    // pipeline creation (Intel Xe-2 HPG). If SGMat is unusable, keep the (patched)
    // subgroup kernels but disable only the SGMat feature so the engine picks its
    // register-blocked non-SGMat fallbacks.
    result.selfTest.sgmat = await sgmatSelfTest(ad);

    if (result.selfTest.butterfly === 'PASS' && result.selfTest.sgmat === 'PASS') {
      const state = { active: true, patched: 0 };
      installPatcher(state);
      result.mode = 'patched-sg';
      Object.defineProperty(result, 'patched', { get: () => state.patched });
    } else if (result.selfTest.butterfly === 'PASS' && result.selfTest.sgmat !== 'PASS') {
      const state = { active: true, patched: 0 };
      installPatcher(state);
      result.mode = 'sgmat-fallback';
      result.loadOpts = { runtimeOptions: { disabledFeatures: ['chromium-experimental-subgroup-matrix'] } };
      Object.defineProperty(result, 'patched', { get: () => state.patched });
    } else {
      result.mode = 'nosubgroups-fallback';
      result.loadOpts = { runtimeOptions: { disabledFeatures: ['subgroups', 'chromium-experimental-subgroup-matrix'] } };
    }
  } catch (e) {
    result.error = String(e && e.message || e).slice(0, 160);
    result.mode = 'nosubgroups-fallback';
    result.loadOpts = { runtimeOptions: { disabledFeatures: ['subgroups', 'chromium-experimental-subgroup-matrix'] } };
  }
  return result;
}
