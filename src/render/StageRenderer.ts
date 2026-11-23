import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { AudioReactiveMetrics } from '../audio/AudioEngine';
import type {
  AirString,
  CameraFilterMode,
  HandVisualMode,
  LoopRenderSnapshot,
  ParticleShape,
  PreviewString,
  ResonancePair,
  ShockwaveShape,
  ThemeId,
  TrackedFace,
  TrackedHand,
  TrackedPose,
  Vec2,
} from '../types';
import type { SegmentationFrame } from '../vision/HandTracker';
import { samplePitchColor, THEMES, type ThemeConfig } from './themes';
import { drawXrayBodySkeleton, drawXrayHandSkeleton, type XrayDrawSink } from './xraySkeleton';
import { XraySkullRig } from './XraySkullRig';

const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const PARTICLE_SHAPE_INDEX: Record<ParticleShape, number> = {
  spark: 0,
  petal: 1,
  bubble: 2,
  star: 3,
  pixel: 4,
};

interface Spark {
  alive: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  g: number;
  b: number;
  life: number;
  maxLife: number;
  size: number;
  seed: number;
}

interface Shockwave {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  r: number;
  g: number;
  b: number;
  life: number;
  maxLife: number;
  shape: ShockwaveShape;
  rotSpeed: number;
  angle: number;
}

interface TrailNode {
  x: number;
  y: number;
  age: number;
}

const MAX_QUADS = 20_000;
const MAX_VERTS = MAX_QUADS * 6;
const MAX_SPARKS = 1600;
const MAX_TRAIL_NODES = 16;
const MAX_LABEL_SPRITES = 20;

