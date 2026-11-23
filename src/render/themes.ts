import * as THREE from 'three';
import type { ParticleShape, ShockwaveShape, ThemeId } from '../types';

export interface ThemeConfig {
  id: ThemeId;
  label: string;
  code: string; // cyber HUD tactical code
  subtitle: string;
  bgStyleIndex: number; // 0: plasma, 1: ink, 2: abyss, 3: celestial, 4: synthwave
  particleShape: ParticleShape;
  shockwaveShape: ShockwaveShape;
  stringStyle: 'arc' | 'silk' | 'liquid' | 'starlight' | 'laser';
  // Rich 6-stop HDR pitch palette from lowest bass (0) to highest treble (1)
  pitchPalette: [number, number, number][]; // RGB in 0..1
  idleStringColor: [number, number, number];
  previewColor: [number, number, number];
  pinchRingColor: [number, number, number];
  deleteWarnColor: [number, number, number];
  handLineColor: [number, number, number];
  handJointColor: [number, number, number];
  trailColor: [number, number, number];
  // Background shader colors
  bgDarkTint: [number, number, number];
  starColor: [number, number, number];
  rimColor: [number, number, number];
  cyberEdgeColor: [number, number, number];
  // Bloom & physics styling
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  arcJitter: number; // high-energy crackle intensity
  hdrBoost: number; // >1.0 pushes luminance into UnrealBloom
  sparkGravity: number; // positive = falls down, negative = rises up (bubbles!)
  sparkDrag: number;
  sparkSway: number; // gentle horizontal drift/wobble (petals / bubbles)
}

