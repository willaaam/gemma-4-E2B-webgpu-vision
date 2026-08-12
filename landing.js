import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

// ============ DEVICE DETECTION ============
const isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);
const gpuTier = (() => {
  const gl = document.createElement('canvas').getContext('webgl');
  if (!gl) return 'low';
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL).toLowerCase() : '';
  // Apple GPU = Apple Silicon (M1/M2/M3/M4) — these are high-tier
  if (/apple gpu|apple m/.test(gpu)) return 'high';
  // Low-tier: old Intel integrated, software renderers, old mobile chips
  if (/swiftshader|llvmpipe|mali-4|adreno 3/.test(gpu)) return 'low';
  if (/intel(?!.*(iris|uhd|arc))/.test(gpu)) return 'low';
  // Mid-tier: mid-range mobile, Intel Iris/UHD, older discrete
  if (/mali-g[567]|adreno [45]|intel (iris|uhd)|geforce (mx|gt)|radeon (rx )?(5[0-4]|vega 8)/.test(gpu)) return 'mid';
  // Everything else (RTX, RX 6000+, Arc, etc.) = high
  return 'high';
})();

const qualityPresets = {
  low:  { pixelRatio: 1.0,  marchSteps: 48,  aoSteps: 2,  dotSize: 6.0, dotGap: 3.0, scanlines: 0.55, bloomEnabled: false },
  mid:  { pixelRatio: 1.25, marchSteps: 64,  aoSteps: 3,  dotSize: 5.0, dotGap: 2.5, scanlines: 0.75, bloomEnabled: true  },
  high: { pixelRatio: 1.5,  marchSteps: 80,  aoSteps: 3,  dotSize: 5.0, dotGap: 2.5, scanlines: 0.75, bloomEnabled: true  },
};
let currentTier = isMobile ? 'low' : gpuTier;
let quality = { ...qualityPresets[currentTier] };

// ============ SETTINGS ============
const settings = {
  dither: { enabled: true, dotSize: quality.dotSize, dotGap: quality.dotGap, brightness: 0.85, contrast: 0.60, threshold: 0.03, dotColor: [1.0, 1.0, 1.0], bgColor: [0.00784, 0.00784, 0.01176] },
  crosshatch: { enabled: false, intensity: 0.95, angle: 0.4363 },
  bloom: { enabled: quality.bloomEnabled, intensity: 0.55, size: 1.50 },
  crt: { enabled: true, curvature: 0.0, scanlines: quality.scanlines, vignette: 2.00, chroma: 0.0 },
  scene: { gooeyness: 1.20, speed: 0.85 }
};

// ============ MOUSE TRACKING ============
const mouse = new THREE.Vector2(0, 0);
let mouseInScene = false;
let mousePressed = false;
let mouseSphereRadius = 0.0;
const mouseSphereTargetRadius = 0.55;
const mouseSphereClickRadius = 0.95;
const mouseWorld = new THREE.Vector3(0, 0, 0);
const mouseWorldTarget = new THREE.Vector3(0, 0, 0);
const mouseDamping = 0.15;

// ============ THREE.JS SETUP ============
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020203);

const crtFrame = document.getElementById('crt-frame');
const getSize = () => {
  return { width: window.innerWidth, height: window.innerHeight };
};
let size = getSize();

const camera = new THREE.PerspectiveCamera(60, size.width / size.height, 0.1, 100);
camera.position.set(0, 0, 5);
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setSize(size.width, size.height);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatio));
crtFrame.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.enableZoom = false;
controls.enablePan = false;
controls.enableRotate = false;
controls.enabled = false; // prevent OrbitControls from capturing scroll/pointer events