const BG_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const BG_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;

  uniform sampler2D uVideo;
  uniform sampler2D uSegMask;
  uniform sampler2D uCustomBg;
  uniform sampler2D uMatrixAtlas;
  uniform float uHasVideo;
  uniform float uHasSegMask;
  uniform float uHasPose;
  uniform float uHasCustomBg;
  uniform float uCustomBgAspect;
  uniform float uMirror;
  uniform float uVideoAspect;
  uniform float uScreenAspect;
  uniform int uMode; // 0: cinema, 1: portrait, 2: cyber, 3: clean (pure natural), 4: xray
  uniform int uBgStyle; // 0: plasma, 1: ink, 2: abyss, 3: celestial, 4: synthwave
  uniform float uTime;
  uniform float uAudioRms;
  uniform vec2 uResolution;
  uniform vec3 uDarkTint;
  uniform vec3 uStarColor;
  uniform vec3 uRimColor;
  uniform vec3 uCyberColor;

  float hash21(vec2 p) {
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
      v += amp * valueNoise(p);
      p = p * 2.03 + vec2(17.1, 31.7);
      amp *= 0.5;
    }
    return v;
  }

  vec3 renderStars(vec2 uv, float t, float energy) {
    vec3 acc = vec3(0.0);
    for (int layer = 0; layer < 2; layer++) {
      float scale = layer == 0 ? 46.0 : 86.0;
      vec2 drift = vec2(t * (layer == 0 ? 0.010 : 0.004), -t * (layer == 0 ? 0.005 : 0.009));
      vec2 gv = fract((uv + drift) * scale) - 0.5;
      vec2 id = floor((uv + drift) * scale);
      float n = hash21(id + float(layer) * 19.7);
      if (n > 0.945) {
        vec2 offset = vec2(hash21(id + 3.1) - 0.5, hash21(id + 7.7) - 0.5) * 0.65;
        float d = length(gv - offset);
        float twinkle = 0.6 + 0.4 * sin(t * (2.0 + n * 5.0) + n * 62.0);
        float star = smoothstep(0.11, 0.01, d) * twinkle * (0.7 + energy * 0.9);
        acc += mix(vec3(1.0), uStarColor, 0.45) * star * (layer == 0 ? 0.9 : 0.55);
      }
    }
    return acc;
  }

  // 0: SYS.PLASMA - cyber horizon grid + sweeping radar laser + pinpoint stars
  vec3 renderPlasmaBg(vec2 uv, float t, float energy) {
    vec2 centered = uv - 0.5;
    float radial = length(centered);
    vec3 col = mix(uDarkTint * 1.5, uDarkTint * 0.25, clamp(radial * 1.45, 0.0, 1.0));

    // Crisp HUD micro-grid
    vec2 gridUv = uv * vec2(22.0, 12.0);
    vec2 g = abs(fract(gridUv - 0.5) - 0.5);
    float line = 1.0 - smoothstep(0.010, 0.028, min(g.x, g.y));
    col += uStarColor * line * (0.045 + 0.06 * energy) * smoothstep(0.95, 0.16, radial);

    // Sweeping horizontal cyber scan beam
    float scanY = fract(t * 0.11);
    float beam = exp(-abs(uv.y - scanY) * 34.0);
    col += uStarColor * beam * (0.07 + energy * 0.09);

    // Subtle CRT scanlines
    col *= 0.96 + 0.04 * sin(uv.y * uResolution.y * 0.75);
    col += renderStars(uv, t, energy) * 0.65;
    return col;
  }

  // 1: ART.INK - dark rice paper grain + flowing Chinese ink-wash mountain mist + gold mineral flecks
  vec3 renderInkBg(vec2 uv, float t, float energy) {
    vec3 paperBase = vec3(0.062, 0.054, 0.045);
    float grain = (hash21(floor(uv * uResolution * 0.5)) - 0.5) * 0.025;
    vec3 col = paperBase + grain;

    // Flowing layered ink-wash mist
    float mist1 = fbm(uv * vec2(3.2, 2.4) + vec2(t * 0.035, -t * 0.012));
    float mist2 = fbm(uv * vec2(5.4, 3.8) + vec2(-t * 0.022, t * 0.018));
    float cloud = smoothstep(0.32, 0.78, mist1 * 0.65 + mist2 * 0.35);

    // Mountain silhouette wash along lower horizon
    float ridge1 = 0.24 + 0.09 * sin(uv.x * 4.2 + 0.6) + 0.045 * sin(uv.x * 11.0 - 1.2);
    float ridge2 = 0.16 + 0.07 * sin(uv.x * 5.8 - 1.7) + 0.03 * cos(uv.x * 14.0);
    float mtn1 = smoothstep(ridge1 + 0.06, ridge1 - 0.02, uv.y);
    float mtn2 = smoothstep(ridge2 + 0.04, ridge2 - 0.01, uv.y);

    col = mix(col, vec3(0.11, 0.13, 0.14), cloud * (0.42 + energy * 0.25));
    col = mix(col, vec3(0.035, 0.048, 0.058), mtn1 * 0.55);
    col = mix(col, vec3(0.022, 0.024, 0.026), mtn2 * 0.72);

    // Warm golden moon halo & sparse floating gold-leaf dust flecks
    float moon = exp(-length((uv - vec2(0.76, 0.76)) * vec2(uScreenAspect, 1.0)) * 4.2);
    col += vec3(0.95, 0.76, 0.42) * moon * (0.14 + energy * 0.12);

    vec2 fleckUv = (uv + vec2(t * 0.008, -t * 0.004)) * 54.0;
    vec2 fid = floor(fleckUv);
    float fn = hash21(fid + 9.3);
    if (fn > 0.968) {
      float fd = length(fract(fleckUv) - 0.5);
      float glint = smoothstep(0.16, 0.02, fd) * (0.5 + 0.5 * sin(t * 3.0 + fn * 40.0));
      col += vec3(1.0, 0.80, 0.38) * glint * (0.45 + energy * 0.5);
    }
    return col;
  }

  // 2: BIO.ABYSS - deep ocean twilight + live shimmering underwater optical caustics
  vec3 renderAbyssBg(vec2 uv, float t, float energy) {
    // Deep ocean depth gradient (darker floor, luminous surface shimmer)
    vec3 deepCol = vec3(0.008, 0.026, 0.056);
    vec3 midCol = vec3(0.014, 0.072, 0.115);
    vec3 col = mix(deepCol, midCol, smoothstep(0.0, 1.0, uv.y));

    // Procedural underwater caustics via layered wave interference
    vec2 p = uv * vec2(6.5 * uScreenAspect, 6.5);
    float c1 = sin(p.x * 1.4 + t * 0.65 + sin(p.y * 1.7 - t * 0.45));
    float c2 = sin(p.y * 1.5 - t * 0.55 + cos(p.x * 1.6 + t * 0.5));
    float c3 = sin((p.x + p.y) * 1.15 + t * 0.4 + sin((p.x - p.y) * 1.3 - t * 0.6));
    float caust = pow(clamp(1.0 - abs(c1 + c2 + c3) * 0.34, 0.0, 1.0), 4.0);
    float depthFade = 0.35 + 0.65 * smoothstep(0.05, 0.95, uv.y);

    col += vec3(0.08, 0.88, 0.86) * caust * depthFade * (0.20 + energy * 0.24);
    col += vec3(0.18, 0.48, 1.0) * fbm(uv * 4.0 + vec2(0.0, -t * 0.08)) * 0.09;

    // Gentle rising bioluminescent plankton motes
    vec2 muv = (uv + vec2(sin(uv.y * 5.0 + t * 0.4) * 0.01, -t * 0.032)) * 42.0;
    vec2 mid = floor(muv);
    float mn = hash21(mid + 4.1);
    if (mn > 0.958) {
      float md = length(fract(muv) - 0.5);
      float glow = smoothstep(0.18, 0.02, md) * (0.55 + 0.45 * sin(t * 2.5 + mn * 50.0));
      col += vec3(0.24, 1.0, 0.88) * glow * (0.45 + energy * 0.55);
    }
    return col;
  }

  // 3: AST.SIGIL - arctic midnight sky + undulating northern lights aurora curtains
  vec3 renderCelestialBg(vec2 uv, float t, float energy) {
    vec3 col = mix(vec3(0.014, 0.022, 0.062), vec3(0.028, 0.042, 0.115), uv.y);

    // Undulating vertical Aurora Curtain ribbons in upper 65%
    float wave1 = sin(uv.x * 5.2 + t * 0.32) * 0.12 + sin(uv.x * 11.4 - t * 0.48) * 0.05;
    float curtainY = uv.y - (0.56 + wave1);
    float verticalRibbon = exp(-abs(curtainY) * 5.2) * smoothstep(0.18, 0.72, uv.y);
    float streaks = 0.55 + 0.45 * sin(uv.x * 38.0 + fbm(vec2(uv.x * 4.0, t * 0.22)) * 8.0);

    vec3 auroraCol = mix(
      vec3(0.12, 0.98, 0.74),
      vec3(0.62, 0.32, 1.0),
      smoothstep(0.45, 0.92, uv.y + wave1 * 0.8)
    );
    col += auroraCol * verticalRibbon * streaks * (0.28 + energy * 0.32);

    // Secondary rose-violet aurora fold
    float wave2 = cos(uv.x * 4.1 - t * 0.26) * 0.10;
    float fold = exp(-abs(uv.y - (0.70 + wave2)) * 6.5);
    col += vec3(0.88, 0.38, 0.86) * fold * (0.12 + energy * 0.14);

    col += renderStars(uv, t, energy) * 1.15;
    return col;
  }

  // 4: VHS.1984 - iconic 80s Outrun striped neon sun + scrolling 3D perspective retro grid + CRT scanlines
  vec3 renderSynthwaveBg(vec2 uv, float t, float energy) {
    float horizon = 0.46;
    vec3 col = vec3(0.0);

    if (uv.y >= horizon) {
      // Twilight purple-magenta synthwave sky
      float skyT = (uv.y - horizon) / (1.0 - horizon);
      col = mix(vec3(0.24, 0.04, 0.26), vec3(0.03, 0.015, 0.095), pow(skyT, 0.65));

      // Outrun striped retro sun disk centered above horizon
      vec2 sunPos = vec2(0.5, horizon + 0.15);
      vec2 d = (uv - sunPos) * vec2(uScreenAspect, 1.0);
      float dist = length(d);
      float sunR = 0.175 + energy * 0.014;
      float sunMask = smoothstep(sunR + 0.008, sunR - 0.004, dist);

      // Horizontal retro cutout stripes on lower half of sun
      float stripePhase = (uv.y - horizon) * 44.0 - t * 0.35;
      float stripeCut = uv.y < sunPos.y + 0.03
        ? smoothstep(0.20, 0.36, fract(stripePhase))
        : 1.0;

      vec3 sunCol = mix(vec3(1.0, 0.18, 0.56), vec3(1.0, 0.84, 0.22), clamp((uv.y - horizon) * 3.1, 0.0, 1.0));
      col += sunCol * sunMask * stripeCut * 0.82;
      // Soft atmospheric sun halo
      col += vec3(1.0, 0.22, 0.62) * exp(-dist * 4.5) * (0.28 + energy * 0.24);
      col += renderStars(uv, t, energy) * skyT * 0.85;
    } else {
      // Scrolling 3D perspective retro laser floor
      float depth = max(0.018, horizon - uv.y);
      float z = 0.32 / depth;
      float x = (uv.x - 0.5) * uScreenAspect * z;

      float gx = abs(fract(x * 0.55 - 0.5) - 0.5);
      float gz = abs(fract(z * 0.65 - t * 1.15) - 0.5);
      float lineX = 1.0 - smoothstep(0.014, 0.048, gx);
      float lineZ = 1.0 - smoothstep(0.014, 0.052, gz);
      float grid = max(lineX, lineZ);

      float fog = smoothstep(0.0, 0.16, depth);
      col = mix(vec3(0.22, 0.03, 0.24), vec3(0.035, 0.01, 0.075), fog);
      vec3 gridCol = mix(vec3(1.0, 0.18, 0.68), vec3(0.14, 0.90, 1.0), clamp(depth * 2.2, 0.0, 1.0));
      col += gridCol * grid * fog * (0.42 + energy * 0.35);
    }

    // Horizon neon glow seam + VHS scanlines
    float seam = exp(-abs(uv.y - horizon) * 48.0);
    col += vec3(1.0, 0.26, 0.72) * seam * (0.48 + energy * 0.35);
    col *= 0.94 + 0.06 * sin(uv.y * uResolution.y * 0.9);
    return col;
  }

  vec3 renderThemeStage(vec2 uv, float t, float energy) {
    if (uBgStyle == 1) return renderInkBg(uv, t, energy);
    if (uBgStyle == 2) return renderAbyssBg(uv, t, energy);
    if (uBgStyle == 3) return renderCelestialBg(uv, t, energy);
    if (uBgStyle == 4) return renderSynthwaveBg(uv, t, energy);
    return renderPlasmaBg(uv, t, energy);
  }

  vec2 coverUvForAspect(vec2 uv, float mediaAspect, float mirrorFlag) {
    vec2 outUv = uv;
    if (uScreenAspect > mediaAspect) {
      float scale = mediaAspect / uScreenAspect;
      outUv.y = (uv.y - 0.5) * scale + 0.5;
    } else {
      float scale = uScreenAspect / mediaAspect;
      outUv.x = (uv.x - 0.5) * scale + 0.5;
    }
    if (mirrorFlag > 0.5) {
      outUv.x = 1.0 - outUv.x;
    }
    return outUv;
  }

  vec3 xrayRamp(float d) {
    vec3 c0 = vec3(0.008, 0.022, 0.050);
    vec3 c1 = vec3(0.060, 0.340, 0.600);
    vec3 c2 = vec3(0.360, 0.850, 0.990);
    vec3 c3 = vec3(0.960, 0.995, 1.000);
    vec3 col = mix(c0, c1, smoothstep(0.00, 0.34, d));
    col = mix(col, c2, smoothstep(0.30, 0.72, d));
    col = mix(col, c3, smoothstep(0.66, 1.00, d));
    return col;
  }

  vec3 renderMatrixLayer(vec2 uv, float cols, float speedScale, float seed, float t, float energy) {
    float rowY = 1.0 - uv.y;
    vec2 grid = vec2(cols, cols / max(uScreenAspect, 0.45) * 0.84);
    vec2 cell = floor(vec2(uv.x, rowY) * grid);
    vec2 cellUv = fract(vec2(uv.x, rowY) * grid);

    float col = cell.x;
    float spd = (0.20 + hash21(vec2(col, seed + 1.3)) * 0.44) * speedScale * (1.0 + energy * 0.32);
    float phase = hash21(vec2(col, seed + 5.7));
    float cycle = 1.35 + hash21(vec2(col, seed + 9.1)) * 0.95;
    float trailLen = 0.28 + hash21(vec2(col, seed + 13.7)) * 0.56;

    float headY = mod(t * spd + phase * cycle, cycle);
    float distBehind = mod(headY - (cell.y / grid.y), cycle);
    float inStream = step(distBehind, trailLen);
    float trail = pow(clamp(1.0 - distBehind / trailLen, 0.0, 1.0), 2.05) * inStream;
    float isHead = (1.0 - smoothstep(0.0, 1.45 / grid.y, distBehind)) * inStream;

    // Periodic in-place character mutation + faster flicker on leading head glyph
    float flickRate = 1.8 + hash21(cell + seed * 3.1) * 4.5;
    float flickTick = floor(t * mix(flickRate, 14.0, isHead));
    float glyphId = floor(hash21(cell + vec2(flickTick * 0.37, seed * 11.3)) * 64.0);
    float gx = mod(glyphId, 8.0);
    float gy = floor(glyphId / 8.0);

    vec2 atlasUv = vec2(
      (gx + mix(0.07, 0.93, cellUv.x)) / 8.0,
      1.0 - (gy + mix(0.07, 0.93, cellUv.y)) / 8.0
    );
    float glyph = texture2D(uMatrixAtlas, atlasUv).r;

    vec3 trailCol = mix(vec3(0.00, 0.32, 0.10), vec3(0.06, 0.96, 0.32), smoothstep(0.12, 0.92, trail));
    vec3 headCol = vec3(0.78, 1.00, 0.84);
    vec3 colOut = mix(trailCol * trail, headCol * (0.95 + energy * 0.28), isHead);
    // Faint vertical phosphor glow behind active falling characters
    float halo = (trail * 0.10 + isHead * 0.22) * exp(-abs(cellUv.x - 0.5) * 4.2);
    return colOut * glyph + vec3(0.02, 0.45, 0.14) * halo;
  }

  vec3 renderMatrixRain(vec2 uv, float t, float energy) {
    vec3 farRain = renderMatrixLayer(uv + vec2(0.008, 0.0), 92.0, 0.55, 17.0, t, energy) * 0.38;
    vec3 nearRain = renderMatrixLayer(uv, 52.0, 1.00, 3.0, t, energy) * 0.98;
    float scan = 0.95 + 0.05 * sin(uv.y * uResolution.y * 0.9);
    return (vec3(0.001, 0.007, 0.003) + farRain + nearRain) * scan;
  }

  void main() {
    vec3 themeBg = renderThemeStage(vUv, uTime, uAudioRms);
    if (uHasCustomBg > 0.5) {
      vec2 bgUv = coverUvForAspect(vUv, uCustomBgAspect, 0.0);
      vec3 imgCol = texture2D(uCustomBg, bgUv).rgb;
      float vigBg = smoothstep(1.05, 0.25, length(vUv - 0.5) * 1.05);
      themeBg = imgCol * (0.72 + 0.20 * vigBg);
    }

    if (uHasVideo < 0.5) {
      if (uMode == 2) {
        vec3 rain = renderMatrixRain(vUv, uTime, uAudioRms);
        if (uHasCustomBg > 0.5) {
          float bgL = dot(themeBg, vec3(0.299, 0.587, 0.114));
          rain += vec3(0.02, 0.22, 0.07) * bgL * 0.55;
        }
        gl_FragColor = vec4(rain, 1.0);
        return;
      }
      gl_FragColor = vec4(themeBg, 1.0);
      return;
    }

    vec2 camUv = coverUvForAspect(vUv, uVideoAspect, uMirror);
    vec3 cam = texture2D(uVideo, camUv).rgb;

    // Mode 3: PURE NATURAL — zero dimming, zero vignette, zero grading!
    if (uMode == 3) {
      gl_FragColor = vec4(cam, 1.0);
      return;
    }

    float luma = dot(cam, vec3(0.299, 0.587, 0.114));
    float vig = smoothstep(0.92, 0.25, length(vUv - 0.5) * 1.15);
    vec3 outCol = cam;

    if (uMode == 0) {
      // Cinema dark moody filter with subtle theme atmosphere blend
      vec3 graded = mix(vec3(luma), cam, 0.72);
      graded = pow(max(graded, vec3(0.0)), vec3(1.18)) * 0.48;
      graded += themeBg * (0.45 + uAudioRms * 0.25);
      outCol = graded * (0.58 + 0.42 * vig);
    } else if (uMode == 1) {
      // Portrait World: isolate person into the active artistic theme world + luminous rim glow
      if (uHasSegMask > 0.5) {
        vec2 maskUv = vec2(camUv.x, 1.0 - camUv.y);
        float m = texture2D(uSegMask, maskUv).r;
        float person = smoothstep(0.32, 0.68, m);

        vec2 texel = 2.0 / max(uResolution, vec2(1.0));
        float mL = texture2D(uSegMask, maskUv - vec2(texel.x, 0.0)).r;
        float mR = texture2D(uSegMask, maskUv + vec2(texel.x, 0.0)).r;
        float mU = texture2D(uSegMask, maskUv + vec2(0.0, texel.y)).r;
        float mD = texture2D(uSegMask, maskUv - vec2(0.0, texel.y)).r;
        float rim = clamp(length(vec2(mR - mL, mU - mD)) * 2.8, 0.0, 1.0);

        vec3 personCol = pow(max(cam, vec3(0.0)), vec3(1.06)) * 0.72;
        personCol = mix(personCol, personCol + uRimColor * 0.14, 0.3);
        outCol = mix(themeBg, personCol, person);
        outCol += uRimColor * rim * (0.45 + uAudioRms * 0.65);
      } else {
        vec3 graded = cam * 0.40 * vig;
        outCol = mix(themeBg, graded, 0.52);
      }
    } else if (uMode == 2) {
      // The Matrix Digital Rain on pitch-black background + emerald code-wireframe silhouette
      vec3 matrixBg = renderMatrixRain(vUv, uTime, uAudioRms);

      vec2 stepUv = 1.5 / max(uResolution, vec2(1.0));
      float tl = dot(texture2D(uVideo, camUv + vec2(-stepUv.x, stepUv.y)).rgb, vec3(0.299, 0.587, 0.114));
      float tc = dot(texture2D(uVideo, camUv + vec2(0.0, stepUv.y)).rgb, vec3(0.299, 0.587, 0.114));
      float tr = dot(texture2D(uVideo, camUv + vec2(stepUv.x, stepUv.y)).rgb, vec3(0.299, 0.587, 0.114));
      float ml = dot(texture2D(uVideo, camUv + vec2(-stepUv.x, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
      float mr = dot(texture2D(uVideo, camUv + vec2(stepUv.x, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
      float bl = dot(texture2D(uVideo, camUv + vec2(-stepUv.x, -stepUv.y)).rgb, vec3(0.299, 0.587, 0.114));
      float bc = dot(texture2D(uVideo, camUv + vec2(0.0, -stepUv.y)).rgb, vec3(0.299, 0.587, 0.114));
      float br = dot(texture2D(uVideo, camUv + vec2(stepUv.x, -stepUv.y)).rgb, vec3(0.299, 0.587, 0.114));

      float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
      float gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
      float edge = smoothstep(0.12, 0.56, sqrt(gx * gx + gy * gy));

      if (uHasSegMask > 0.5) {
        vec2 maskUv = vec2(camUv.x, 1.0 - camUv.y);
        float m = texture2D(uSegMask, maskUv).r;
        float person = smoothstep(0.30, 0.70, m);

        vec2 texel = 2.2 / max(uResolution, vec2(1.0));
        float mL = texture2D(uSegMask, maskUv - vec2(texel.x, 0.0)).r;
        float mR = texture2D(uSegMask, maskUv + vec2(texel.x, 0.0)).r;
        float mU = texture2D(uSegMask, maskUv + vec2(0.0, texel.y)).r;
        float mD = texture2D(uSegMask, maskUv - vec2(0.0, texel.y)).r;
        float rim = clamp(length(vec2(mR - mL, mU - mD)) * 2.8, 0.0, 1.0);

        // Person emerges as glowing Matrix green code contours & dark emerald depth over pure black rain
        vec3 codeBody = vec3(0.008, 0.13, 0.042) * pow(luma, 0.9)
          + matrixBg * (0.45 + luma * 0.75)
          + vec3(0.14, 0.98, 0.38) * edge * (0.62 + uAudioRms * 0.30);
        outCol = mix(matrixBg, codeBody, person);
        outCol += vec3(0.28, 1.0, 0.52) * rim * (0.50 + uAudioRms * 0.35);
      } else {
        outCol = matrixBg * (0.78 + luma * 0.42) + vec3(0.12, 0.96, 0.36) * edge * (0.55 + uAudioRms * 0.32);
      }
      outCol *= (0.78 + 0.22 * vig);
    } else if (uMode == 4) {
      // X-Ray Radiograph: inverted tissue density + multi-scale bone/edge highlight + person isolation
      vec2 stepUv = 1.6 / max(uResolution, vec2(1.0));
      float tl = dot(texture2D(uVideo, camUv + vec2(-stepUv.x, stepUv.y)).rgb, vec3(0.299, 0.587, 0.114));
      float tc = dot(texture2D(uVideo, camUv + vec2(0.0, stepUv.y)).rgb, vec3(0.299, 0.587, 0.114));
      float tr = dot(texture2D(uVideo, camUv + vec2(stepUv.x, stepUv.y)).rgb, vec3(0.299, 0.587, 0.114));
      float ml = dot(texture2D(uVideo, camUv + vec2(-stepUv.x, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
      float mr = dot(texture2D(uVideo, camUv + vec2(stepUv.x, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
      float bl = dot(texture2D(uVideo, camUv + vec2(-stepUv.x, -stepUv.y)).rgb, vec3(0.299, 0.587, 0.114));
      float bc = dot(texture2D(uVideo, camUv + vec2(0.0, -stepUv.y)).rgb, vec3(0.299, 0.587, 0.114));
      float br = dot(texture2D(uVideo, camUv + vec2(stepUv.x, -stepUv.y)).rgb, vec3(0.299, 0.587, 0.114));

      float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
      float gy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;
      float edge = smoothstep(0.08, 0.58, sqrt(gx * gx + gy * gy));

      // Local high-pass micro-structure (reveals finger joints, nose/cheek/brow contours)
      float avgLuma = (tl + tc + tr + ml + luma + mr + bl + bc + br) / 9.0;
      float detail = clamp(abs(luma - avgLuma) * 3.8, 0.0, 1.0);

      // Radiographic negative density curve + glowing bone/structural contours
      float inv = pow(clamp(1.0 - luma, 0.0, 1.0), 1.25);
      // When full anatomical skeleton is tracked (uHasPose > 0.5), keep body as a restrained
      // translucent cyan soft-tissue aura so skull & bones stay crisp and never blow out!
      float fullDensity = clamp(0.14 + inv * 0.58 + edge * 0.52 + detail * 0.28, 0.0, 1.0);
      float tissueDensity = clamp(0.05 + inv * 0.14 + edge * 0.20 + detail * 0.08, 0.0, 0.34);
      float density = mix(fullDensity, tissueDensity, uHasPose);
      vec3 xrayCol = xrayRamp(density);

      // Subtle radiographic film grain & sweeping diagnostic scan bar
      float grainPhase = mod(floor(uTime * 18.0), 100.0);
      float filmGrain = (hash21(floor(vUv * uResolution * 0.5) + grainPhase) - 0.5) * 0.032;
      float scanLine = 0.96 + 0.04 * sin(vUv.y * uResolution.y * 0.85);
      float sweepY = fract(1.0 - uTime * 0.14);
      float sweepBeam = exp(-abs(vUv.y - sweepY) * 28.0) * (0.07 + uAudioRms * 0.12);

      // Clinical dark radiographic lightbox backdrop with faint calibration grid
      vec2 calGrid = abs(fract(vUv * vec2(16.0, 9.0) - 0.5) - 0.5);
      float calLine = 1.0 - smoothstep(0.008, 0.022, min(calGrid.x, calGrid.y));
      vec3 lightbox = vec3(0.006, 0.016, 0.034) + vec3(0.05, 0.26, 0.42) * calLine * 0.12;
      if (uHasCustomBg > 0.5) {
        float bgLuma = dot(themeBg, vec3(0.299, 0.587, 0.114));
        lightbox = mix(lightbox, xrayRamp(clamp(bgLuma * 0.45, 0.0, 0.48)) * 0.55, 0.65);
      }

      if (uHasSegMask > 0.5) {
        vec2 maskUv = vec2(camUv.x, 1.0 - camUv.y);
        float m = texture2D(uSegMask, maskUv).r;
        float person = smoothstep(0.28, 0.72, m);

        // Tangential X-ray absorption rim along human silhouette
        vec2 texel = 2.4 / max(uResolution, vec2(1.0));
        float mL = texture2D(uSegMask, maskUv - vec2(texel.x, 0.0)).r;
        float mR = texture2D(uSegMask, maskUv + vec2(texel.x, 0.0)).r;
        float mU = texture2D(uSegMask, maskUv + vec2(0.0, texel.y)).r;
        float mD = texture2D(uSegMask, maskUv - vec2(0.0, texel.y)).r;
        float rim = clamp(length(vec2(mR - mL, mU - mD)) * 3.0, 0.0, 1.0);

        float rimBoost = mix(0.62 + uAudioRms * 0.45, 0.44 + uAudioRms * 0.25, uHasPose);
        vec3 xrayPerson = xrayCol * (0.86 + 0.14 * m) + vec3(0.56, 0.90, 1.0) * rim * rimBoost;
        outCol = mix(lightbox, xrayPerson, person);
        outCol += vec3(0.26, 0.82, 1.0) * sweepBeam * (0.35 + person * 0.95);
      } else {
        // Instant full-frame radiographic fallback while segmentation model initializes
        vec3 baseFrame = mix(xrayCol, mix(lightbox, xrayCol, 0.55), uHasPose);
        outCol = baseFrame + vec3(0.26, 0.82, 1.0) * sweepBeam;
      }

      outCol = max(outCol * scanLine + filmGrain, vec3(0.0));
      outCol *= (0.72 + 0.28 * vig);
    }

    gl_FragColor = vec4(outCol, 1.0);
  }
`;

const COMP_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const COMP_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uBg;
  uniform sampler2D uFx;
  uniform float uAberration;
  uniform float uNaturalBg; // 1.0 in pure natural camera mode -> never tone-map/darken bg

  vec3 acesFilm(vec3 x) {
    float a = 2.51;
    float b = 0.03;
    float c = 2.43;
    float d = 0.59;
    float e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  }

  void main() {
    vec3 bg = texture2D(uBg, vUv).rgb;

    vec2 dir = (vUv - 0.5) * uAberration;
    float fxR = texture2D(uFx, vUv + dir).r;
    float fxG = texture2D(uFx, vUv).g;
    float fxB = texture2D(uFx, vUv - dir).b;
    vec3 fx = vec3(fxR, fxG, fxB);

    if (uNaturalBg > 0.5) {
      // Keep raw webcam pixels 100% untouched; tone-map only HDR holographic FX
      vec3 fxMapped = mix(fx, acesFilm(fx * 1.1), 0.55);
      gl_FragColor = vec4(clamp(bg + fxMapped, 0.0, 1.0), 1.0);
      return;
    }

    vec3 combined = bg + fx;
    vec3 mapped = mix(combined, acesFilm(combined * 1.05), 0.45);
    gl_FragColor = vec4(clamp(mapped, 0.0, 1.0), 1.0);
  }
`;

export class StageRenderer {
  public readonly canvas: HTMLCanvasElement;

  private renderer: THREE.WebGLRenderer;
  private width = 1280;
  private height = 720;
  private dpr = 1;

  // Pass 1: Background camera + 5 artistic theme shaders (+ Pass 1b: crisp non-bloomed X-Ray skull)
  private bgScene = new THREE.Scene();
  private bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private bgMaterial: THREE.ShaderMaterial;
  private bgTarget: THREE.WebGLRenderTarget;
  private skullScene = new THREE.Scene();
  private videoTexture: THREE.VideoTexture | null = null;
  private customBgTexture: THREE.Texture | null = null;
  private matrixAtlasTexture: THREE.CanvasTexture;
  private segTexture: THREE.DataTexture | null = null;
  private segTexW = 0;
  private segTexH = 0;

  // Pass 2: HDR holographic FX scene + UnrealBloomPass
  private fxScene = new THREE.Scene();
  private fxCamera: THREE.OrthographicCamera;
  private fxComposer: EffectComposer;
  private bloomPass: UnrealBloomPass;

  // Single-batch dynamic triangle mesh for all strings, ticks, rings, trails, skeletons
  private posArray = new Float32Array(MAX_VERTS * 3);
  private colArray = new Float32Array(MAX_VERTS * 3);
  private quadVertCount = 0;
  private dynGeo: THREE.BufferGeometry;
  private dynPosAttr: THREE.BufferAttribute;
  private dynColAttr: THREE.BufferAttribute;

  // GPU multi-shape particle pool (spark / petal / bubble / star / pixel)
  private sparks: Spark[];
  private sparkPosArray = new Float32Array(MAX_SPARKS * 3);
  private sparkColArray = new Float32Array(MAX_SPARKS * 3);
  private sparkSizeArray = new Float32Array(MAX_SPARKS);
  private sparkSeedArray = new Float32Array(MAX_SPARKS);
  private sparkGeo: THREE.BufferGeometry;
  private sparkPosAttr: THREE.BufferAttribute;
  private sparkColAttr: THREE.BufferAttribute;
  private sparkSizeAttr: THREE.BufferAttribute;
  private sparkSeedAttr: THREE.BufferAttribute;
  private sparkMat: THREE.ShaderMaterial;

  // Expanding theme-specific shockwaves & fingertip trails
  private shockwaves: Shockwave[] = [];
  private trails = new Map<string, TrailNode[]>();

  // Pass 3: Final screen composite
  private compScene = new THREE.Scene();
  private compCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private compMaterial: THREE.ShaderMaterial;

  // Pass 4: Post-composite crisp Retina Pitch Label Sprite overlay (never blurred by Bloom!)
  private labelScene = new THREE.Scene();
  private labelSprites: THREE.Sprite[] = [];
  private labelTextureCache = new Map<string, THREE.CanvasTexture>();

  private theme: ThemeConfig = THEMES.plasma;
  private cameraFilterMode: CameraFilterMode = 'cinema';
  private videoAspect = 16 / 9;
  private handVisual: HandVisualMode = 'hologram';
  private elapsedSec = 0;
  private strumPulse = 0;
  private scratchColor = new THREE.Color();
  private readonly xraySink: XrayDrawSink;
  private readonly skullRig: XraySkullRig;

  constructor(container: HTMLElement) {
    this.width = Math.max(320, container.clientWidth || window.innerWidth);
    this.height = Math.max(240, container.clientHeight || window.innerHeight);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(this.width, this.height);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.autoClear = false;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'stage-canvas';
    container.appendChild(this.canvas);

    const rtType = this.renderer.capabilities.isWebGL2
      ? THREE.HalfFloatType
      : THREE.UnsignedByteType;

    const rw = Math.max(1, Math.floor(this.width * this.dpr));
    const rh = Math.max(1, Math.floor(this.height * this.dpr));

    // --- Pass 1: Background ---
    this.bgTarget = new THREE.WebGLRenderTarget(rw, rh, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });

    const dummyTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    dummyTex.needsUpdate = true;

    this.matrixAtlasTexture = this.buildMatrixGlyphAtlas();

    this.bgMaterial = new THREE.ShaderMaterial({
      vertexShader: BG_VERT,
      fragmentShader: BG_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uVideo: { value: dummyTex },
        uSegMask: { value: dummyTex },
        uCustomBg: { value: dummyTex },
        uMatrixAtlas: { value: this.matrixAtlasTexture },
        uHasVideo: { value: 0 },
        uHasSegMask: { value: 0 },
        uHasPose: { value: 0 },
        uHasCustomBg: { value: 0 },
        uCustomBgAspect: { value: 16 / 9 },
        uMirror: { value: 1 },
        uVideoAspect: { value: 16 / 9 },
        uScreenAspect: { value: this.width / this.height },
        uMode: { value: 0 },
        uBgStyle: { value: this.theme.bgStyleIndex },
        uTime: { value: 0 },
        uAudioRms: { value: 0 },
        uResolution: { value: new THREE.Vector2(rw, rh) },
        uDarkTint: { value: new THREE.Vector3(...this.theme.bgDarkTint) },
        uStarColor: { value: new THREE.Vector3(...this.theme.starColor) },
        uRimColor: { value: new THREE.Vector3(...this.theme.rimColor) },
        uCyberColor: { value: new THREE.Vector3(...this.theme.cyberEdgeColor) },
      },
    });
    this.bgScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.bgMaterial));

    // --- Pass 2: HDR FX Scene + UnrealBloom ---
    this.fxCamera = new THREE.OrthographicCamera(0, this.width, this.height, 0, -1200, 1200);

    // 3D Articulated X-Ray Skull Rig renders in its own crisp non-bloomed pass onto bgTarget
    // so UnrealBloomPass never blows out facial/dental micro-details, and strings glow cleanly in front!
    this.skullRig = new XraySkullRig();
    this.skullScene.add(this.skullRig.root);

    this.dynGeo = new THREE.BufferGeometry();
    this.dynPosAttr = new THREE.BufferAttribute(this.posArray, 3);
    this.dynPosAttr.setUsage(THREE.DynamicDrawUsage);
    this.dynColAttr = new THREE.BufferAttribute(this.colArray, 3);
    this.dynColAttr.setUsage(THREE.DynamicDrawUsage);
    this.dynGeo.setAttribute('position', this.dynPosAttr);
    this.dynGeo.setAttribute('color', this.dynColAttr);

    const dynMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    const dynMesh = new THREE.Mesh(this.dynGeo, dynMat);
    dynMesh.frustumCulled = false;
    dynMesh.renderOrder = 3;
    this.fxScene.add(dynMesh);

    // Multi-shape GPU particle pool
    this.sparks = Array.from({ length: MAX_SPARKS }, () => ({
      alive: false,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      r: 1,
      g: 1,
      b: 1,
      life: 0,
      maxLife: 1,
      size: 6,
      seed: 0,
    }));
    this.sparkGeo = new THREE.BufferGeometry();
    this.sparkPosAttr = new THREE.BufferAttribute(this.sparkPosArray, 3);
    this.sparkPosAttr.setUsage(THREE.DynamicDrawUsage);
    this.sparkColAttr = new THREE.BufferAttribute(this.sparkColArray, 3);
    this.sparkColAttr.setUsage(THREE.DynamicDrawUsage);
    this.sparkSizeAttr = new THREE.BufferAttribute(this.sparkSizeArray, 1);
    this.sparkSizeAttr.setUsage(THREE.DynamicDrawUsage);
    this.sparkSeedAttr = new THREE.BufferAttribute(this.sparkSeedArray, 1);
    this.sparkSeedAttr.setUsage(THREE.DynamicDrawUsage);
    this.sparkGeo.setAttribute('position', this.sparkPosAttr);
    this.sparkGeo.setAttribute('color', this.sparkColAttr);
    this.sparkGeo.setAttribute('aSize', this.sparkSizeAttr);
    this.sparkGeo.setAttribute('aSeed', this.sparkSeedAttr);

    this.sparkMat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uParticleShape: { value: PARTICLE_SHAPE_INDEX[this.theme.particleShape] },
      },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aSeed;
        attribute vec3 color;
        varying vec3 vColor;
        varying float vSeed;
        void main() {
          vColor = color;
          vSeed = aSeed;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uTime;
        uniform int uParticleShape; // 0: spark, 1: petal, 2: bubble, 3: star, 4: pixel
        varying vec3 vColor;
        varying float vSeed;

        void main() {
          vec2 p = (gl_PointCoord - 0.5) * 2.0;

          if (uParticleShape == 1) {
            // Rotating gold-leaf / ink petal diamond silhouette
            float ang = uTime * (2.6 + vSeed * 2.4) + vSeed * 6.283;
            float c = cos(ang);
            float s = sin(ang);
            vec2 rp = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
            // Elongated organic petal
            vec2 q = vec2(rp.x * 1.05, rp.y * 1.95);
            float d = length(q);
            if (d > 1.0) discard;
            float shimmer = 0.72 + 0.28 * sin(uTime * 7.0 + vSeed * 25.0);
            float body = smoothstep(1.0, 0.22, d) * shimmer;
            gl_FragColor = vec4(vColor * body * 1.15, 1.0);
            return;
          }

          if (uParticleShape == 2) {
            // Bioluminescent translucent bubble with rim & top-left specular crescent
            float r = length(p);
            if (r > 1.0) discard;
            float rim = exp(-pow((r - 0.76) * 6.5, 2.0));
            float fill = smoothstep(0.95, 0.0, r) * 0.22;
            float spec = exp(-length(p - vec2(-0.34, -0.34)) * 5.2) * 0.95;
            gl_FragColor = vec4(vColor * (rim * 1.15 + fill) + vec3(spec), 1.0);
            return;
          }

          if (uParticleShape == 3) {
            // Crisp 4-point celestial cross starburst
            vec2 ap = abs(p);
            float crossH = exp(-ap.y * 8.5) * exp(-ap.x * 1.9);
            float crossV = exp(-ap.x * 8.5) * exp(-ap.y * 1.9);
            float core = exp(-dot(p, p) * 7.5);
            float twinkle = 0.7 + 0.3 * sin(uTime * 8.0 + vSeed * 31.0);
            float shape = (crossH + crossV) * 0.85 + core * 1.1;
            if (shape < 0.03) discard;
            gl_FragColor = vec4(vColor * shape * twinkle, 1.0);
            return;
          }

          if (uParticleShape == 4) {
            // Retro VHS neon pixel square tile
            vec2 ap = abs(p);
            float box = max(ap.x, ap.y);
            if (box > 0.85) discard;
            float inner = smoothstep(0.85, 0.55, box);
            float edge = exp(-abs(box - 0.68) * 14.0) * 0.5;
            gl_FragColor = vec4(vColor * (inner * 1.1 + edge), 1.0);
            return;
          }

          // Default 0: sharp hot plasma spark
          float dist = length(p);
          if (dist > 1.0) discard;
          float core = exp(-dist * dist * 5.4);
          float halo = pow(max(0.0, 1.0 - dist), 2.2) * 0.65;
          gl_FragColor = vec4(vColor * (core * 1.4 + halo), 1.0);
        }
      `,
    });
    const sparkPoints = new THREE.Points(this.sparkGeo, this.sparkMat);
    sparkPoints.frustumCulled = false;
    sparkPoints.renderOrder = 4;
    this.fxScene.add(sparkPoints);

    // EffectComposer for FX scene ONLY
    const fxRT = new THREE.WebGLRenderTarget(rw, rh, {
      type: rtType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.fxComposer = new EffectComposer(this.renderer, fxRT);
    this.fxComposer.setPixelRatio(this.dpr);
    this.fxComposer.setSize(this.width, this.height);
    this.fxComposer.renderToScreen = false;

    const renderPass = new RenderPass(this.fxScene, this.fxCamera);
    renderPass.clear = true;
    renderPass.clearColor = new THREE.Color(0x000000);
    renderPass.clearAlpha = 1;
    this.fxComposer.addPass(renderPass);

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(this.width, this.height),
      this.theme.bloomStrength,
      this.theme.bloomRadius,
      this.theme.bloomThreshold
    );
    this.fxComposer.addPass(this.bloomPass);

    // --- Pass 3: Composite ---
    this.compMaterial = new THREE.ShaderMaterial({
      vertexShader: COMP_VERT,
      fragmentShader: COMP_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uBg: { value: this.bgTarget.texture },
        uFx: { value: this.fxComposer.readBuffer.texture },
        uAberration: { value: 0.002 },
        uNaturalBg: { value: 0 },
      },
    });
    this.compScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compMaterial));

    // --- Pass 4: Pre-allocated crisp Pitch Label Sprites ---
    for (let i = 0; i < MAX_LABEL_SPRITES; i++) {
      const mat = new THREE.SpriteMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      this.labelScene.add(sprite);
      this.labelSprites.push(sprite);
    }

    this.xraySink = {
      pushTri: (x1, y1, x2, y2, x3, y3, r, g, b) => this.pushTri(x1, y1, x2, y2, x3, y3, r, g, b),
      pushSegment: (x1, y1, x2, y2, thickness, r, g, b) =>
        this.pushSegment(x1, y1, x2, y2, thickness, r, g, b),
      pushRing: (cx, cy, radius, thickness, r, g, b, segments) =>
        this.pushRing(cx, cy, radius, thickness, r, g, b, segments),
      pushFilledCircle: (cx, cy, radius, r, g, b, segments) =>
        this.pushFilledCircle(cx, cy, radius, r, g, b, segments),
    };
  }

  setTheme(themeId: ThemeId): void {
    this.theme = THEMES[themeId];
    this.bloomPass.strength = this.theme.bloomStrength;
    this.bloomPass.radius = this.theme.bloomRadius;
    this.bloomPass.threshold = this.theme.bloomThreshold;
    this.bgMaterial.uniforms.uBgStyle.value = this.theme.bgStyleIndex;
    this.bgMaterial.uniforms.uDarkTint.value.set(...this.theme.bgDarkTint);
    this.bgMaterial.uniforms.uStarColor.value.set(...this.theme.starColor);
    this.bgMaterial.uniforms.uRimColor.value.set(...this.theme.rimColor);
    this.bgMaterial.uniforms.uCyberColor.value.set(...this.theme.cyberEdgeColor);
    this.sparkMat.uniforms.uParticleShape.value = PARTICLE_SHAPE_INDEX[this.theme.particleShape];
  }

  setCameraFilter(mode: CameraFilterMode): void {
    this.cameraFilterMode = mode;
    const map: Record<CameraFilterMode, number> = {
      cinema: 0,
      portrait: 1,
      cyber: 2,
      clean: 3,
      xray: 4,
    };
    this.bgMaterial.uniforms.uMode.value = map[mode];
    this.compMaterial.uniforms.uNaturalBg.value = mode === 'clean' ? 1 : 0;
  }

  setHandVisual(mode: HandVisualMode): void {
    this.handVisual = mode;
  }

  setMirror(mirror: boolean): void {
    this.bgMaterial.uniforms.uMirror.value = mirror ? 1 : 0;
  }

  attachVideo(video: HTMLVideoElement | null): void {
    if (this.videoTexture) {
      this.videoTexture.dispose();
      this.videoTexture = null;
    }
    if (!video) {
      this.bgMaterial.uniforms.uHasVideo.value = 0;
      return;
    }
    const tex = new THREE.VideoTexture(video);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.NoColorSpace;
    this.videoTexture = tex;
    this.bgMaterial.uniforms.uVideo.value = tex;
    this.bgMaterial.uniforms.uHasVideo.value = 1;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      this.bgMaterial.uniforms.uVideoAspect.value = video.videoWidth / video.videoHeight;
    }
  }

  setCustomBackground(image: HTMLImageElement | null): void {
    if (this.customBgTexture) {
      this.customBgTexture.dispose();
      this.customBgTexture = null;
    }
    if (!image) {
      this.bgMaterial.uniforms.uHasCustomBg.value = 0;
      return;
    }
    const tex = new THREE.Texture(image);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    this.customBgTexture = tex;
    this.bgMaterial.uniforms.uCustomBg.value = tex;
    this.bgMaterial.uniforms.uHasCustomBg.value = 1;
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      this.bgMaterial.uniforms.uCustomBgAspect.value = image.naturalWidth / image.naturalHeight;
    }
  }

  updateSegmentationMask(frame: SegmentationFrame | null): void {
    if (!frame) {
      this.bgMaterial.uniforms.uHasSegMask.value = 0;
      return;
    }
    if (!this.segTexture || this.segTexW !== frame.width || this.segTexH !== frame.height) {
      this.segTexture?.dispose();
      this.segTexture = new THREE.DataTexture(
        frame.data,
        frame.width,
        frame.height,
        THREE.RedFormat,
        THREE.UnsignedByteType
      );
      this.segTexture.minFilter = THREE.LinearFilter;
      this.segTexture.magFilter = THREE.LinearFilter;
      this.segTexture.needsUpdate = true;
      this.segTexW = frame.width;
      this.segTexH = frame.height;
      this.bgMaterial.uniforms.uSegMask.value = this.segTexture;
    } else {
      this.segTexture.needsUpdate = true;
    }
    this.bgMaterial.uniforms.uHasSegMask.value = 1;
  }

  resize(width: number, height: number): void {
    this.width = Math.max(320, width);
    this.height = Math.max(240, height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(this.width, this.height);

    const rw = Math.max(1, Math.floor(this.width * this.dpr));
    const rh = Math.max(1, Math.floor(this.height * this.dpr));
    this.bgTarget.setSize(rw, rh);
    this.fxComposer.setPixelRatio(this.dpr);
    this.fxComposer.setSize(this.width, this.height);
    this.bloomPass.setSize(this.width, this.height);

    this.fxCamera.right = this.width;
    this.fxCamera.top = this.height;
    this.fxCamera.updateProjectionMatrix();

    this.bgMaterial.uniforms.uScreenAspect.value = this.width / this.height;
    this.bgMaterial.uniforms.uResolution.value.set(rw, rh);
  }

  getAspect(): number {
    return this.width / this.height;
  }

  // --- Event-triggered particle & shockwave bursts ---

  spawnPluckBurst(point: Vec2, pitchNorm: number, velocity: number, pluckDir: number): void {
    const px = point.x * this.width;
    const py = (1 - point.y) * this.height;
    const c = samplePitchColor(this.theme, pitchNorm, this.scratchColor);
    const boost = this.theme.hdrBoost;

    this.strumPulse = Math.min(1, this.strumPulse + velocity * 0.48);

    // Theme-specific shockwave geometry
    this.shockwaves.push({
      x: px,
      y: py,
      radius: 10,
      maxRadius: (62 + velocity * 112) * (Math.min(this.width, this.height) / 720),
      r: c.r * boost * 0.85,
      g: c.g * boost * 0.85,
      b: c.b * boost * 0.85,
      life: 0,
      maxLife: this.theme.shockwaveShape === 'ink' ? 0.62 : 0.44 + velocity * 0.22,
      shape: this.theme.shockwaveShape,
      rotSpeed: (Math.random() < 0.5 ? 1 : -1) * (1.2 + Math.random() * 1.4),
      angle: Math.random() * Math.PI * 2,
    });
    if (this.shockwaves.length > 26) this.shockwaves.shift();

    // Theme-specific particle count, sizing & velocity feel
    const isSoftParticle =
      this.theme.particleShape === 'bubble' ||
      this.theme.particleShape === 'petal' ||
      this.theme.particleShape === 'star';
    const count = Math.round((isSoftParticle ? 16 : 20) + velocity * (isSoftParticle ? 28 : 42));
    const baseSpeed =
      (isSoftParticle ? 90 + velocity * 170 : 145 + velocity * 340) * (this.height / 720);
    const sizeScale =
      this.theme.particleShape === 'bubble'
        ? 2.1
        : this.theme.particleShape === 'star' || this.theme.particleShape === 'petal'
          ? 1.75
          : this.theme.particleShape === 'pixel'
            ? 1.35
            : 1.0;

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = baseSpeed * (0.25 + Math.random() * 0.95);
      const hot = this.theme.particleShape === 'spark' && Math.random() < 0.35;
      this.emitSpark(
        px + (Math.random() - 0.5) * 10,
        py + (Math.random() - 0.5) * 10,
        Math.cos(angle) * spd,
        Math.sin(angle) * spd + (this.theme.sparkGravity < 0 ? 55 : pluckDir * 42),
        hot ? 1.8 : c.r * boost,
        hot ? 1.8 : c.g * boost,
        hot ? 1.8 : c.b * boost,
        (isSoftParticle ? 0.65 : 0.38) + Math.random() * (isSoftParticle ? 0.85 : 0.56),
        (3.8 + Math.random() * 6.2) * sizeScale * this.dpr
      );
    }
  }

  spawnRetuneShimmer(p1: Vec2, p2: Vec2, pitchNorm: number): void {
    const c = samplePitchColor(this.theme, pitchNorm, this.scratchColor);
    const boost = this.theme.hdrBoost * 0.9;
    const sizeScale = this.theme.particleShape === 'spark' ? 1.0 : 1.5;
    for (let i = 0; i < 12; i++) {
      const t = Math.random();
      const px = (p1.x + (p2.x - p1.x) * t) * this.width;
      const py = (1 - (p1.y + (p2.y - p1.y) * t)) * this.height;
      const ang = Math.random() * Math.PI * 2;
      const spd = 40 + Math.random() * 110;
      this.emitSpark(
        px,
        py,
        Math.cos(ang) * spd,
        Math.sin(ang) * spd,
        c.r * boost,
        c.g * boost,
        c.b * boost,
        0.3 + Math.random() * 0.38,
        (3.2 + Math.random() * 4.5) * sizeScale * this.dpr
      );
    }
  }

  spawnStringCreated(p1: Vec2, p2: Vec2, pitchNorm: number): void {
    const c = samplePitchColor(this.theme, pitchNorm, this.scratchColor);
    const boost = this.theme.hdrBoost;
    const sizeScale = this.theme.particleShape === 'spark' ? 1.0 : 1.45;
    for (let i = 0; i < 24; i++) {
      const t = i / 23;
      const px = (p1.x + (p2.x - p1.x) * t) * this.width;
      const py = (1 - (p1.y + (p2.y - p1.y) * t)) * this.height;
      const ang = Math.random() * Math.PI * 2;
      const spd = 30 + Math.random() * 90;
      this.emitSpark(
        px,
        py,
        Math.cos(ang) * spd,
        Math.sin(ang) * spd,
        c.r * boost,
        c.g * boost,
        c.b * boost,
        0.38 + Math.random() * 0.38,
        (3.2 + Math.random() * 4.8) * sizeScale * this.dpr
      );
    }
  }

  spawnDeleteShatter(p1: Vec2, p2: Vec2): void {
    const [r, g, b] = this.theme.deleteWarnColor;
    for (let i = 0; i < 48; i++) {
      const t = Math.random();
      const px = (p1.x + (p2.x - p1.x) * t) * this.width;
      const py = (1 - (p1.y + (p2.y - p1.y) * t)) * this.height;
      const ang = Math.random() * Math.PI * 2;
      const spd = 70 + Math.random() * 240;
      this.emitSpark(
        px,
        py,
        Math.cos(ang) * spd,
        Math.sin(ang) * spd,
        r * 2.2,
        g * 2.2,
        b * 2.2,
        0.4 + Math.random() * 0.5,
        (4 + Math.random() * 6) * this.dpr
      );
    }
  }

  spawnMutePulse(point: Vec2): void {
    const px = point.x * this.width;
    const py = (1 - point.y) * this.height;
    this.shockwaves.push({
      x: px,
      y: py,
      radius: 42,
      maxRadius: 8,
      r: 0.9,
      g: 0.95,
      b: 1.2,
      life: 0,
      maxLife: 0.24,
      shape: 'ripple',
      rotSpeed: 0,
      angle: 0,
    });
  }

  spawnBgSwipeFlash(point: Vec2): void {
    const px = point.x * this.width;
    const py = (1 - point.y) * this.height;
    const maxR = Math.max(this.width, this.height) * 0.42;
    this.shockwaves.push({
      x: px,
      y: py,
      radius: 26,
      maxRadius: maxR,
      r: 0.25,
      g: 1.35,
      b: 0.72,
      life: 0,
      maxLife: 0.48,
      shape: 'flare',
      rotSpeed: 0.6,
      angle: 0,
    });
    if (this.shockwaves.length > 26) this.shockwaves.shift();
  }

  spawnGhostPluckBurst(point: Vec2, pitchNorm: number, velocity: number): void {
    const px = point.x * this.width;
    const py = (1 - point.y) * this.height;
    const c = samplePitchColor(this.theme, pitchNorm, this.scratchColor);
    const boost = this.theme.hdrBoost * 0.72;

    this.shockwaves.push({
      x: px,
      y: py,
      radius: 6,
      maxRadius: (36 + velocity * 58) * (Math.min(this.width, this.height) / 720),
      r: c.r * boost,
      g: c.g * boost,
      b: c.b * boost,
      life: 0,
      maxLife: 0.34,
      shape: this.theme.shockwaveShape,
      rotSpeed: 1.1,
      angle: Math.random() * Math.PI,
    });
    if (this.shockwaves.length > 28) this.shockwaves.shift();

    const count = Math.round(10 + velocity * 18);
    const baseSpeed = (85 + velocity * 170) * (this.height / 720);
    const sizeScale = this.theme.particleShape === 'spark' ? 1.0 : 1.5;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = baseSpeed * (0.25 + Math.random() * 0.8);
      this.emitSpark(
        px,
        py,
        Math.cos(angle) * spd,
        Math.sin(angle) * spd,
        c.r * boost * 1.15,
        c.g * boost * 1.15,
        c.b * boost * 1.15,
        0.34 + Math.random() * 0.42,
        (3.0 + Math.random() * 4.2) * sizeScale * this.dpr
      );
    }
  }

  private emitSpark(
    x: number,
    y: number,
    vx: number,
    vy: number,
    r: number,
    g: number,
    b: number,
    maxLife: number,
    size: number
  ): void {
    for (let i = 0; i < MAX_SPARKS; i++) {
      const s = this.sparks[i];
      if (!s.alive) {
        s.alive = true;
        s.x = x;
        s.y = y;
        s.vx = vx;
        s.vy = vy;
        s.r = r;
        s.g = g;
        s.b = b;
        s.life = 0;
        s.maxLife = maxLife;
        s.size = size;
        s.seed = Math.random();
        return;
      }
    }
  }

  // --- Main Render Loop ---

  render(
    dtSec: number,
    strings: AirString[],
    preview: PreviewString | null,
    resonances: ResonancePair[],
    hands: TrackedHand[],
    pointerPos: Vec2 | null,
    audio: AudioReactiveMetrics,
    videoEl: HTMLVideoElement | null,
    loopSnapshot?: LoopRenderSnapshot,
    nowMs = performance.now(),
    pose: TrackedPose | null = null,
    face: TrackedFace | null = null
  ): void {
    const safeDt = Math.max(1 / 240, Math.min(0.08, dtSec));
    this.elapsedSec += safeDt;
    this.strumPulse *= Math.exp(-5.5 * safeDt);

    if (videoEl && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
      this.videoAspect = videoEl.videoWidth / videoEl.videoHeight;
      this.bgMaterial.uniforms.uVideoAspect.value = this.videoAspect;
    }
    const xrayActive = this.cameraFilterMode === 'xray';
    const xrayTracked = xrayActive && (pose !== null || face !== null);
    this.bgMaterial.uniforms.uHasPose.value = xrayTracked ? 1 : 0;
    this.bgMaterial.uniforms.uTime.value = this.elapsedSec;
    this.bgMaterial.uniforms.uAudioRms.value = Math.min(
      1,
      audio.rms + (loopSnapshot ? loopSnapshot.beatPulse * 0.18 : 0)
    );
    this.sparkMat.uniforms.uTime.value = this.elapsedSec;

    this.quadVertCount = 0;

    // 0. Hyper-realistic 3D articulated X-Ray Skull (live 478-pt face + jaw hinge) & body skeleton
    const proj = { width: this.width, height: this.height, videoAspect: this.videoAspect };
    const skullNeckAnchor = this.skullRig.update(
      xrayActive,
      face,
      pose,
      proj,
      this.elapsedSec,
      audio.rms
    );
    if (xrayActive && pose) {
      drawXrayBodySkeleton(
        this.xraySink,
        pose,
        hands,
        proj,
        this.elapsedSec,
        audio.rms,
        skullNeckAnchor
      );
    }

    // 1. Fingertip ribbon trails
    this.updateAndDrawTrails(hands, pointerPos, safeDt);

    // 2. Consonant harmonic resonance arcs
    for (const pair of resonances) {
      this.drawResonanceArc(pair, audio);
    }

    // 3. Active strings (pitch-colored even at rest + theme-specific ticks & anchors)
    for (const str of strings) {
      this.drawString(str, audio);
    }

    // 4. Two-hand / pointer creation preview dashed string
    if (preview) {
      this.drawPreviewString(preview);
    }

    // 5. Theme-specific shockwave geometries
    this.updateAndDrawShockwaves(safeDt);

    // 6. Air Looper holographic progress halo
    if (loopSnapshot && (loopSnapshot.state !== 'idle' || loopSnapshot.eventCount > 0)) {
      this.drawLoopRing(loopSnapshot, nowMs);
    }

    // 7. Hand skeletons & active fingertips
    for (const hand of hands) {
      this.drawHand(hand);
    }

    if (pointerPos && hands.length === 0) {
      const px = pointerPos.x * this.width;
      const py = (1 - pointerPos.y) * this.height;
      const [tr, tg, tb] = this.theme.trailColor;
      this.pushRing(px, py, 9, 1.8, tr * 1.4, tg * 1.4, tb * 1.4, 20);
    }

    this.dynGeo.setDrawRange(0, this.quadVertCount);
    this.dynPosAttr.needsUpdate = true;
    this.dynColAttr.needsUpdate = true;

    // 8. GPU particles
    this.updateSparks(safeDt);

    // 9. Update crisp pitch-label sprites positioned at one end of each string (+ preview)
    this.updatePitchLabels(strings, preview);

    // --- Execute Multi-Pass Pipeline ---
    // Pass 1: Background -> bgTarget
    this.renderer.setRenderTarget(this.bgTarget);
    this.renderer.clear();
    this.renderer.render(this.bgScene, this.bgCamera);

    // Pass 1b: Crisp 3D X-Ray Skull composited directly onto bgTarget (bypasses UnrealBloomPass!)
    if (this.skullRig.root.visible) {
      this.renderer.render(this.skullScene, this.fxCamera);
    }

    // Pass 2: FX Scene -> UnrealBloom -> fxComposer.readBuffer
    this.fxComposer.render(safeDt);

    // Pass 3: Composite bgTarget + bloomed FX -> Screen
    this.compMaterial.uniforms.uFx.value = this.fxComposer.readBuffer.texture;
    this.compMaterial.uniforms.uAberration.value =
      this.theme.id === 'plasma' || this.theme.id === 'synthwave'
        ? 0.0018 + this.strumPulse * 0.0075 + audio.bass * 0.0035
        : 0.0006 + this.strumPulse * 0.0028;

    this.renderer.setRenderTarget(null);
    this.renderer.clear();
    this.renderer.render(this.compScene, this.compCamera);

    // Pass 4: Render crisp non-bloomed pitch tag sprites directly onto final screen
    this.renderer.render(this.labelScene, this.fxCamera);
  }

  private drawString(str: AirString, audio: AudioReactiveMetrics): void {
    const x1 = str.p1.x * this.width;
    const y1 = (1 - str.p1.y) * this.height;
    const x2 = str.p2.x * this.width;
    const y2 = (1 - str.p2.y) * this.height;

    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenPx = Math.hypot(dx, dy);
    if (lenPx < 2) return;

    const nx = -dy / lenPx;
    const ny = dx / lenPx;

    // Distinct vivid pitch color EVEN AT REST (so every pitch is visually distinguishable!)
    const pitchCol = samplePitchColor(this.theme, str.pitch.pitchNorm, this.scratchColor);
    const [ir, ig, ib] = this.theme.idleStringColor;
    const energy = Math.min(1, str.energy + audio.rms * str.energy * 0.35);
    const colorMix = Math.min(1, 0.78 + energy * 0.22);

    let r = ir + (pitchCol.r - ir) * colorMix;
    let g = ig + (pitchCol.g - ig) * colorMix;
    let b = ib + (pitchCol.b - ib) * colorMix;

    if (str.deleteProgress > 0.01) {
      const [dr, dg, db] = this.theme.deleteWarnColor;
      const w = str.deleteProgress;
      r = r * (1 - w) + dr * w;
      g = g * (1 - w) + dg * w;
      b = b * (1 - w) + db * w;
    }

    const boost = energy * this.theme.hdrBoost;
    const style = this.theme.stringStyle;

    // 1. Theme-specific fret / scale markings along string
    const ticks = str.pitch.fretCount;
    const tickAlpha = 0.30 + energy * 0.44;
    for (let i = 1; i < ticks; i++) {
      const u = i / ticks;
      const major = i % 3 === 0;
      const tx = x1 + dx * u;
      const ty = y1 + dy * u;

      if (style === 'silk') {
        // Ink/Guzheng: delicate guqin Huiwei dots along the string!
        if (major) {
          this.pushFilledCircle(tx, ty + 6, 2.1, r * (tickAlpha + 0.18), g * (tickAlpha + 0.18), b * (tickAlpha + 0.18), 8);
        } else {
          this.pushFilledCircle(tx, ty + 4.5, 1.1, r * tickAlpha, g * tickAlpha, b * tickAlpha, 6);
        }
      } else {
        const tickH = (major ? 10 : 5.2) * (0.9 + energy * 0.35);
        this.pushSegment(
          tx,
          ty,
          tx + nx * tickH,
          ty + ny * tickH,
          major ? 1.35 : 0.9,
          r * tickAlpha,
          g * tickAlpha,
          b * tickAlpha
        );
      }
    }

    // 2. Standing-wave + theme-styled vibration polyline
    const segments = 56;
    const dispScale = style === 'liquid' ? 1.25 : style === 'silk' ? 0.92 : 1.0;
    const maxDisp =
      str.amplitude *
      (26 + Math.min(lenPx * 0.07, 32)) *
      dispScale *
      (1 + audio.treble * 0.25);
    const jitterAmp =
      this.theme.arcJitter *
      str.amplitude *
      (5.0 + str.pitch.pitchNorm * 8.0 + audio.treble * 6.5);

    const coreWidth = (style === 'liquid' ? 1.85 : 1.4) + energy * 1.45;
    const auraWidth = (style === 'liquid' ? 4.2 : 2.8) + energy * 7.8;

    let prevX = x1;
    let prevY = y1;
    let prevGhostX = x1;
    let prevGhostY = y1;

    for (let i = 1; i <= segments; i++) {
      const u = i / segments;
      const env = Math.sin(u * Math.PI);

      const phaseRate = style === 'liquid' ? str.phase * 0.55 : str.phase;
      const h1 = Math.sin(u * Math.PI) * Math.cos(phaseRate);
      const h2 = 0.42 * Math.sin(u * Math.PI * 2) * Math.cos(phaseRate * 1.97 + str.pluckPos * 3.1);
      const h3 = 0.22 * Math.sin(u * Math.PI * 3) * Math.cos(phaseRate * 3.04);

      const crackle =
        jitterAmp > 0.3
          ? (Math.sin(u * 38 + this.elapsedSec * 48 + str.id * 7) * 0.55 +
              Math.sin(u * 71 - this.elapsedSec * 67 + str.id * 13) * 0.45) *
            jitterAmp *
            env
          : 0;

      const disp = (h1 + h2 + h3) * maxDisp * str.pluckDir * env + crackle;
      const cx = x1 + dx * u + nx * disp;
      const cy = y1 + dy * u + ny * disp;

      // Vivid saturated outer HDR aura ribbon
      const auraIntensity = 0.17 + boost * 0.42;
      this.pushSegment(
        prevX,
        prevY,
        cx,
        cy,
        auraWidth,
        r * auraIntensity,
        g * auraIntensity,
        b * auraIntensity
      );

      // Crisp inner filament preserving pitch hue clearly at rest AND glowing brightly on pluck
      const coreGain = 0.54 + energy * 1.02;
      this.pushSegment(
        prevX,
        prevY,
        cx,
        cy,
        coreWidth,
        (r * 0.78 + 0.22) * coreGain,
        (g * 0.78 + 0.22) * coreGain,
        (b * 0.78 + 0.22) * coreGain
      );

      if (energy > 0.12) {
        const ghostDisp = -h1 * maxDisp * 0.72 * str.pluckDir * env - crackle * 0.6;
        const gx = x1 + dx * u + nx * ghostDisp;
        const gy = y1 + dy * u + ny * ghostDisp;
        const ghostIntensity = 0.22 + boost * 0.58;
        this.pushSegment(
          prevGhostX,
          prevGhostY,
          gx,
          gy,
          1.15 + energy * 1.1,
          r * ghostIntensity,
          g * ghostIntensity,
          b * ghostIntensity
        );
        prevGhostX = gx;
        prevGhostY = gy;
      }

      prevX = cx;
      prevY = cy;
    }

    // 3. Theme-distinct endpoint anchor nodes
    const [pr, pg, pb] = this.theme.pinchRingColor;
    const drawEnd = (ex: number, ey: number, grabbed: boolean) => {
      const dotGain = grabbed ? 1.45 : 0.68 + energy * 0.55;
      if (style === 'silk') {
        // Ink cinnabar seal square-dot anchor
        this.pushPolygonRing(ex, ey, grabbed ? 8.5 : 5.2, 1.5, pr * 1.25, pg * 1.25, pb * 1.25, 4, Math.PI * 0.25);
        this.pushFilledCircle(ex, ey, grabbed ? 4.4 : 2.8, r * dotGain, g * dotGain, b * dotGain, 10);
      } else if (style === 'starlight') {
        // Celestial rotating 4-point star crosshair anchor
        const rot = this.elapsedSec * 0.9 + str.id;
        const arm = grabbed ? 13 : 7.5 + energy * 3.5;
        this.pushSegment(ex - Math.cos(rot) * arm, ey - Math.sin(rot) * arm, ex + Math.cos(rot) * arm, ey + Math.sin(rot) * arm, 1.3, r * dotGain, g * dotGain, b * dotGain);
        this.pushSegment(ex + Math.sin(rot) * arm, ey - Math.cos(rot) * arm, ex - Math.sin(rot) * arm, ey + Math.cos(rot) * arm, 1.3, r * dotGain, g * dotGain, b * dotGain);
        this.pushFilledCircle(ex, ey, 2.8, r * dotGain + 0.25, g * dotGain + 0.25, b * dotGain + 0.25, 10);
      } else if (style === 'laser') {
        // Synthwave crisp square pixel anchor
        this.pushPolygonRing(ex, ey, grabbed ? 11 : 6.5, 1.6, r * dotGain, g * dotGain, b * dotGain, 4, Math.PI * 0.25);
        this.pushFilledCircle(ex, ey, 2.8, r * dotGain + 0.2, g * dotGain + 0.2, b * dotGain + 0.2, 8);
      } else if (style === 'arc') {
        // Cyber diamond reticle anchor
        this.pushPolygonRing(ex, ey, grabbed ? 12 : 7.0, 1.4, r * dotGain, g * dotGain, b * dotGain, 4, 0);
        this.pushFilledCircle(ex, ey, grabbed ? 4.5 : 2.8, r * dotGain + 0.2, g * dotGain + 0.2, b * dotGain + 0.2, 10);
      } else {
        // Abyssal pearl orb anchor
        this.pushFilledCircle(ex, ey, grabbed ? 5.2 : 3.4, r * dotGain + 0.2, g * dotGain + 0.2, b * dotGain + 0.2, 12);
        this.pushRing(ex, ey, 7.2, 1.1, r * (0.4 + energy * 0.55), g * (0.4 + energy * 0.55), b * (0.4 + energy * 0.55), 16);
      }

      if (grabbed) {
        this.pushRing(ex, ey, 15, 2.2, pr * 1.7, pg * 1.7, pb * 1.7, 22);
      }
    };
    drawEnd(x1, y1, str.grabbedEnd === 1);
    drawEnd(x2, y2, str.grabbedEnd === 2);
  }

  private drawPreviewString(preview: PreviewString): void {
    const x1 = preview.p1.x * this.width;
    const y1 = (1 - preview.p1.y) * this.height;
    const x2 = preview.p2.x * this.width;
    const y2 = (1 - preview.p2.y) * this.height;

    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenPx = Math.hypot(dx, dy);
    const [pr, pg, pb] = this.theme.pinchRingColor;

    if (lenPx > 8) {
      const col = preview.valid
        ? samplePitchColor(this.theme, preview.pitch.pitchNorm, this.scratchColor)
        : this.scratchColor.setRGB(0.6, 0.65, 0.72);
      const dashLen = 12;
      const gapLen = 9;
      const step = dashLen + gapLen;
      const count = Math.floor(lenPx / step);
      for (let i = 0; i <= count; i++) {
        const s0 = (i * step) / lenPx;
        const s1 = Math.min(1, (i * step + dashLen) / lenPx);
        if (s0 >= 1) break;
        this.pushSegment(
          x1 + dx * s0,
          y1 + dy * s0,
          x1 + dx * s1,
          y1 + dy * s1,
          preview.valid ? 2.4 : 1.4,
          col.r * 1.45,
          col.g * 1.45,
          col.b * 1.45
        );
      }
    }

    this.pushRing(x1, y1, 14, 2.4, pr * 2.1, pg * 2.1, pb * 2.1, 20);
    this.pushRing(x2, y2, 14, 2.4, pr * 2.1, pg * 2.1, pb * 2.1, 20);
  }

  /**
   * Positions crisp Retina pitch-tag sprites (e.g. "C3", "E4", "G5") cleanly
   * outside one endpoint of every string (and preview string), color-coded by pitch!
   */
  private updatePitchLabels(strings: AirString[], preview: PreviewString | null): void {
    let spriteIdx = 0;

    const placeLabel = (
      p1: Vec2,
      p2: Vec2,
      noteName: string,
      pitchNorm: number,
      energy: number,
      isPreview: boolean
    ) => {
      if (spriteIdx >= MAX_LABEL_SPRITES) return;

      // Always pick the left-most endpoint (smaller X) so labels read naturally left-to-right
      const leftEnd = p1.x <= p2.x ? p1 : p2;
      const otherEnd = p1.x <= p2.x ? p2 : p1;

      const lx = leftEnd.x * this.width;
      const ly = (1 - leftEnd.y) * this.height;
      const ox = otherEnd.x * this.width;
      const oy = (1 - otherEnd.y) * this.height;

      const vx = lx - ox;
      const vy = ly - oy;
      const vLen = Math.hypot(vx, vy) || 1;

      // Place tag 26px outward past the endpoint along the string axis, clamped safely on screen
      const offset = 28;
      let tx = lx + (vx / vLen) * offset;
      let ty = ly + (vy / vLen) * offset;
      tx = Math.max(30, Math.min(this.width - 30, tx));
      ty = Math.max(76, Math.min(this.height - 64, ty));

      const col = samplePitchColor(this.theme, pitchNorm, this.scratchColor);
      const tex = this.getOrCreateLabelTexture(noteName, col.getHexString());

      const sprite = this.labelSprites[spriteIdx++];
      const mat = sprite.material as THREE.SpriteMaterial;
      if (mat.map !== tex) {
        mat.map = tex;
        mat.needsUpdate = true;
      }
      mat.opacity = isPreview ? 0.95 : 0.78 + Math.min(0.22, energy * 0.25);

      const scaleBoost = 1 + Math.min(0.16, energy * 0.18);
      sprite.position.set(tx, ty, 2);
      sprite.scale.set(44 * scaleBoost, 22 * scaleBoost, 1);
      sprite.visible = true;
    };

    for (const s of strings) {
      placeLabel(s.p1, s.p2, s.pitch.noteName, s.pitch.pitchNorm, s.energy, false);
    }
    if (preview && preview.valid) {
      placeLabel(preview.p1, preview.p2, preview.pitch.noteName, preview.pitch.pitchNorm, 0.9, true);
    }

    for (let i = spriteIdx; i < MAX_LABEL_SPRITES; i++) {
      this.labelSprites[i].visible = false;
    }
  }

  private getOrCreateLabelTexture(noteName: string, hexColor: string): THREE.CanvasTexture {
    const key = `${noteName}:${hexColor}`;
    const cached = this.labelTextureCache.get(key);
    if (cached) return cached;

    // Evict cache cleanly if theme switching accumulates many entries
    if (this.labelTextureCache.size > 160) {
      for (const tex of this.labelTextureCache.values()) tex.dispose();
      this.labelTextureCache.clear();
    }

    const cw = 132;
    const ch = 66;
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d')!;

    const colorStr = `#${hexColor}`;
    const cut = 10;

    // Chamfered cyber tag background
    ctx.clearRect(0, 0, cw, ch);
    ctx.beginPath();
    ctx.moveTo(cut + 4, 6);
    ctx.lineTo(cw - 6, 6);
    ctx.lineTo(cw - 6, ch - cut - 4);
    ctx.lineTo(cw - cut - 4, ch - 6);
    ctx.lineTo(6, ch - 6);
    ctx.lineTo(6, cut + 4);
    ctx.closePath();

    ctx.fillStyle = 'rgba(5, 9, 18, 0.82)';
    ctx.fill();

    // Glowing pitch-colored border + left accent bar
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = colorStr;
    ctx.stroke();

    ctx.fillStyle = colorStr;
    ctx.fillRect(12, 16, 4, ch - 32);

    // Crisp monospaced note text
    ctx.font = '700 29px "SF Mono", "JetBrains Mono", Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = colorStr;
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#f4f9ff';
    ctx.fillText(noteName, cw * 0.54, ch * 0.52);

    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this.labelTextureCache.set(key, tex);
    return tex;
  }

  private drawLoopRing(loop: LoopRenderSnapshot, nowMs: number): void {
    const cx = this.width - Math.min(76, Math.max(54, this.width * 0.065));
    const cy = this.height * 0.5;
    const radius = Math.min(42, Math.max(28, Math.min(this.width, this.height) * 0.044));

    const isRec = loop.state === 'recording' || loop.state === 'overdub';
    const isCount = loop.state === 'count_in';
    const [tr, tg, tb] = this.theme.trailColor;

    const ar = isRec ? 1.0 : isCount ? 1.0 : tr;
    const ag = isRec ? 0.24 : isCount ? 0.72 : tg;
    const ab = isRec ? 0.36 : isCount ? 0.18 : tb;

    const trackGlow = 0.22 + loop.beatPulse * 0.25;
    this.pushRing(cx, cy, radius, 1.4, ar * trackGlow, ag * trackGlow, ab * trackGlow, 48);

    const totalBeats = isCount ? 4 : loop.bars * 4;
    for (let i = 0; i < totalBeats; i++) {
      const ang = Math.PI * 0.5 - (i / totalBeats) * Math.PI * 2;
      const isBar = i % 4 === 0;
      const rIn = radius - (isBar ? 7.5 : 4);
      const rOut = radius + (isBar ? 3.5 : 1.5);
      const alpha = isBar ? 0.52 + loop.beatPulse * 0.35 : 0.24;
      this.pushSegment(
        cx + Math.cos(ang) * rIn,
        cy + Math.sin(ang) * rIn,
        cx + Math.cos(ang) * rOut,
        cy + Math.sin(ang) * rOut,
        isBar ? 1.6 : 1.0,
        ar * alpha,
        ag * alpha,
        ab * alpha
      );
    }

    const activePhase = loop.state === 'idle' ? 0 : Math.max(0.015, loop.phase);
    if (activePhase > 0.005) {
      const arcSegs = Math.max(4, Math.round(activePhase * 56));
      let prevX = cx;
      let prevY = cy + radius;
      const arcBoost = 0.9 + loop.beatPulse * 0.55;
      for (let i = 1; i <= arcSegs; i++) {
        const f = (i / arcSegs) * activePhase;
        const ang = Math.PI * 0.5 - f * Math.PI * 2;
        const x = cx + Math.cos(ang) * radius;
        const y = cy + Math.sin(ang) * radius;
        const tailFade = 0.35 + 0.65 * (i / arcSegs);
        this.pushSegment(
          prevX,
          prevY,
          x,
          y,
          2.8 + (i === arcSegs ? 1.0 : 0),
          ar * arcBoost * tailFade,
          ag * arcBoost * tailFade,
          ab * arcBoost * tailFade
        );
        prevX = x;
        prevY = y;
      }

      this.pushFilledCircle(prevX, prevY, 3.8 + loop.beatPulse * 1.4, ar * 1.7, ag * 1.7, ab * 1.7, 10);
    }

    const pipRadius = radius + 9.5;
    for (const ev of loop.events) {
      const ang = Math.PI * 0.5 - ev.phase * Math.PI * 2;
      const px = cx + Math.cos(ang) * pipRadius;
      const py = cy + Math.sin(ang) * pipRadius;
      const ageMs = nowMs - ev.lastFiredMs;
      const flash = ageMs >= 0 && ageMs < 360 ? Math.pow(1 - ageMs / 360, 1.7) : 0;
      const c = samplePitchColor(this.theme, ev.pitchNorm, this.scratchColor);
      const gain = 0.45 + flash * 1.75;
      const dotR = 2.0 + flash * 3.0;
      this.pushFilledCircle(px, py, dotR, c.r * gain, c.g * gain, c.b * gain, 8);
    }

    const centerR = 4.2 + loop.beatPulse * 5.2;
    const centerAlpha = 0.35 + loop.beatPulse * 1.05;
    this.pushFilledCircle(cx, cy, centerR, ar * centerAlpha, ag * centerAlpha, ab * centerAlpha, 14);
    if (loop.beatPulse > 0.15) {
      this.pushRing(
        cx,
        cy,
        radius * (0.35 + (1 - loop.beatPulse) * 0.5),
        1.2,
        ar * loop.beatPulse * 0.8,
        ag * loop.beatPulse * 0.8,
        ab * loop.beatPulse * 0.8,
        24
      );
    }
  }

  private drawResonanceArc(pair: ResonancePair, audio: AudioReactiveMetrics): void {
    const x1 = pair.pA.x * this.width;
    const y1 = (1 - pair.pA.y) * this.height;
    const x2 = pair.pB.x * this.width;
    const y2 = (1 - pair.pB.y) * this.height;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 10) return;

    const nx = -dy / len;
    const ny = dx / len;
    const c = samplePitchColor(this.theme, pair.pitchNorm, this.scratchColor);
    const intensity = pair.strength * (0.65 + audio.rms * 0.7) * this.theme.hdrBoost * 0.55;

    const steps = 20;
    let px = x1;
    let py = y1;
    const bow = Math.sin(this.elapsedSec * 5 + pair.aId) * Math.min(40, len * 0.14);

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const env = Math.sin(t * Math.PI);
      const zig =
        Math.sin(t * 26 + this.elapsedSec * 36 + pair.bId * 3) *
        (this.theme.arcJitter * 7 + 1.5) *
        pair.strength *
        env;
      const cx = x1 + dx * t + nx * (bow * env + zig);
      const cy = y1 + dy * t + ny * (bow * env + zig);
      this.pushSegment(px, py, cx, cy, 2.0 * pair.strength + 0.9, c.r * intensity, c.g * intensity, c.b * intensity);
      px = cx;
      py = cy;
    }
  }

  private drawHand(hand: TrackedHand): void {
    const lm = hand.landmarks;
    if (lm.length < 21) return;

    const toPx = (idx: number): [number, number] => [
      lm[idx].x * this.width,
      (1 - lm[idx].y) * this.height,
    ];

    if (this.cameraFilterMode === 'xray') {
      drawXrayHandSkeleton(this.xraySink, hand, {
        width: this.width,
        height: this.height,
        videoAspect: this.videoAspect,
      });
    } else if (this.handVisual === 'classic') {
      for (const [a, b] of HAND_CONNECTIONS) {
        const [ax, ay] = toPx(a);
        const [bx, by] = toPx(b);
        this.pushSegment(ax, ay, bx, by, 2.6, 0.14, 1.05, 0.24);
      }
      for (let i = 0; i < 21; i++) {
        const [x, y] = toPx(i);
        this.pushFilledCircle(x, y, 4.2, 1.35, 0.15, 0.15, 10);
      }
    } else if (this.handVisual === 'hologram') {
      const [lr, lg, lb] = this.theme.handLineColor;
      const [jr, jg, jb] = this.theme.handJointColor;
      for (const [a, b] of HAND_CONNECTIONS) {
        const [ax, ay] = toPx(a);
        const [bx, by] = toPx(b);
        this.pushSegment(ax, ay, bx, by, 1.8, lr * 0.42, lg * 0.42, lb * 0.42);
      }
      for (let i = 0; i < 21; i++) {
        const [x, y] = toPx(i);
        this.pushFilledCircle(x, y, 2.6, jr * 0.55, jg * 0.55, jb * 0.55, 8);
      }
    }

    for (const tipIdx of hand.extendedFingers) {
      if (hand.pinchActive && (tipIdx === 4 || tipIdx === 8)) continue;
      const [x, y] = toPx(tipIdx);
      this.pushRing(x, y, 9.5, 2.0, 1.45, 1.55, 1.65, 16);
      this.pushFilledCircle(x, y, 3.2, 1.6, 1.7, 1.8, 10);
    }

    if (hand.pinchActive) {
      const px = hand.pinchPos.x * this.width;
      const py = (1 - hand.pinchPos.y) * this.height;
      const [pr, pg, pb] = this.theme.pinchRingColor;
      this.pushRing(px, py, 14, 2.8, pr * 2.1, pg * 2.1, pb * 2.1, 20);
      this.pushFilledCircle(px, py, 4.2, 1.9, 1.7, 1.1, 10);
    }

    if (hand.openPalm) {
      const px = hand.palmCenter.x * this.width;
      const py = (1 - hand.palmCenter.y) * this.height;
      this.pushRing(px, py, 24, 1.5, 0.55, 0.72, 0.95, 24);
    }
  }

  private updateAndDrawTrails(hands: TrackedHand[], pointerPos: Vec2 | null, dtSec: number): void {
    const activeIds = new Set<string>();

    const record = (id: string, pos: Vec2, speed: number) => {
      activeIds.add(id);
      let list = this.trails.get(id);
      if (!list) {
        list = [];
        this.trails.set(id, list);
      }
      const px = pos.x * this.width;
      const py = (1 - pos.y) * this.height;
      const last = list[list.length - 1];
      if (!last || Math.hypot(px - last.x, py - last.y) > 3.5) {
        list.push({ x: px, y: py, age: 0 });
        if (list.length > MAX_TRAIL_NODES) list.shift();
      }
      if (speed < 0.08 && list.length > 4) {
        list.shift();
      }
    };

    for (const hand of hands) {
      if (hand.pinchActive) continue;
      for (const f of hand.activeFingers) {
        record(f.id, f.pos, f.speed);
      }
    }
    if (pointerPos && hands.length === 0) {
      record('pointer', pointerPos, 0.4);
    }

    const [tr, tg, tb] = this.theme.trailColor;
    const maxAge = this.theme.stringStyle === 'silk' ? 0.34 : 0.24;

    for (const [id, list] of this.trails.entries()) {
      for (const node of list) {
        node.age += dtSec;
      }
      while (list.length > 0 && list[0].age > maxAge) {
        list.shift();
      }
      if (list.length === 0 && !activeIds.has(id)) {
        this.trails.delete(id);
        continue;
      }
      if (list.length < 2) continue;

      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1];
        const b = list[i];
        const lifeFrac = Math.max(0, 1 - b.age / maxAge);
        const tFrac = i / list.length;
        const w = (this.theme.stringStyle === 'silk' ? 2.2 : 1.2) + lifeFrac * tFrac * 5.6;
        const alpha = lifeFrac * lifeFrac * tFrac * 0.95;
        this.pushSegment(a.x, a.y, b.x, b.y, w, tr * alpha, tg * alpha, tb * alpha);
      }
    }
  }

  private updateAndDrawShockwaves(dtSec: number): void {
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const sw = this.shockwaves[i];
      sw.life += dtSec;
      if (sw.life >= sw.maxLife) {
        this.shockwaves.splice(i, 1);
        continue;
      }
      sw.angle += sw.rotSpeed * dtSec;
      const t = sw.life / sw.maxLife;
      const eased = 1 - Math.pow(1 - t, 3);
      const curR = sw.radius + (sw.maxRadius - sw.radius) * eased;
      const fade = Math.pow(1 - t, 1.75);
      const r = sw.r * fade;
      const g = sw.g * fade;
      const b = sw.b * fade;
      const thick = 1.2 + fade * 2.4;

      if (sw.shape === 'hex') {
        // Cyber rotating hexagon + inner counter-rotating diamond reticle
        this.pushPolygonRing(sw.x, sw.y, curR, thick, r, g, b, 6, sw.angle);
        this.pushPolygonRing(sw.x, sw.y, curR * 0.62, thick * 0.75, r * 0.7, g * 0.7, b * 0.7, 4, -sw.angle * 1.3);
      } else if (sw.shape === 'ink') {
        // Triple concentric organic ink-wash ripples
        this.pushOrganicRing(sw.x, sw.y, curR, thick * 1.15, r * 0.9, g * 0.9, b * 0.9, sw.angle);
        this.pushOrganicRing(sw.x, sw.y, curR * 0.68, thick * 0.7, r * 0.55, g * 0.55, b * 0.55, -sw.angle);
        this.pushOrganicRing(sw.x, sw.y, curR * 0.38, thick * 0.5, r * 0.4, g * 0.4, b * 0.4, sw.angle * 0.5);
      } else if (sw.shape === 'sigil') {
        // Celestial counter-rotating dual magic circle + 6-point star sigil
        this.pushRing(sw.x, sw.y, curR, thick * 0.85, r, g, b, 32);
        this.pushPolygonRing(sw.x, sw.y, curR * 0.94, thick * 0.72, r * 0.85, g * 0.85, b * 0.85, 3, sw.angle);
        this.pushPolygonRing(sw.x, sw.y, curR * 0.94, thick * 0.72, r * 0.85, g * 0.85, b * 0.85, 3, sw.angle + Math.PI);
        this.pushRing(sw.x, sw.y, curR * 0.48, thick * 0.55, r * 0.6, g * 0.6, b * 0.6, 20);
      } else if (sw.shape === 'flare') {
        // Synthwave cinematic Anamorphic horizontal lens flare + diamond core
        const spanX = curR * 2.8;
        const spanY = curR * 0.48;
        this.pushSegment(sw.x - spanX, sw.y, sw.x + spanX, sw.y, thick * 1.35, r * 1.1, g * 1.1, b * 1.1);
        this.pushSegment(sw.x - spanX * 0.55, sw.y, sw.x + spanX * 0.55, sw.y, thick * 2.2, r * 0.55, g * 0.55, b * 0.55);
        this.pushSegment(sw.x, sw.y - spanY, sw.x, sw.y + spanY, thick * 0.9, r * 0.85, g * 0.85, b * 0.85);
        this.pushPolygonRing(sw.x, sw.y, curR * 0.52, thick * 0.85, r * 0.8, g * 0.8, b * 0.8, 4, Math.PI * 0.25);
      } else {
        // Abyssal twin soft bioluminescent water rings
        this.pushRing(sw.x, sw.y, curR, thick, r, g, b, 30);
        this.pushRing(sw.x, sw.y, curR * 0.66, thick * 0.65, r * 0.55, g * 0.55, b * 0.55, 24);
      }
    }
  }

  private updateSparks(dtSec: number): void {
    const grav = this.theme.sparkGravity * this.height;
    const drag = Math.pow(this.theme.sparkDrag, dtSec * 60);
    const sway = this.theme.sparkSway;
    let activeCount = 0;

    for (let i = 0; i < MAX_SPARKS; i++) {
      const s = this.sparks[i];
      if (!s.alive) continue;
      s.life += dtSec;
      if (s.life >= s.maxLife) {
        s.alive = false;
        continue;
      }
      s.vx *= drag;
      s.vy = s.vy * drag - grav * dtSec; // negative grav rises upward!
      const swayVx = sway > 0 ? Math.sin(this.elapsedSec * (3.2 + s.seed * 3.0) + s.seed * 19.0) * sway : 0;
      s.x += (s.vx + swayVx) * dtSec;
      s.y += s.vy * dtSec;

      const fade = Math.pow(1 - s.life / s.maxLife, 1.55);
      const p3 = activeCount * 3;
      this.sparkPosArray[p3] = s.x;
      this.sparkPosArray[p3 + 1] = s.y;
      this.sparkPosArray[p3 + 2] = 0;

      this.sparkColArray[p3] = s.r * fade;
      this.sparkColArray[p3 + 1] = s.g * fade;
      this.sparkColArray[p3 + 2] = s.b * fade;
      this.sparkSizeArray[activeCount] = s.size * (0.48 + 0.52 * fade);
      this.sparkSeedArray[activeCount] = s.seed;
      activeCount++;
    }

    this.sparkGeo.setDrawRange(0, activeCount);
    this.sparkPosAttr.needsUpdate = true;
    this.sparkColAttr.needsUpdate = true;
    this.sparkSizeAttr.needsUpdate = true;
    this.sparkSeedAttr.needsUpdate = true;
  }

  // --- Low-level batched triangle primitives ---

  private pushSegment(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    thickness: number,
    r: number,
    g: number,
    b: number
  ): void {
    if (this.quadVertCount + 6 > MAX_VERTS) return;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 0.001) return;

    const half = thickness * 0.5;
    const nx = (-dy / len) * half;
    const ny = (dx / len) * half;

    this.pushTri(x1 + nx, y1 + ny, x2 + nx, y2 + ny, x2 - nx, y2 - ny, r, g, b);
    this.pushTri(x1 + nx, y1 + ny, x2 - nx, y2 - ny, x1 - nx, y1 - ny, r, g, b);
  }

  private pushRing(
    cx: number,
    cy: number,
    radius: number,
    thickness: number,
    r: number,
    g: number,
    b: number,
    segments: number
  ): void {
    this.pushPolygonRing(cx, cy, radius, thickness, r, g, b, segments, 0);
  }

  private pushPolygonRing(
    cx: number,
    cy: number,
    radius: number,
    thickness: number,
    r: number,
    g: number,
    b: number,
    sides: number,
    rotOffset: number
  ): void {
    let prevX = cx + Math.cos(rotOffset) * radius;
    let prevY = cy + Math.sin(rotOffset) * radius;
    for (let i = 1; i <= sides; i++) {
      const ang = rotOffset + (i / sides) * Math.PI * 2;
      const x = cx + Math.cos(ang) * radius;
      const y = cy + Math.sin(ang) * radius;
      this.pushSegment(prevX, prevY, x, y, thickness, r, g, b);
      prevX = x;
      prevY = y;
    }
  }

  private pushOrganicRing(
    cx: number,
    cy: number,
    radius: number,
    thickness: number,
    r: number,
    g: number,
    b: number,
    phase: number
  ): void {
    const segs = 28;
    const radAt = (ang: number) =>
      radius * (1 + 0.06 * Math.sin(ang * 3 + phase) + 0.04 * Math.cos(ang * 5 - phase * 1.4));
    let r0 = radAt(0);
    let prevX = cx + r0;
    let prevY = cy;
    for (let i = 1; i <= segs; i++) {
      const ang = (i / segs) * Math.PI * 2;
      const rr = radAt(ang);
      const x = cx + Math.cos(ang) * rr;
      const y = cy + Math.sin(ang) * rr;
      this.pushSegment(prevX, prevY, x, y, thickness, r, g, b);
      prevX = x;
      prevY = y;
    }
  }

  private pushFilledCircle(
    cx: number,
    cy: number,
    radius: number,
    r: number,
    g: number,
    b: number,
    segments: number
  ): void {
    let prevX = cx + radius;
    let prevY = cy;
    for (let i = 1; i <= segments; i++) {
      const ang = (i / segments) * Math.PI * 2;
      const x = cx + Math.cos(ang) * radius;
      const y = cy + Math.sin(ang) * radius;
      this.pushTri(cx, cy, prevX, prevY, x, y, r, g, b);
      prevX = x;
      prevY = y;
    }
  }

  private pushTri(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
    r: number,
    g: number,
    b: number
  ): void {
    if (this.quadVertCount + 3 > MAX_VERTS) return;
    const o = this.quadVertCount * 3;
    const p = this.posArray;
    const c = this.colArray;

    p[o] = x1; p[o + 1] = y1; p[o + 2] = 0;
    p[o + 3] = x2; p[o + 4] = y2; p[o + 5] = 0;
    p[o + 6] = x3; p[o + 7] = y3; p[o + 8] = 0;

    c[o] = r; c[o + 1] = g; c[o + 2] = b;
    c[o + 3] = r; c[o + 4] = g; c[o + 5] = b;
    c[o + 6] = r; c[o + 7] = g; c[o + 8] = b;

    this.quadVertCount += 3;
  }

  private buildMatrixGlyphAtlas(): THREE.CanvasTexture {
    const size = 512;
    const cell = size / 8;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, size, size);

    // 64 iconic Matrix digital-rain glyphs (half-width Katakana + digits + symbols)
    const glyphs =
      'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789Z:=*+<>¦日';

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 44px "JetBrains Mono", "Hiragino Kaku Gothic ProN", "Yu Gothic", monospace';

    for (let i = 0; i < 64; i++) {
      const gx = i % 8;
      const gy = Math.floor(i / 8);
      const cx = gx * cell + cell * 0.5;
      const cy = gy * cell + cell * 0.53;
      const ch = glyphs[i % glyphs.length];

      ctx.save();
      ctx.translate(cx, cy);
      // Mirror half of the katakana glyphs horizontally just like the iconic 1999 Matrix rain!
      if (i < 45 && i % 2 === 1) {
        ctx.scale(-1, 1);
      }
      ctx.shadowColor = 'rgba(255,255,255,0.65)';
      ctx.shadowBlur = 4;
      ctx.fillText(ch, 0, 0);
      ctx.restore();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  dispose(): void {
    this.videoTexture?.dispose();
    this.customBgTexture?.dispose();
    this.matrixAtlasTexture.dispose();
    this.segTexture?.dispose();
    for (const tex of this.labelTextureCache.values()) tex.dispose();
    this.labelTextureCache.clear();
    this.bgTarget.dispose();
    this.fxComposer.dispose();
    this.dynGeo.dispose();
    this.sparkGeo.dispose();
    this.skullRig.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