export const THEMES: Record<ThemeId, ThemeConfig> = {
  plasma: {
    id: 'plasma',
    label: '赛博脉冲',
    code: 'SYS.PLASMA',
    subtitle: '高压电弧 · 六角脉框',
    bgStyleIndex: 0,
    particleShape: 'spark',
    shockwaveShape: 'hex',
    stringStyle: 'arc',
    pitchPalette: [
      [0.24, 0.42, 1.0], // deep bass: neon cobalt
      [0.06, 0.86, 1.0], // low-mid: electric cyan
      [0.14, 1.0, 0.58], // mid: cyber emerald
      [0.98, 0.90, 0.18], // upper-mid: plasma gold
      [1.0, 0.42, 0.22], // high: laser orange
      [1.0, 0.18, 0.76], // treble: hot magenta
    ],
    idleStringColor: [0.80, 0.94, 1.0],
    previewColor: [0.92, 0.97, 1.0],
    pinchRingColor: [1.0, 0.66, 0.16],
    deleteWarnColor: [1.0, 0.16, 0.28],
    handLineColor: [0.16, 0.90, 1.0],
    handJointColor: [0.76, 0.97, 1.0],
    trailColor: [0.22, 0.94, 1.0],
    bgDarkTint: [0.022, 0.042, 0.095],
    starColor: [0.26, 0.86, 1.0],
    rimColor: [0.16, 0.88, 1.0],
    cyberEdgeColor: [0.16, 0.94, 1.0],
    bloomStrength: 0.86,
    bloomRadius: 0.44,
    bloomThreshold: 0.58,
    arcJitter: 1.05,
    hdrBoost: 2.1,
    sparkGravity: 0.52,
    sparkDrag: 0.982,
    sparkSway: 0.0,
  },
  ink: {
    id: 'ink',
    label: '水墨丹青',
    code: 'ART.INK',
    subtitle: '鎏金蚕丝 · 宣纸金箔',
    bgStyleIndex: 1,
    particleShape: 'petal',
    shockwaveShape: 'ink',
    stringStyle: 'silk',
    pitchPalette: [
      [0.22, 0.58, 0.78], // mineral azurite (石青)
      [0.18, 0.84, 0.68], // celadon jade (石绿)
      [0.74, 0.92, 0.46], // bamboo leaf (竹青)
      [1.0, 0.82, 0.32], // imperial gold leaf (鎏金)
      [1.0, 0.50, 0.20], // warm ochre amber (赭石)
      [1.0, 0.26, 0.24], // cinnabar seal (朱砂)
    ],
    idleStringColor: [0.96, 0.90, 0.78],
    previewColor: [1.0, 0.88, 0.62],
    pinchRingColor: [1.0, 0.34, 0.24],
    deleteWarnColor: [1.0, 0.20, 0.16],
    handLineColor: [0.96, 0.76, 0.40],
    handJointColor: [1.0, 0.94, 0.82],
    trailColor: [1.0, 0.80, 0.42],
    bgDarkTint: [0.072, 0.060, 0.048],
    starColor: [0.96, 0.78, 0.44],
    rimColor: [1.0, 0.74, 0.36],
    cyberEdgeColor: [0.98, 0.78, 0.40],
    bloomStrength: 0.72,
    bloomRadius: 0.48,
    bloomThreshold: 0.60,
    arcJitter: 0.06,
    hdrBoost: 1.9,
    sparkGravity: 0.10,
    sparkDrag: 0.972,
    sparkSway: 72.0,
  },
  abyss: {
    id: 'abyss',
    label: '深海幻光',
    code: 'BIO.ABYSS',
    subtitle: '水波焦散 · 上浮荧光泡',
    bgStyleIndex: 2,
    particleShape: 'bubble',
    shockwaveShape: 'ripple',
    stringStyle: 'liquid',
    pitchPalette: [
      [0.24, 0.36, 1.0], // trench indigo
      [0.08, 0.72, 1.0], // pelagic cerulean
      [0.08, 0.98, 0.84], // bioluminescent aqua
      [0.34, 1.0, 0.56], // kelp biogreen
      [0.64, 0.56, 1.0], // jellyfish violet
      [1.0, 0.52, 0.84], // coral anemone rose
    ],
    idleStringColor: [0.76, 0.96, 1.0],
    previewColor: [0.32, 0.96, 0.92],
    pinchRingColor: [0.24, 1.0, 0.84],
    deleteWarnColor: [1.0, 0.32, 0.42],
    handLineColor: [0.22, 0.96, 0.86],
    handJointColor: [0.80, 1.0, 0.96],
    trailColor: [0.20, 0.96, 0.88],
    bgDarkTint: [0.012, 0.052, 0.092],
    starColor: [0.18, 0.90, 0.88],
    rimColor: [0.20, 1.0, 0.86],
    cyberEdgeColor: [0.18, 0.92, 0.92],
    bloomStrength: 0.84,
    bloomRadius: 0.56,
    bloomThreshold: 0.56,
    arcJitter: 0.04,
    hdrBoost: 1.95,
    sparkGravity: -0.24, // buoyant bubbles rising upward!
    sparkDrag: 0.968,
    sparkSway: 56.0,
  },
  celestial: {
    id: 'celestial',
    label: '星穹法阵',
    code: 'AST.SIGIL',
    subtitle: '极光帷幕 · 旋转星芒阵',
    bgStyleIndex: 3,
    particleShape: 'star',
    shockwaveShape: 'sigil',
    stringStyle: 'starlight',
    pitchPalette: [
      [0.24, 0.48, 1.0], // sapphire cosmos
      [0.12, 0.96, 0.86], // glacier cyan
      [0.32, 1.0, 0.58], // aurora emerald
      [0.98, 0.86, 0.44], // starlight gold
      [0.72, 0.38, 1.0], // astral violet
      [1.0, 0.42, 0.84], // nebula rose
    ],
    idleStringColor: [0.86, 0.95, 1.0],
    previewColor: [0.74, 0.98, 1.0],
    pinchRingColor: [0.54, 1.0, 0.86],
    deleteWarnColor: [1.0, 0.24, 0.46],
    handLineColor: [0.58, 0.84, 1.0],
    handJointColor: [0.92, 0.96, 1.0],
    trailColor: [0.52, 1.0, 0.88],
    bgDarkTint: [0.022, 0.036, 0.092],
    starColor: [0.52, 0.92, 1.0],
    rimColor: [0.36, 1.0, 0.84],
    cyberEdgeColor: [0.64, 0.56, 1.0],
    bloomStrength: 0.92,
    bloomRadius: 0.52,
    bloomThreshold: 0.56,
    arcJitter: 0.36,
    hdrBoost: 2.05,
    sparkGravity: 0.03,
    sparkDrag: 0.984,
    sparkSway: 18.0,
  },
  synthwave: {
    id: 'synthwave',
    label: '复古合成波',
    code: 'VHS.1984',
    subtitle: '落日地平线 · 横向炫光',
    bgStyleIndex: 4,
    particleShape: 'pixel',
    shockwaveShape: 'flare',
    stringStyle: 'laser',
    pitchPalette: [
      [0.10, 0.92, 1.0], // laser cyan
      [0.44, 0.46, 1.0], // electric cobalt
      [0.78, 0.24, 1.0], // outrun purple
      [1.0, 0.16, 0.62], // neon magenta
      [1.0, 0.44, 0.24], // sunset coral
      [1.0, 0.84, 0.22], // horizon chrome gold
    ],
    idleStringColor: [1.0, 0.82, 0.94],
    previewColor: [1.0, 0.44, 0.78],
    pinchRingColor: [1.0, 0.72, 0.20],
    deleteWarnColor: [1.0, 0.14, 0.28],
    handLineColor: [1.0, 0.28, 0.68],
    handJointColor: [0.24, 0.96, 1.0],
    trailColor: [1.0, 0.36, 0.74],
    bgDarkTint: [0.062, 0.016, 0.092],
    starColor: [1.0, 0.28, 0.72],
    rimColor: [1.0, 0.30, 0.70],
    cyberEdgeColor: [1.0, 0.26, 0.68],
    bloomStrength: 0.94,
    bloomRadius: 0.48,
    bloomThreshold: 0.56,
    arcJitter: 0.60,
    hdrBoost: 2.15,
    sparkGravity: 0.30,
    sparkDrag: 0.980,
    sparkSway: 0.0,
  },
};

const tmpA = new THREE.Color();
const tmpB = new THREE.Color();

export function samplePitchColor(
  theme: ThemeConfig,
  pitchNorm: number,
  out = new THREE.Color()
): THREE.Color {
  const stops = theme.pitchPalette;
  const clamped = Math.max(0, Math.min(1, pitchNorm));
  const scaled = clamped * (stops.length - 1);
  const i0 = Math.floor(scaled);
  const i1 = Math.min(stops.length - 1, i0 + 1);
  const t = scaled - i0;
  tmpA.setRGB(stops[i0][0], stops[i0][1], stops[i0][2]);
  tmpB.setRGB(stops[i1][0], stops[i1][1], stops[i1][2]);
  return out.copy(tmpA).lerp(tmpB, t);
}