// ============ INPUT EVENTS ============
let pageVisible = true;
// Render only while the hero canvas is actually on screen. When the chat view scrolls into
// place the background pauses itself (below), freeing the GPU for the WebGPU model so decode
// throughput isn't dragged down by the WebGL background.
let heroOnScreen = true;
const onPointerMove = (e) => {
  mouseInScene = true;
  const x = e.clientX ?? (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
  const y = e.clientY ?? (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
  mouse.x = (x / window.innerWidth) * 2 - 1;
  mouse.y = -(y / window.innerHeight) * 2 + 1;
};
document.addEventListener('mousemove', onPointerMove, { passive: true });
document.addEventListener('touchmove', onPointerMove, { passive: true });
document.addEventListener('mouseenter', () => { mouseInScene = true; }, { passive: true });
document.addEventListener('mouseleave', () => { mouseInScene = false; }, { passive: true });
document.addEventListener('touchstart', (e) => { mouseInScene = true; mousePressed = true; onPointerMove(e); }, { passive: true });
document.addEventListener('touchend', () => { mousePressed = false; mouseInScene = false; }, { passive: true });
document.addEventListener('visibilitychange', () => {
  pageVisible = !document.hidden;
  if (document.hidden) mouseInScene = false;
});
// Pause the WebGL background as soon as the chat view dominates the screen, so it never competes
// with the WebGPU model for the GPU. Resume when scrolling back to the landing. Falls back to the
// hero canvas's own visibility if there is no #chat section on the page.
const chatSection = document.getElementById('chat');
if (chatSection) {
  new IntersectionObserver(([entry]) => { heroOnScreen = entry.intersectionRatio < 0.4; }, { threshold: [0, 0.4, 1] }).observe(chatSection);
} else {
  new IntersectionObserver(([entry]) => { heroOnScreen = entry.isIntersecting; }, { threshold: 0 }).observe(crtFrame);
}
document.addEventListener('mousedown', () => { mousePressed = true; }, { passive: true });
document.addEventListener('mouseup', () => { mousePressed = false; }, { passive: true });

// ============ RAYMARCHING QUAD ============
const quadGeometry = new THREE.PlaneGeometry(2, 2);
const quadMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(size.width, size.height) },
    uCameraPos: { value: camera.position.clone() },
    uCameraTarget: { value: new THREE.Vector3(0, 0, 0) },
    uPixelRatio: { value: Math.min(window.devicePixelRatio, 1.5) },
    uGooeyness: { value: settings.scene.gooeyness },
    uSpeed: { value: settings.scene.speed },
    uMouseSpherePos: { value: new THREE.Vector3(0, 0, 0) },
    uMouseSphereRadius: { value: 0.0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    precision highp float;
    #define MARCH_STEPS ${quality.marchSteps}
    #define AO_STEPS ${quality.aoSteps}
    uniform float uTime;
    uniform vec2 uResolution;
    uniform vec3 uCameraPos;
    uniform vec3 uCameraTarget;
    uniform float uPixelRatio;
    uniform float uGooeyness;
    uniform float uSpeed;
    uniform vec3 uMouseSpherePos;
    uniform float uMouseSphereRadius;

    varying vec2 vUv;

    float smin(float a, float b, float k) {
      float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
      return mix(b, a, h) - k * h * (1.0 - h);
    }

    float sdSphere(vec3 p, vec3 center, float radius) {
      return length(p - center) - radius;
    }

    float sceneCompound(vec3 p, float t, float k) {
      // Two large primary blobs
      float angle1 = t * 0.5;
      float angle2 = t * 0.5 + 3.14159;
      vec3 c1 = vec3(
        cos(angle1) * 2.4 + sin(t * 0.25) * 0.3,
        sin(angle1 * 0.6) * 0.8 + cos(t * 0.4) * 0.2,
        sin(angle1 * 0.35) * 0.6
      );
      vec3 c2 = vec3(
        cos(angle2) * 2.4 + sin(t * 0.3) * 0.3,
        sin(angle2 * 0.6) * 0.8 - cos(t * 0.35) * 0.2,
        sin(angle2 * 0.35) * 0.6
      );
      float s1 = sdSphere(p, c1, 1.2 + 0.07 * sin(t * 2.5));
      float s2 = sdSphere(p, c2, 1.05 + 0.07 * cos(t * 2.0));

      // Medium satellites
      vec3 c3 = c1 + vec3(sin(t * 1.8) * 0.9, cos(t * 2.2) * 0.9, sin(t * 1.5) * 0.6);
      vec3 c4 = c2 + vec3(-cos(t * 1.5) * 0.8, sin(t * 1.9) * 0.8, -cos(t * 1.7) * 0.5);
      float s3 = sdSphere(p, c3, 0.55);
      float s4 = sdSphere(p, c4, 0.5);

      // Free-floating blobs
      vec3 c5 = vec3(sin(t * 0.7) * 3.0, cos(t * 0.55) * 1.2, cos(t * 0.45) * 0.7);
      vec3 c6 = vec3(-cos(t * 0.65) * 2.8, sin(t * 0.75) * 1.0, sin(t * 0.5) * 0.8);
      float s5 = sdSphere(p, c5, 0.6);
      float s6 = sdSphere(p, c6, 0.55);

      float d = smin(s1, s2, k);
      d = smin(d, s3, k * 0.7);
      d = smin(d, s4, k * 0.7);
      d = smin(d, s5, k * 0.8);
      d = smin(d, s6, k * 0.8);
      return d;
    }

    float sceneSDF(vec3 p) {
      float t = uTime * uSpeed;
      float k = uGooeyness;
      float d = sceneCompound(p, t, k);
      if (uMouseSphereRadius > 0.001) {
        float ms = sdSphere(p, uMouseSpherePos, uMouseSphereRadius);
        d = smin(d, ms, k * 0.8);
      }
      return d;
    }

    vec3 calcNormal(vec3 p) {
      const float eps = 0.001;
      vec2 h = vec2(eps, 0.0);
      return normalize(vec3(
        sceneSDF(p + h.xyy) - sceneSDF(p - h.xyy),
        sceneSDF(p + h.yxy) - sceneSDF(p - h.yxy),
        sceneSDF(p + h.yyx) - sceneSDF(p - h.yyx)
      ));
    }

    float calcAO(vec3 pos, vec3 nor) {
      float occ = 0.0;
      float sca = 1.0;
      for (int i = 0; i < AO_STEPS; i++) {
        float h = 0.02 + 0.15 * float(i);
        float d = sceneSDF(pos + h * nor);
        occ += (h - d) * sca;
        sca *= 0.9;
      }
      return clamp(1.0 - 3.0 * occ, 0.0, 1.0);
    }

    float fresnel(vec3 viewDir, vec3 normal, float power) {
      return pow(1.0 - max(dot(viewDir, normal), 0.0), power);
    }

    // Fake directional shadow via downward AO probe
    float cheapShadow(vec3 pos, vec3 lightDir) {
      float d1 = sceneSDF(pos + lightDir * 0.15);
      float d2 = sceneSDF(pos + lightDir * 0.4);
      float d3 = sceneSDF(pos + lightDir * 0.8);
      return clamp(0.3 + 0.7 * smoothstep(0.0, 0.3, min(min(d1, d2), d3)), 0.0, 1.0);
    }

    mat3 setCamera(vec3 ro, vec3 ta, float cr) {
      vec3 cw = normalize(ta - ro);
      vec3 cp = vec3(sin(cr), cos(cr), 0.0);
      vec3 cu = normalize(cross(cw, cp));
      vec3 cv = normalize(cross(cu, cw));
      return mat3(cu, cv, cw);
    }

    void main() {
      vec2 fragCoord = vUv * uResolution;
      vec2 uv = (2.0 * fragCoord - uResolution) / uResolution.y;
      vec3 ro = uCameraPos;
      vec3 ta = uCameraTarget;
      mat3 ca = setCamera(ro, ta, 0.0);
      vec3 rd = ca * normalize(vec3(uv, 1.8));
      float t = 0.0;
      float d;
      vec3 p;
      bool hit = false;
      for (int i = 0; i < MARCH_STEPS; i++) {
        p = ro + rd * t;
        d = sceneSDF(p);
        if (d < 0.002) { hit = true; break; }
        t += d * 0.9;
        if (t > 15.0) break;
      }
      vec3 col = vec3(0.02, 0.02, 0.04);
      col += vec3(0.03, 0.01, 0.06) * (1.0 - uv.y * 0.5);
      if (hit) {
        vec3 nor = calcNormal(p);
        vec3 viewDir = normalize(ro - p);
        vec3 lightPos1 = vec3(3.0, 4.0, 5.0);
        vec3 lightPos2 = vec3(-4.0, 2.0, -3.0);
        vec3 lightDir1 = normalize(lightPos1 - p);
        vec3 lightDir2 = normalize(lightPos2 - p);
        float diff1 = max(dot(nor, lightDir1), 0.0);
        float diff2 = max(dot(nor, lightDir2), 0.0);
        vec3 halfDir1 = normalize(lightDir1 + viewDir);
        vec3 halfDir2 = normalize(lightDir2 + viewDir);
        float spec1 = pow(max(dot(nor, halfDir1), 0.0), 64.0);
        float spec2 = pow(max(dot(nor, halfDir2), 0.0), 32.0);
        float sha1 = cheapShadow(p + nor * 0.01, lightDir1);
        float sha2 = cheapShadow(p + nor * 0.01, lightDir2);
        float ao = calcAO(p, nor);
        float fres = fresnel(viewDir, nor, 3.0);
        float sss = max(0.0, dot(viewDir, -lightDir1)) * 0.3;
        vec3 baseColor1 = vec3(0.8, 0.15, 0.3);
        vec3 baseColor2 = vec3(0.15, 0.4, 0.9);
        vec3 baseColor3 = vec3(0.95, 0.5, 0.1);
        float colorMix = sin(p.x * 1.5 + uTime * 0.5) * 0.5 + 0.5;
        float colorMix2 = cos(p.y * 2.0 - uTime * 0.3) * 0.5 + 0.5;
        vec3 baseColor = mix(baseColor1, baseColor2, colorMix);
        baseColor = mix(baseColor, baseColor3, colorMix2 * 0.3);
        vec3 diffuse = baseColor * (diff1 * sha1 * vec3(1.0, 0.95, 0.9) * 0.8 + diff2 * sha2 * vec3(0.4, 0.5, 0.9) * 0.4);
        vec3 specular = vec3(1.0, 0.95, 0.9) * spec1 * sha1 * 0.7 + vec3(0.5, 0.6, 1.0) * spec2 * sha2 * 0.3;
        vec3 ambient = baseColor * vec3(0.08, 0.06, 0.12) * ao;
        vec3 rim = mix(vec3(0.4, 0.6, 1.0), vec3(1.0, 0.4, 0.6), colorMix) * fres * 0.6;
        vec3 subsurface = baseColor * sss * vec3(1.0, 0.3, 0.2);
        col = ambient + diffuse + specular + rim + subsurface;
        float iridescence = fres * 0.4;
        vec3 iriColor = vec3(
          sin(dot(nor, vec3(1.0, 0.0, 0.0)) * 6.0 + uTime) * 0.5 + 0.5,
          sin(dot(nor, vec3(0.0, 1.0, 0.0)) * 6.0 + uTime * 1.3) * 0.5 + 0.5,
          sin(dot(nor, vec3(0.0, 0.0, 1.0)) * 6.0 + uTime * 0.7) * 0.5 + 0.5
        );
        col += iriColor * iridescence;
        vec3 ref = reflect(-viewDir, nor);
        float envRefl = smoothstep(-0.2, 1.0, ref.y) * 0.15;
        col += vec3(0.3, 0.4, 0.8) * envRefl * fres;
      }
      col = col / (col + vec3(1.0));
      col = pow(col, vec3(1.0 / 2.2));
      float vig = 1.0 - 0.3 * dot(uv * 0.5, uv * 0.5);
      col *= vig;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
  depthWrite: false,
  depthTest: false
});

const quad = new THREE.Mesh(quadGeometry, quadMaterial);
quad.name = 'raymarchQuad';
quad.frustumCulled = false;

const quadScene = new THREE.Scene();
const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
quadScene.add(quad);

// ============ DOT MATRIX SHADER ============
const DotMatrixShader = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(size.width, size.height) },
    uDotSize: { value: 5.0 },
    uDotGap: { value: 2.5 },
    uBrightness: { value: 0.85 },
    uContrast: { value: 0.60 },
    uThreshold: { value: 0.03 },
    uDotColor: { value: new THREE.Vector3(1.0, 1.0, 1.0) },
    uBgColor: { value: new THREE.Vector3(0.00784, 0.00784, 0.01176) },
    uCrossEnabled: { value: 0.0 },
    uCrossIntensity: { value: 0.95 },
    uCrossAngle: { value: 0.4363 },
    uBloomEnabled: { value: 1.0 },
    uBloomIntensity: { value: 0.55 },
    uBloomSize: { value: 1.50 },
    uCrtEnabled: { value: 1.0 },
    uCrtCurvature: { value: 0.0 },
    uCrtScanlines: { value: 0.75 },
    uCrtVignette: { value: 2.00 },
    uCrtChroma: { value: 0.0 },
    uDitherEnabled: { value: 1.0 },
    uTime: { value: 0 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uDotSize;
    uniform float uDotGap;
    uniform float uBrightness;
    uniform float uContrast;
    uniform float uThreshold;
    uniform vec3 uDotColor;
    uniform vec3 uBgColor;
    uniform float uCrossEnabled;
    uniform float uCrossIntensity;
    uniform float uCrossAngle;
    uniform float uBloomEnabled;
    uniform float uBloomIntensity;
    uniform float uBloomSize;
    uniform float uCrtEnabled;
    uniform float uCrtCurvature;
    uniform float uCrtScanlines;
    uniform float uCrtVignette;
    uniform float uCrtChroma;
    uniform float uDitherEnabled;
    uniform float uTime;
    varying vec2 vUv;

    vec2 crtDistort(vec2 uv, float k) {
      vec2 cc = uv - 0.5;
      float r2 = dot(cc, cc);
      float f = 1.0 + r2 * k * 0.01;
      return cc * f + 0.5;
    }

    void main() {
      vec2 uv = vUv;
      if (uCrtEnabled > 0.5) {
        uv = crtDistort(uv, uCrtCurvature);
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
          gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
          return;
        }
      }
      vec3 col;
      if (uCrtEnabled > 0.5 && uCrtChroma > 0.01) {
        vec2 dir = (uv - 0.5) * uCrtChroma * 0.002;
        col.r = texture2D(tDiffuse, uv + dir).r;
        col.g = texture2D(tDiffuse, uv).g;
        col.b = texture2D(tDiffuse, uv - dir).b;
      } else {
        col = texture2D(tDiffuse, uv).rgb;
      }
      if (uDitherEnabled < 0.5) {
        if (uCrtEnabled > 0.5 && uCrtScanlines > 0.001) {
          float scanline = sin(uv.y * uResolution.y * 0.8) * 0.5 + 0.5;
          col *= 1.0 - uCrtScanlines * (1.0 - scanline);
        }
        if (uCrtEnabled > 0.5 && uCrtVignette > 0.001) {
          vec2 vig = uv * (1.0 - uv);
          float vigMask = pow(vig.x * vig.y * 16.0, uCrtVignette * 0.3);
          col *= vigMask;
        }
        gl_FragColor = vec4(col, 1.0);
        return;
      }
      vec2 pixelCoord = uv * uResolution;
      float spacing = uDotSize + uDotGap;
      vec2 cell = floor(pixelCoord / spacing);
      vec2 cellCenter = (cell + 0.5) * spacing;
      vec2 sampleUV = cellCenter / uResolution;
      vec3 cellCol;
      if (uCrtEnabled > 0.5 && uCrtChroma > 0.01) {
        vec2 dir = (sampleUV - 0.5) * uCrtChroma * 0.002;
        cellCol.r = texture2D(tDiffuse, sampleUV + dir).r;
        cellCol.g = texture2D(tDiffuse, sampleUV).g;
        cellCol.b = texture2D(tDiffuse, sampleUV - dir).b;
      } else {
        cellCol = texture2D(tDiffuse, sampleUV).rgb;
      }
      float lum = dot(cellCol, vec3(0.299, 0.587, 0.114));
      lum *= uBrightness;
      lum = (lum - 0.5) * (1.0 / uContrast) + 0.5;
      lum = clamp(lum, 0.0, 1.0);
      vec3 bgColor = uBgColor;
      if (lum < uThreshold) {
        vec3 result = bgColor;
        if (uCrtEnabled > 0.5 && uCrtScanlines > 0.001) {
          float scanline = sin(uv.y * uResolution.y * 0.8) * 0.5 + 0.5;
          result *= 1.0 - uCrtScanlines * (1.0 - scanline) * 0.3;
        }
        if (uCrtEnabled > 0.5 && uCrtVignette > 0.001) {
          vec2 vig = uv * (1.0 - uv);
          float vigMask = pow(vig.x * vig.y * 16.0, uCrtVignette * 0.3);
          result *= vigMask;
        }
        gl_FragColor = vec4(result, 1.0);
        return;
      }
      float maxRadius = uDotSize * 0.5;
      float minRadius = 0.4;
      float lumCurve = pow(lum, uContrast);
      float dotRadius = mix(minRadius, maxRadius, lumCurve);
      vec2 d = pixelCoord - cellCenter;
      vec2 absD = abs(d);
      float cornerRadius = mix(0.8, 0.2, lumCurve);
      float squareness = smoothstep(0.15, 0.7, lumCurve);
      float circleDist = length(d);
      float circleEdge = 1.0 - smoothstep(dotRadius - 0.5, dotRadius + 0.5, circleDist);
      vec2 qd = absD - vec2(dotRadius - cornerRadius);
      float rsDist = length(max(qd, 0.0)) + min(max(qd.x, qd.y), 0.0) - cornerRadius;
      float squareEdge = 1.0 - smoothstep(-0.5, 0.5, rsDist);
      float dotMask = mix(circleEdge, squareEdge, squareness);
      vec3 brightColor = uDotColor;
      vec3 midColor = uDotColor * 0.7;
      vec3 dimColor = uDotColor * 0.25;
      vec3 colNorm = cellCol / (max(max(cellCol.r, cellCol.g), cellCol.b) + 0.001);
      vec3 dotColor;
      if (lum > 0.65) {
        dotColor = mix(brightColor, brightColor * colNorm * 1.5, 0.2);
        dotColor *= 1.0 + (lum - 0.65) * 1.5;
      } else if (lum > 0.25) {
        float mt = (lum - 0.25) / 0.4;
        dotColor = mix(midColor, brightColor, mt);
        dotColor = mix(dotColor, dotColor * colNorm * 1.2, 0.15);
      } else {
        float st = lum / 0.25;
        dotColor = mix(dimColor * 0.5, dimColor, st);
      }
      float shadowCrosshatch = 0.0;
      if (uCrossEnabled > 0.5 && lum < 0.35) {
        float crossSpacing = spacing * 0.7;
        float ca = cos(uCrossAngle);
        float sa = sin(uCrossAngle);
        vec2 rotP = vec2(ca * pixelCoord.x - sa * pixelCoord.y, sa * pixelCoord.x + ca * pixelCoord.y);
        vec2 crossCell = floor(rotP / crossSpacing);
        vec2 crossCenter = (crossCell + 0.5) * crossSpacing;
        float crossDist = length(rotP - crossCenter);
        float shadowIntensity = smoothstep(0.35, 0.05, lum);
        float crossRadius = mix(0.3, maxRadius * 0.35, shadowIntensity);
        shadowCrosshatch = 1.0 - smoothstep(crossRadius - 0.4, crossRadius + 0.4, crossDist);
        shadowCrosshatch *= shadowIntensity * uCrossIntensity;
      }
      float bloomMask = 0.0;
      if (uBloomEnabled > 0.5 && lum > 0.6) {
        float bloomRadius = dotRadius * uBloomSize;
        float bloomDist = length(d);
        bloomMask = (1.0 - smoothstep(bloomRadius - 1.0, bloomRadius + 1.0, bloomDist));
        bloomMask *= smoothstep(0.6, 1.0, lum) * uBloomIntensity * 0.5;
      }
      vec3 result = bgColor;
      vec3 crossColor = dimColor * 0.4;
      result = mix(result, crossColor, shadowCrosshatch);
      result += brightColor * bloomMask;
      result = mix(result, dotColor, dotMask);
      float innerMask = 0.0;
      if (squareness > 0.5) {
        vec2 qd2 = absD - vec2(dotRadius * 0.85 - cornerRadius);
        float rsDist2 = length(max(qd2, 0.0)) + min(max(qd2.x, qd2.y), 0.0) - cornerRadius;
        innerMask = 1.0 - smoothstep(-0.5, 0.5, rsDist2);
      } else {
        innerMask = 1.0 - smoothstep(dotRadius * 0.7 - 0.5, dotRadius * 0.7 + 0.5, circleDist);
      }
      float phosphorEdge = max(dotMask - innerMask, 0.0);
      result += brightColor * phosphorEdge * 0.15 * lum;
      if (uCrtEnabled > 0.5 && uCrtScanlines > 0.001) {
        float scanline = sin(uv.y * uResolution.y * 0.8) * 0.5 + 0.5;
        result *= 1.0 - uCrtScanlines * (1.0 - scanline);
      }
      if (uCrtEnabled > 0.5 && uCrtVignette > 0.001) {
        vec2 vig = uv * (1.0 - uv);
        float vigMask = pow(vig.x * vig.y * 16.0, uCrtVignette * 0.3);
        result *= vigMask;
      }
      if (uCrtEnabled > 0.5) {
        result = result;
      }
      gl_FragColor = vec4(result, 1.0);
    }
  `
};

// ============ POST PROCESSING ============
// Use a standard RenderPass for the quad scene — the raymarching resolution
// is controlled by uResolution on the quad material (set to half-res),
// while the composer and dot-matrix shader run at full native resolution.
const composer = new EffectComposer(renderer);
composer.setSize(size.width, size.height);

const renderPass = new RenderPass(quadScene, quadCamera);
composer.addPass(renderPass);

const dotMatrixPass = new ShaderPass(DotMatrixShader);
composer.addPass(dotMatrixPass);
const outputPass = new OutputPass();
composer.addPass(outputPass);

// Dot matrix runs at full resolution for crisp patterns
dotMatrixPass.uniforms.uResolution.value.set(size.width, size.height);

// ============ SCROLL PARALLAX ============
let scrollY = 0;
let smoothScrollY = 0;

window.addEventListener('scroll', () => {
  scrollY = window.scrollY;
}, { passive: true });

// ============ ANIMATION LOOP ============
const clock = new THREE.Clock();
const raycaster = new THREE.Raycaster();
const _forward = new THREE.Vector3();
let resizeTimeout = null;

// ============ FPS WATCHDOG — auto-downgrade if <30fps ============
const tierOrder = ['high', 'mid', 'low'];
let fpsFrames = 0;
let fpsStartTime = performance.now();
let fpsWatchdogActive = true;
const FPS_SAMPLE_WINDOW = 2000; // 2 seconds
const FPS_THRESHOLD = 30;

function downgradeQuality() {
  const currentIndex = tierOrder.indexOf(currentTier);
  if (currentIndex >= tierOrder.length - 1) {
    // Already at lowest tier
    fpsWatchdogActive = false;
    return;
  }
  const nextTier = tierOrder[currentIndex + 1];
  currentTier = nextTier;
  quality = { ...qualityPresets[currentTier] };

  // Apply new quality — update pixel ratio
  const pr = Math.min(window.devicePixelRatio, quality.pixelRatio);
  renderer.setPixelRatio(pr);
  renderer.setSize(size.width, size.height);
  composer.setSize(size.width, size.height);

  // Update dot matrix uniforms
  dotMatrixPass.uniforms.uDotSize.value = quality.dotSize;
  dotMatrixPass.uniforms.uDotGap.value = quality.dotGap;
  dotMatrixPass.uniforms.uCrtScanlines.value = quality.scanlines;
  dotMatrixPass.uniforms.uBloomEnabled.value = quality.bloomEnabled ? 1.0 : 0.0;

  // Reset watchdog for another sample window
  fpsFrames = 0;
  fpsStartTime = performance.now();

  // If we hit the lowest tier, stop watching
  if (currentIndex + 1 >= tierOrder.length - 1) {
    fpsWatchdogActive = false;
  }

  // Update tier display
  const tierEl = document.getElementById('settings-tier');
  if (tierEl) tierEl.textContent = `GPU Tier: ${currentTier} (auto)`;
}

function animate() {
  // Skip rendering when the tab is hidden or the hero has scrolled off screen (see heroOnScreen).
  if (!pageVisible || !heroOnScreen) return;

  const dt = Math.min(clock.getDelta(), 0.05); // Clamp delta to avoid huge jumps
  const elapsed = clock.elapsedTime;
  controls.update();

  const targetR = mouseInScene ? (mousePressed ? mouseSphereClickRadius : mouseSphereTargetRadius) : 0.0;
  const fadeSpeed = mouseInScene ? (mousePressed ? 10.0 : 6.0) : 3.0;
  const step = Math.min(1.0, fadeSpeed * dt);
  mouseSphereRadius += (targetR - mouseSphereRadius) * step;
  if (mouseSphereRadius < 0.005 && !mouseInScene) mouseSphereRadius = 0.0;

  raycaster.setFromCamera(mouse, camera);
  const rayDir = raycaster.ray.direction;
  const rayOrigin = raycaster.ray.origin;
  _forward.subVectors(controls.target, camera.position).normalize();
  const dist = camera.position.distanceTo(controls.target);
  const t = dist / rayDir.dot(_forward);
  mouseWorldTarget.copy(rayOrigin).addScaledVector(rayDir, t);
  mouseWorld.lerp(mouseWorldTarget, mouseDamping);

  // Smooth scroll interpolation for parallax
  smoothScrollY += (scrollY - smoothScrollY) * 0.1;
  const vh = window.innerHeight;
  const scrollProgress = Math.min(smoothScrollY / vh, 1.0);

  // Parallax: shift camera subtly as user scrolls (3D depth effect)
  const baseZ = 5;
  const baseCamY = 0;
  camera.position.y = baseCamY + scrollProgress * 1.5;
  camera.position.z = baseZ + scrollProgress * 0.8;
  controls.target.y = scrollProgress * 0.8;

  quadMaterial.uniforms.uMouseSpherePos.value.copy(mouseWorld);
  quadMaterial.uniforms.uMouseSphereRadius.value = mouseSphereRadius;
  quadMaterial.uniforms.uTime.value = elapsed;
  quadMaterial.uniforms.uCameraPos.value.copy(camera.position);
  quadMaterial.uniforms.uCameraTarget.value.copy(controls.target);
  dotMatrixPass.uniforms.uTime.value = elapsed;

  // Composer renders the quad scene via RenderPass, then applies dot matrix + CRT
  composer.render();

  // FPS watchdog — sample for 2s windows, downgrade if below threshold
  if (fpsWatchdogActive) {
    fpsFrames++;
    const elapsed_ms = performance.now() - fpsStartTime;
    if (elapsed_ms >= FPS_SAMPLE_WINDOW) {
      const avgFps = (fpsFrames / elapsed_ms) * 1000;
      if (avgFps < FPS_THRESHOLD) {
        downgradeQuality();
      } else {
        // Performance is fine, stop watching
        fpsWatchdogActive = false;
      }
    }
  }
}

renderer.setAnimationLoop(animate);

// ============ RESIZE (debounced — render loop never pauses) ============
function handleResize() {
  size = getSize();
  camera.aspect = size.width / size.height;
  camera.updateProjectionMatrix();

  const pr = Math.min(window.devicePixelRatio, quality.pixelRatio);
  renderer.setPixelRatio(pr);
  renderer.setSize(size.width, size.height);

  quadMaterial.uniforms.uResolution.value.set(size.width, size.height);
  quadMaterial.uniforms.uPixelRatio.value = pr;
  dotMatrixPass.uniforms.uResolution.value.set(size.width, size.height);

  composer.setSize(size.width, size.height);
}

window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  // Immediately update the canvas CSS size so it fills the window (no black gaps)
  // but defer the expensive framebuffer reallocation
  renderer.domElement.style.width = window.innerWidth + 'px';
  renderer.domElement.style.height = window.innerHeight + 'px';
  resizeTimeout = setTimeout(handleResize, 200);
}, { passive: true });

// ============ DEFERRED INIT — pre-warm the shader after first paint ============
// Force one render so the first real frame doesn't stutter on shader compile.
if ('requestIdleCallback' in window) {
  requestIdleCallback(() => composer.render(), { timeout: 1000 });
} else {
  setTimeout(() => composer.render(), 200); // Safari fallback
}