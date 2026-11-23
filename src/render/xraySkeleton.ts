import type { PoseLandmark, TrackedHand, TrackedPose } from '../types';

export interface XrayDrawSink {
  pushTri(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
    r: number,
    g: number,
    b: number
  ): void;
  pushSegment(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    thickness: number,
    r: number,
    g: number,
    b: number
  ): void;
  pushRing(
    cx: number,
    cy: number,
    radius: number,
    thickness: number,
    r: number,
    g: number,
    b: number,
    segments: number
  ): void;
  pushFilledCircle(
    cx: number,
    cy: number,
    radius: number,
    r: number,
    g: number,
    b: number,
    segments: number
  ): void;
}

export interface StageProjection {
  width: number;
  height: number;
  videoAspect: number;
}

interface Pt {
  x: number;
  y: number;
}

// Radiographic HDR additive palette (marrow translucent cyan -> cortical ice-white)
const MARROW: [number, number, number] = [0.055, 0.21, 0.34];
const BONE: [number, number, number] = [0.20, 0.50, 0.68];
const CORTEX: [number, number, number] = [0.56, 0.86, 1.02];
const PEAK: [number, number, number] = [0.76, 0.96, 1.12];

const HAND_BONE_CHAINS: [number, number, number, number][] = [
  // [startIdx, endIdx, shaftScale, headScale]
  // Thumb
  [0, 1, 0.14, 0.20],
  [1, 2, 0.13, 0.19],
  [2, 3, 0.11, 0.16],
  [3, 4, 0.085, 0.12],
  // Index
  [0, 5, 0.11, 0.17],
  [5, 6, 0.105, 0.155],
  [6, 7, 0.09, 0.135],
  [7, 8, 0.072, 0.105],
  // Middle
  [0, 9, 0.115, 0.175],
  [9, 10, 0.11, 0.16],
  [10, 11, 0.092, 0.138],
  [11, 12, 0.074, 0.108],
  // Ring
  [0, 13, 0.105, 0.165],
  [13, 14, 0.10, 0.148],
  [14, 15, 0.085, 0.128],
  [15, 16, 0.068, 0.098],
  // Pinky
  [0, 17, 0.095, 0.15],
  [17, 18, 0.088, 0.132],
  [18, 19, 0.076, 0.114],
  [19, 20, 0.062, 0.09],
];

/**
 * Inverse of BG_FRAG's coverUvForAspect(), mapping normalized mirrored video coordinates
 * (x in [0,1] left->right, y in [0,1] top->bottom) into fxCamera pixel space
 * (x in [0,width], y in [0,height] bottom->top) so the skeleton aligns pixel-for-pixel
 * inside the webcam X-ray silhouette at any viewport aspect ratio.
 */
export function videoNormToStagePx(
  lx: number,
  ly: number,
  proj: StageProjection
): Pt {
  const screenAspect = proj.width / Math.max(1, proj.height);
  const videoAspect = Math.max(0.2, proj.videoAspect);

  let uvX: number;
  let uvY: number;

  if (screenAspect > videoAspect) {
    // Video cropped top/bottom -> expand Y
    uvX = lx;
    uvY = 0.5 + (0.5 - ly) * (screenAspect / videoAspect);
  } else {
    // Video cropped left/right -> expand X
    uvX = 0.5 + (lx - 0.5) * (videoAspect / screenAspect);
    uvY = 1.0 - ly;
  }

  return {
    x: uvX * proj.width,
    y: uvY * proj.height,
  };
}

function add(a: Pt, b: Pt): Pt {
  return { x: a.x + b.x, y: a.y + b.y };
}

function sub(a: Pt, b: Pt): Pt {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scale(v: Pt, s: number): Pt {
  return { x: v.x * s, y: v.y * s };
}

function lerpPt(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function normalize(v: Pt, fallback: Pt): Pt {
  const l = Math.hypot(v.x, v.y);
  if (l < 1e-4) return fallback;
  return { x: v.x / l, y: v.y / l };
}

function dot(a: Pt, b: Pt): number {
  return a.x * b.x + a.y * b.y;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function quadBezier(p0: Pt, p1: Pt, p2: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

function cubicBezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  const uu = u * u;
  const tt = t * t;
  return {
    x: uu * u * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + tt * t * p3.x,
    y: uu * u * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + tt * t * p3.y,
  };
}

/**
 * Renders a tapered anatomical long bone with flared epiphysis condyles at both ends,
 * translucent icy-cyan marrow body, and luminous bone-white cortical walls.
 */
function drawAnatomicalBone(
  sink: XrayDrawSink,
  a: Pt,
  b: Pt,
  shaftR: number,
  headR: number,
  intensity = 1.0
): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 3) return;

  const tx = dx / len;
  const ty = dy / len;
  const nx = -ty;
  const ny = tx;

  // 6 stations along bone shaft: rounded cap -> flared condyle -> concave diaphysis -> condyle -> cap
  const stations: [number, number][] = [
    [0.0, headR * 0.52],
    [0.11, headR * 1.06],
    [0.29, shaftR * 0.9],
    [0.71, shaftR * 0.9],
    [0.89, headR * 1.06],
    [1.0, headR * 0.52],
  ];

  const leftPts: Pt[] = [];
  const rightPts: Pt[] = [];
  for (const [u, r] of stations) {
    const cx = a.x + dx * u;
    const cy = a.y + dy * u;
    leftPts.push({ x: cx + nx * r, y: cy + ny * r });
    rightPts.push({ x: cx - nx * r, y: cy - ny * r });
  }

  // 1. Translucent marrow body fill
  const mr = MARROW[0] * intensity;
  const mg = MARROW[1] * intensity;
  const mb = MARROW[2] * intensity;
  for (let i = 0; i < stations.length - 1; i++) {
    const l0 = leftPts[i];
    const l1 = leftPts[i + 1];
    const r0 = rightPts[i];
    const r1 = rightPts[i + 1];
    sink.pushTri(l0.x, l0.y, l1.x, l1.y, r1.x, r1.y, mr, mg, mb);
    sink.pushTri(l0.x, l0.y, r1.x, r1.y, r0.x, r0.y, mr, mg, mb);
  }

  // 2. Crisp bright cortical outer bone walls (the iconic hollow X-ray bone look!)
  const wallThick = clamp(shaftR * 0.42, 1.3, 3.4);
  const cr = CORTEX[0] * intensity;
  const cg = CORTEX[1] * intensity;
  const cb = CORTEX[2] * intensity;
  for (let i = 0; i < stations.length - 1; i++) {
    const isEnd = i === 0 || i === stations.length - 2;
    const w = isEnd ? wallThick * 0.92 : wallThick;
    sink.pushSegment(leftPts[i].x, leftPts[i].y, leftPts[i + 1].x, leftPts[i + 1].y, w, cr, cg, cb);
    sink.pushSegment(rightPts[i].x, rightPts[i].y, rightPts[i + 1].x, rightPts[i + 1].y, w, cr, cg, cb);
  }

  // 3. Rounded articular bone end caps (double condyle hints at wide ends)
  const capOffset = Math.min(len * 0.04, headR * 0.28);
  sink.pushSegment(
    leftPts[0].x,
    leftPts[0].y,
    a.x - tx * capOffset,
    a.y - ty * capOffset,
    wallThick * 0.85,
    cr,
    cg,
    cb
  );
  sink.pushSegment(
    rightPts[0].x,
    rightPts[0].y,
    a.x - tx * capOffset,
    a.y - ty * capOffset,
    wallThick * 0.85,
    cr,
    cg,
    cb
  );
  const last = stations.length - 1;
  sink.pushSegment(
    leftPts[last].x,
    leftPts[last].y,
    b.x + tx * capOffset,
    b.y + ty * capOffset,
    wallThick * 0.85,
    cr,
    cg,
    cb
  );
  sink.pushSegment(
    rightPts[last].x,
    rightPts[last].y,
    b.x + tx * capOffset,
    b.y + ty * capOffset,
    wallThick * 0.85,
    cr,
    cg,
    cb
  );
}

/**
 * Draws a curved radiographic rib or bone arch with translucent core + bright cortical highlight.
 */
function drawCurvedBone(
  sink: XrayDrawSink,
  pts: Pt[],
  thickness: number,
  intensity: number,
  taperEnds = true
): void {
  if (pts.length < 2) return;
  const br = BONE[0] * intensity;
  const bg = BONE[1] * intensity;
  const bb = BONE[2] * intensity;
  const cr = CORTEX[0] * intensity;
  const cg = CORTEX[1] * intensity;
  const cb = CORTEX[2] * intensity;

  for (let i = 0; i < pts.length - 1; i++) {
    const u = (i + 0.5) / (pts.length - 1);
    const taper = taperEnds ? 0.65 + 0.35 * Math.sin(u * Math.PI) : 1.0;
    const w = thickness * taper;
    sink.pushSegment(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, w, br, bg, bb);
    sink.pushSegment(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, w * 0.38, cr, cg, cb);
  }
}

/**
 * Draws a glowing anatomical joint capsule (shoulder ball, elbow hinge, hip socket, knee patella).
 */
function drawJoint(
  sink: XrayDrawSink,
  p: Pt,
  radius: number,
  intensity = 1.0
): void {
  sink.pushFilledCircle(
    p.x,
    p.y,
    radius * 0.82,
    MARROW[0] * intensity * 1.1,
    MARROW[1] * intensity * 1.1,
    MARROW[2] * intensity * 1.1,
    12
  );
  sink.pushRing(
    p.x,
    p.y,
    radius,
    clamp(radius * 0.24, 1.3, 3.0),
    CORTEX[0] * intensity,
    CORTEX[1] * intensity,
    CORTEX[2] * intensity,
    16
  );
}

/**
 * Draws an anatomically sculpted X-Ray Skull aligned to head position, tilt (roll), and turn (yaw).
 * Uses hollow additive geometry so eye orbits and nasal cavity stay unmistakably dark & crisp!
 */
function drawXraySkull(
  sink: XrayDrawSink,
  lm: PoseLandmark[],
  toPx: (i: number) => Pt,
  shoulderW: number,
  fallbackRight: Pt,
  fallbackUp: Pt
): { skullBase: Pt; headH: number } {
  const nose = toPx(0);
  const eyeL = toPx(2);
  const eyeR = toPx(5);
  const earL = toPx(7);
  const earR = toPx(8);
  const mouthL = toPx(9);
  const mouthR = toPx(10);

  const eyeVis = Math.min(lm[2]?.visibility ?? 0, lm[5]?.visibility ?? 0);
  const earVis = Math.min(lm[7]?.visibility ?? 0, lm[8]?.visibility ?? 0);

  // Order eye/ear axes consistently viewer-left -> viewer-right
  let rawRight = fallbackRight;
  if (eyeVis > 0.35 && dist(eyeL, eyeR) > 6) {
    rawRight = eyeR.x >= eyeL.x ? sub(eyeR, eyeL) : sub(eyeL, eyeR);
  } else if (earVis > 0.35 && dist(earL, earR) > 10) {
    rawRight = earR.x >= earL.x ? sub(earR, earL) : sub(earL, earR);
  }
  const rx = normalize(rawRight, fallbackRight);
  let uy: Pt = { x: -rx.y, y: rx.x };
  if (dot(uy, fallbackUp) < 0) {
    uy = { x: -uy.x, y: -uy.y };
  }

  const eyeMid = eyeVis > 0.3 ? lerpPt(eyeL, eyeR, 0.5) : nose;
  const mouthMid =
    Math.min(lm[9]?.visibility ?? 0, lm[10]?.visibility ?? 0) > 0.3
      ? lerpPt(mouthL, mouthR, 0.5)
      : add(nose, scale(uy, -shoulderW * 0.14));

  const earSpan = earVis > 0.3 ? dist(earL, earR) : 0;
  const eyeSpan = eyeVis > 0.3 ? dist(eyeL, eyeR) : 0;
  const rawHeadW = Math.max(earSpan * 1.08, eyeSpan * 2.38, shoulderW * 0.42);
  const headW = clamp(rawHeadW, shoulderW * 0.36, shoulderW * 0.62);
  const headH = headW * 1.24;
  const hw = headW * 0.5;
  const hh = headH * 0.5;

  // Pseudo-3D yaw shift from nose offset relative to eye midpoint
  const yaw = clamp(dot(sub(nose, eyeMid), rx) / Math.max(12, hw), -0.45, 0.45);
  const center = add(eyeMid, scale(uy, hh * 0.14));

  const pt = (lx: number, ly: number): Pt =>
    add(add(center, scale(rx, lx * hw)), scale(uy, ly * hh));

  // 1. Outer Cranial Vault Dome (temple -> crown -> temple) — smoothly tapers into cheekbones!
  const vaultSegs = 22;
  const outerVault: Pt[] = [];
  const innerVault: Pt[] = [];
  for (let i = 0; i <= vaultSegs; i++) {
    const ang = -0.06 + (i / vaultSegs) * (Math.PI + 0.12);
    const cx = Math.cos(ang);
    const sy = Math.sin(ang);
    // Natural human cranium: rounded parietal fullness above, smooth temporal taper at base
    const rxScale = 0.86 + 0.14 * Math.pow(Math.max(0, sy), 0.55);
    const ryScale = sy >= 0 ? 1.03 : 0.65;
    outerVault.push(pt(cx * rxScale, sy * ryScale + 0.04));
    innerVault.push(pt(cx * (rxScale - 0.11), sy * (ryScale - 0.10) + 0.04));
  }
  // Soft translucent cranial vault interior glow (stays above eye sockets so orbits remain dark!)
  const crownCenter = pt(yaw * 0.12, 0.44);
  for (let i = 1; i < vaultSegs - 1; i++) {
    const n0 = innerVault[i];
    const n1 = innerVault[i + 1];
    sink.pushTri(crownCenter.x, crownCenter.y, n0.x, n0.y, n1.x, n1.y, MARROW[0] * 0.42, MARROW[1] * 0.42, MARROW[2] * 0.42);
  }
  // Translucent skull table thickness between outer & inner vault
  for (let i = 0; i < vaultSegs; i++) {
    const o0 = outerVault[i];
    const o1 = outerVault[i + 1];
    const n0 = innerVault[i];
    const n1 = innerVault[i + 1];
    sink.pushTri(o0.x, o0.y, o1.x, o1.y, n1.x, n1.y, BONE[0] * 0.85, BONE[1] * 0.85, BONE[2] * 0.85);
    sink.pushTri(o0.x, o0.y, n1.x, n1.y, n0.x, n0.y, BONE[0] * 0.85, BONE[1] * 0.85, BONE[2] * 0.85);
  }
  drawCurvedBone(sink, outerVault, clamp(headW * 0.042, 2.2, 5.2), 1.08, false);
  drawCurvedBone(sink, innerVault, clamp(headW * 0.022, 1.2, 2.8), 0.58, false);

  // Subtle cranial suture cross-glint near crown
  const suturePts = [pt(yaw * 0.18, 0.92), pt(yaw * 0.24, 0.56), pt(yaw * 0.28, 0.30)];
  drawCurvedBone(sink, suturePts, clamp(headW * 0.015, 1.0, 2.0), 0.35, true);

  // 2. Sculpted Supraorbital Brow Ridge & Zygomatic Cheekbone Arches
  const faceX = yaw * 0.28;
  const browPts = [
    pt(-0.74 + faceX * 0.4, 0.13),
    pt(-0.36 + faceX * 0.7, 0.21),
    pt(faceX, 0.12),
    pt(0.36 + faceX * 0.7, 0.21),
    pt(0.74 + faceX * 0.4, 0.13),
  ];
  drawCurvedBone(sink, browPts, clamp(headW * 0.044, 2.2, 5.0), 1.05, true);

  // Left & Right Zygomatic Arches (seamless flow from temples under eye orbits to upper jaw)
  for (const side of [-1, 1]) {
    const cheekCurve: Pt[] = [];
    const p0 = pt(side * 0.86, 0.0);
    const p1 = pt(side * 0.86 + faceX * 0.22, -0.28);
    const p2 = pt(side * 0.54 + faceX * 0.72, -0.40);
    const p3 = pt(side * 0.28 + faceX * 0.95, -0.32);
    for (let i = 0; i <= 8; i++) {
      cheekCurve.push(cubicBezier(p0, p1, p2, p3, i / 8));
    }
    drawCurvedBone(sink, cheekCurve, clamp(headW * 0.036, 1.9, 4.4), 0.95, false);
  }

  // 3. Prominent Hollow Anatomical Eye Orbits (rounded superellipse sockets with bright bony rims!)
  const orbitRx = headW * 0.162;
  const orbitRy = headH * 0.116;
  const rimThick = clamp(headW * 0.032, 1.7, 3.8);
  for (const side of [-1, 1]) {
    const foreshorten = clamp(1.0 - side * yaw * 0.32, 0.62, 1.12);
    const oc = pt(faceX + side * 0.38 * (1 - Math.abs(yaw) * 0.12), -0.05);
    const segs = 20;
    let prev: Pt | null = null;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // Rounded-square anatomical orbit (flat-ish top/bottom/sides, softly rounded 45° corners + slight outward droop)
      const sq = 1.0 - 0.08 * Math.cos(4 * a);
      const droop = -side * ca * 0.09 * orbitRy;
      const ox = ca * orbitRx * foreshorten * sq;
      const oy = sa * orbitRy * sq + droop;
      const cur = add(add(oc, scale(rx, ox)), scale(uy, oy));
      if (prev) {
        sink.pushSegment(prev.x, prev.y, cur.x, cur.y, rimThick, PEAK[0] * 0.95, PEAK[1] * 0.95, PEAK[2] * 0.95);
        sink.pushSegment(prev.x, prev.y, cur.x, cur.y, rimThick * 1.9, MARROW[0] * 0.85, MARROW[1] * 0.85, MARROW[2] * 0.85);
      }
      prev = cur;
    }
  }

  // 4. Inverted-Heart Piriform Nasal Cavity (hollow center + bright nasal bridge)
  const nosePts: Pt[] = [
    pt(faceX, -0.10),
    pt(faceX + 0.13, -0.35),
    pt(faceX + 0.06, -0.43),
    pt(faceX, -0.37),
    pt(faceX - 0.06, -0.43),
    pt(faceX - 0.13, -0.35),
    pt(faceX, -0.10),
  ];
  drawCurvedBone(sink, nosePts, clamp(headW * 0.024, 1.4, 3.0), 0.92, false);
  // Thin nasal septum line
  const septTop = pt(faceX, -0.13);
  const septBot = pt(faceX, -0.37);
  sink.pushSegment(septTop.x, septTop.y, septBot.x, septBot.y, clamp(headW * 0.014, 1.0, 2.0), CORTEX[0] * 0.72, CORTEX[1] * 0.72, CORTEX[2] * 0.72);

  // 5. Maxilla & Mandible (Jawbone) + Radiographic Teeth Row!
  const mouthDrop = clamp(-dot(sub(mouthMid, center), uy) / hh, 0.46, 0.76);
  const jawBottomY = -(mouthDrop + 0.28);

  const jawPts: Pt[] = [
    pt(-0.78 + faceX * 0.25, -0.22),
    pt(-0.74 + faceX * 0.35, -0.56),
    pt(-0.48 + faceX * 0.72, jawBottomY + 0.08),
    pt(faceX * 0.92, jawBottomY),
    pt(0.48 + faceX * 0.72, jawBottomY + 0.08),
    pt(0.74 + faceX * 0.35, -0.56),
    pt(0.78 + faceX * 0.25, -0.22),
  ];
  drawCurvedBone(sink, jawPts, clamp(headW * 0.044, 2.1, 5.2), 1.02, false);

  // Subtle jaw chin fill
  const chinL = pt(-0.34 + faceX * 0.75, jawBottomY + 0.08);
  const chinR = pt(0.34 + faceX * 0.75, jawBottomY + 0.08);
  const chinB = pt(faceX * 0.92, jawBottomY);
  sink.pushTri(chinL.x, chinL.y, chinR.x, chinR.y, chinB.x, chinB.y, MARROW[0] * 1.1, MARROW[1] * 1.1, MARROW[2] * 1.1);

  // Upper & lower teeth rows (7 crisp glowing calcium teeth per arch!)
  const toothCount = 7;
  const toothW = clamp(headW * 0.032, 1.5, 3.6);
  const upperGumY = -(mouthDrop - 0.14);
  const biteY = -mouthDrop;
  const lowerGumY = -(mouthDrop + 0.13);

  // Alveolar gum ridge arches
  const upperRidge: Pt[] = [];
  const lowerRidge: Pt[] = [];
  for (let i = 0; i < toothCount; i++) {
    const u = (i / (toothCount - 1)) * 2 - 1; // -1..+1
    const tx = faceX * 0.92 + u * 0.43;
    const archCurve = 0.045 * (1 - u * u);
    const uTop = pt(tx, upperGumY - archCurve * 0.3);
    const uBot = pt(tx, biteY + 0.015 - archCurve * 0.4);
    const lTop = pt(tx, biteY - 0.025 - archCurve * 0.4);
    const lBot = pt(tx, lowerGumY - archCurve * 0.3);

    upperRidge.push(uTop);
    lowerRidge.push(lBot);

    const toothBright = 0.92 + 0.16 * (1 - Math.abs(u));
    sink.pushSegment(uTop.x, uTop.y, uBot.x, uBot.y, toothW, PEAK[0] * toothBright, PEAK[1] * toothBright, PEAK[2] * toothBright);
    sink.pushSegment(lTop.x, lTop.y, lBot.x, lBot.y, toothW * 0.92, PEAK[0] * toothBright * 0.88, PEAK[1] * toothBright * 0.88, PEAK[2] * toothBright * 0.88);
  }
  drawCurvedBone(sink, upperRidge, clamp(headW * 0.02, 1.2, 2.4), 0.72, false);
  drawCurvedBone(sink, lowerRidge, clamp(headW * 0.02, 1.2, 2.4), 0.68, false);

  return {
    skullBase: pt(faceX * 0.3, jawBottomY + 0.12),
    headH,
  };
}

/**
 * Draws the segmented spine, S-curved clavicles, sternum, 8-pair anatomical ribcage,
 * ghostly scapulae, and pelvis/iliac wings.
 */
function drawXrayTorso(
  sink: XrayDrawSink,
  sLeft: Pt,
  sRight: Pt,
  hipLeft: Pt,
  hipRight: Pt,
  skullBase: Pt,
  rightAxis: Pt,
  downAxis: Pt,
  shoulderW: number,
  torsoH: number,
  nowSec: number,
  audioRms: number,
  drawPelvisFull: boolean
): void {
  const shMid = lerpPt(sLeft, sRight, 0.5);
  const hipMid = lerpPt(hipLeft, hipRight, 0.5);
  const breath = 1.0 + 0.022 * Math.sin(nowSec * 1.65) + audioRms * 0.032;

  // 1. Cervical Spine (5 stacked neck vertebrae from skull base down to sternal notch)
  const neckStart = add(skullBase, scale(downAxis, torsoH * 0.02));
  const neckEnd = add(shMid, scale(downAxis, torsoH * 0.02));
  const neckCount = 5;
  const cervW = clamp(shoulderW * 0.095, 6, 18);
  const cervH = clamp(dist(neckStart, neckEnd) / (neckCount * 1.45), 2.5, 8);
  for (let i = 0; i < neckCount; i++) {
    const t = (i + 0.5) / neckCount;
    const c = lerpPt(neckStart, neckEnd, t);
    // Soften uppermost C1-C2 vertebrae slightly so they sit naturally behind the mandible/open mouth
    const depthFade = 0.52 + 0.48 * smoothstep(0.0, 0.55, t);
    const w = cervW * (0.85 + 0.25 * t);
    const pA = add(c, scale(rightAxis, -w * 0.5));
    const pB = add(c, scale(rightAxis, w * 0.5));
    sink.pushSegment(pA.x, pA.y, pB.x, pB.y, cervH, BONE[0] * 0.9 * depthFade, BONE[1] * 0.9 * depthFade, BONE[2] * 0.9 * depthFade);
    sink.pushSegment(pA.x, pA.y, pB.x, pB.y, cervH * 0.36, CORTEX[0] * 0.95 * depthFade, CORTEX[1] * 0.95 * depthFade, CORTEX[2] * 0.95 * depthFade);
    // Transverse nubs
    sink.pushFilledCircle(c.x, c.y, cervH * 0.38, PEAK[0] * 0.72 * depthFade, PEAK[1] * 0.72 * depthFade, PEAK[2] * 0.72 * depthFade, 6);
  }

  // 2. Thoracic + Lumbar Spine (13 stacked vertebrae with intervertebral disc gaps)
  const spineTop = add(shMid, scale(downAxis, torsoH * 0.03));
  const spineBot = add(hipMid, scale(downAxis, -torsoH * 0.03));
  const vertCount = 13;
  const spineSegH = clamp(dist(spineTop, spineBot) / (vertCount * 1.38), 3.2, 12);
  for (let i = 0; i < vertCount; i++) {
    const t = (i + 0.5) / vertCount;
    const c = lerpPt(spineTop, spineBot, t);
    // Thoracic vertebrae narrower, lumbar vertebrae wider and beefier
    const bodyW = shoulderW * (0.095 + 0.055 * smoothstep(0.45, 0.95, t));
    const procW = bodyW * 1.48;

    // Transverse processes (faint wing tips)
    const tL = add(c, scale(rightAxis, -procW * 0.5));
    const tR = add(c, scale(rightAxis, procW * 0.5));
    sink.pushSegment(tL.x, tL.y, tR.x, tR.y, spineSegH * 0.34, MARROW[0] * 1.15, MARROW[1] * 1.15, MARROW[2] * 1.15);

    // Vertebral body + cortical endplates
    const bL = add(c, scale(rightAxis, -bodyW * 0.5));
    const bR = add(c, scale(rightAxis, bodyW * 0.5));
    const topOff = scale(downAxis, -spineSegH * 0.36);
    const botOff = scale(downAxis, spineSegH * 0.36);
    sink.pushSegment(bL.x, bL.y, bR.x, bR.y, spineSegH, BONE[0] * 0.75, BONE[1] * 0.75, BONE[2] * 0.75);
    sink.pushSegment(bL.x + topOff.x, bL.y + topOff.y, bR.x + topOff.x, bR.y + topOff.y, 1.5, CORTEX[0] * 0.85, CORTEX[1] * 0.85, CORTEX[2] * 0.85);
    sink.pushSegment(bL.x + botOff.x, bL.y + botOff.y, bR.x + botOff.x, bR.y + botOff.y, 1.5, CORTEX[0] * 0.85, CORTEX[1] * 0.85, CORTEX[2] * 0.85);
    // Spinous process central bright dot
    sink.pushFilledCircle(c.x, c.y, clamp(spineSegH * 0.28, 1.8, 4.2), PEAK[0] * 0.76, PEAK[1] * 0.76, PEAK[2] * 0.76, 6);
  }

  // 3. Ghostly Scapulae (Shoulder Blade shadows behind upper ribs)
  for (const side of [-1, 1]) {
    const sh = side < 0 ? sLeft : sRight;
    const scTop = add(add(sh, scale(rightAxis, -side * shoulderW * 0.08)), scale(downAxis, torsoH * 0.04));
    const scMed = add(add(shMid, scale(rightAxis, side * shoulderW * 0.16)), scale(downAxis, torsoH * 0.09));
    const scInf = add(add(shMid, scale(rightAxis, side * shoulderW * 0.24)), scale(downAxis, torsoH * 0.34));
    const scLat = add(sh, scale(downAxis, torsoH * 0.12));
    sink.pushTri(scTop.x, scTop.y, scMed.x, scMed.y, scInf.x, scInf.y, MARROW[0] * 0.65, MARROW[1] * 0.65, MARROW[2] * 0.65);
    sink.pushTri(scTop.x, scTop.y, scInf.x, scInf.y, scLat.x, scLat.y, MARROW[0] * 0.65, MARROW[1] * 0.65, MARROW[2] * 0.65);
    drawCurvedBone(sink, [scMed, scInf, scLat, scTop], clamp(shoulderW * 0.012, 1.2, 2.4), 0.36, false);
  }

  // 4. 8 Pairs of Curved Anatomical Ribs (Posterior arches + Anterior arches + Costal Arch!)
  const ribPairs = 8;
  const ribThick = clamp(shoulderW * 0.032, 2.4, 7.2);
  const sternumBot = lerpPt(spineTop, spineBot, 0.50);

  for (let i = 0; i < ribPairs; i++) {
    const t = i / (ribPairs - 1);
    const spineY = 0.05 + t * 0.54;
    const anchorSpine = lerpPt(spineTop, spineBot, spineY);

    // Barrel chest ribcage contour (widest around ribs 4-6, gracefully narrowing top & bottom)
    const barrel = 0.52 + 0.48 * Math.sin(t * 2.28 + 0.34);
    const halfSpan = shoulderW * 0.43 * barrel * breath;
    const ribDrop = torsoH * (0.045 + t * 0.068);

    // Where anterior rib terminates: upper 5 meet sternum directly, lower 3 sweep UPWARD into the classic costal arch!
    const isCostalArch = i >= 5;
    const frontY = isCostalArch ? 0.50 + (i - 5) * 0.048 : 0.09 + t * 0.49;
    const frontXFrac = isCostalArch ? 0.08 + (i - 5) * 0.095 : 0.055;
    const frontCenter = lerpPt(spineTop, spineBot, frontY);

    for (const side of [-1, 1]) {
      const lateralPt = add(
        add(anchorSpine, scale(rightAxis, side * halfSpan)),
        scale(downAxis, ribDrop * 0.52)
      );

      // Posterior rib (dimmer translucent rib arching from spine outward behind lungs)
      const postCtrl = add(
        add(anchorSpine, scale(rightAxis, side * halfSpan * 0.72)),
        scale(downAxis, -torsoH * 0.025)
      );
      const postPts: Pt[] = [];
      for (let s = 0; s <= 7; s++) {
        postPts.push(quadBezier(anchorSpine, postCtrl, lateralPt, s / 7));
      }
      drawCurvedBone(sink, postPts, ribThick * 0.84, 0.48, false);

      // Anterior rib (brighter front rib sweeping cleanly inward/upward to sternum or costal arch)
      const isFloating = i === ribPairs - 1;
      const antEnd = isFloating
        ? add(
            add(anchorSpine, scale(rightAxis, side * halfSpan * 0.58)),
            scale(downAxis, ribDrop * 0.85)
          )
        : add(frontCenter, scale(rightAxis, side * shoulderW * frontXFrac));
      const antCtrl = isFloating
        ? add(
            add(anchorSpine, scale(rightAxis, side * halfSpan * 0.88)),
            scale(downAxis, ribDrop * 0.78)
          )
        : isCostalArch
          ? add(
              add(anchorSpine, scale(rightAxis, side * halfSpan * 0.68)),
              scale(downAxis, ribDrop * 0.72)
            )
          : add(
              add(anchorSpine, scale(rightAxis, side * halfSpan * 0.92)),
              scale(downAxis, ribDrop * 0.94)
            );
      const antPts: Pt[] = [];
      for (let s = 0; s <= 8; s++) {
        antPts.push(quadBezier(lateralPt, antCtrl, antEnd, s / 8));
      }
      drawCurvedBone(sink, antPts, ribThick * (isCostalArch ? 0.84 : 0.96), isCostalArch ? 0.76 : 0.88, true);
    }
  }

  // 5. Sternum (Manubrium shield + Body down front midline of ribcage)
  const sternTop = add(shMid, scale(downAxis, torsoH * 0.055));
  const sternW = clamp(shoulderW * 0.088, 6, 18);
  const manubMid = add(sternTop, scale(downAxis, torsoH * 0.09));
  const mL = add(sternTop, scale(rightAxis, -sternW * 0.7));
  const mR = add(sternTop, scale(rightAxis, sternW * 0.7));
  const mBL = add(manubMid, scale(rightAxis, -sternW * 0.42));
  const mBR = add(manubMid, scale(rightAxis, sternW * 0.42));
  sink.pushTri(mL.x, mL.y, mR.x, mR.y, mBR.x, mBR.y, BONE[0] * 0.7, BONE[1] * 0.7, BONE[2] * 0.7);
  sink.pushTri(mL.x, mL.y, mBR.x, mBR.y, mBL.x, mBL.y, BONE[0] * 0.7, BONE[1] * 0.7, BONE[2] * 0.7);
  drawCurvedBone(sink, [mL, mR, mBR, mBL, mL], clamp(sternW * 0.18, 1.5, 3.0), 0.88, false);
  drawAnatomicalBone(sink, manubMid, sternumBot, sternW * 0.34, sternW * 0.46, 0.82);

  // 6. Paired S-Curved Clavicles (Collarbones from sternal notch out to both shoulders!)
  const clavThick = clamp(shoulderW * 0.036, 2.8, 7.6);
  for (const side of [-1, 1]) {
    const sh = side < 0 ? sLeft : sRight;
    const p0 = add(sternTop, scale(rightAxis, side * sternW * 0.45));
    const p1 = add(add(sternTop, scale(rightAxis, side * shoulderW * 0.18)), scale(downAxis, -torsoH * 0.055));
    const p2 = add(add(sh, scale(rightAxis, -side * shoulderW * 0.16)), scale(downAxis, torsoH * 0.025));
    const p3 = add(sh, scale(downAxis, -torsoH * 0.02));
    const clavPts: Pt[] = [];
    for (let s = 0; s <= 9; s++) {
      clavPts.push(cubicBezier(p0, p1, p2, p3, s / 9));
    }
    drawCurvedBone(sink, clavPts, clavThick, 1.08, false);
  }

  // 7. Pelvis (Iliac Butterfly Wings + Sacrum + Pubic Arch)
  if (drawPelvisFull) {
    const hipW = Math.max(dist(hipLeft, hipRight), shoulderW * 0.58);
    const pelvH = hipW * 0.56;
    const sacTop = add(hipMid, scale(downAxis, -pelvH * 0.42));
    const sacBot = add(hipMid, scale(downAxis, pelvH * 0.16));
    const sacL = add(sacTop, scale(rightAxis, -hipW * 0.16));
    const sacR = add(sacTop, scale(rightAxis, hipW * 0.16));
    sink.pushTri(sacL.x, sacL.y, sacR.x, sacR.y, sacBot.x, sacBot.y, BONE[0] * 0.72, BONE[1] * 0.72, BONE[2] * 0.72);
    drawCurvedBone(sink, [sacL, sacR, sacBot, sacL], clamp(hipW * 0.022, 1.8, 4.0), 0.9, false);

    // Iliac butterfly wings + obturator pelvic rings
    const iliacThick = clamp(hipW * 0.044, 2.8, 7.6);
    for (const side of [-1, 1]) {
      const hip = side < 0 ? hipLeft : hipRight;
      const p0 = add(sacTop, scale(rightAxis, side * hipW * 0.13));
      const p1 = add(add(hipMid, scale(rightAxis, side * hipW * 0.52)), scale(downAxis, -pelvH * 0.64));
      const p2 = add(add(hipMid, scale(rightAxis, side * hipW * 0.66)), scale(downAxis, -pelvH * 0.12));
      const p3 = add(hip, scale(downAxis, pelvH * 0.08));
      const wingPts: Pt[] = [];
      for (let s = 0; s <= 10; s++) {
        wingPts.push(cubicBezier(p0, p1, p2, p3, s / 10));
      }
      // Subtle translucent iliac blade fill
      for (let s = 0; s < wingPts.length - 1; s++) {
        const w0 = wingPts[s];
        const w1 = wingPts[s + 1];
        sink.pushTri(hipMid.x, hipMid.y, w0.x, w0.y, w1.x, w1.y, MARROW[0] * 0.55, MARROW[1] * 0.55, MARROW[2] * 0.55);
      }
      drawCurvedBone(sink, wingPts, iliacThick, 0.95, false);

      // Lower ischium / pubic symphysis curve + obturator foramen ring
      const pubMid = add(hipMid, scale(downAxis, pelvH * 0.34));
      const pubCtrl = add(add(hipMid, scale(rightAxis, side * hipW * 0.36)), scale(downAxis, pelvH * 0.44));
      const pubPts: Pt[] = [];
      for (let s = 0; s <= 7; s++) {
        pubPts.push(quadBezier(p3, pubCtrl, pubMid, s / 7));
      }
      drawCurvedBone(sink, pubPts, iliacThick * 0.72, 0.85, false);

      // Hollow pelvic obturator ring inside lower pelvis
      const obtC = add(add(hipMid, scale(rightAxis, side * hipW * 0.24)), scale(downAxis, pelvH * 0.16));
      sink.pushRing(
        obtC.x,
        obtC.y,
        clamp(hipW * 0.095, 5, 16),
        clamp(hipW * 0.02, 1.5, 3.2),
        BONE[0] * 0.82,
        BONE[1] * 0.82,
        BONE[2] * 0.82,
        14
      );

      drawJoint(sink, hip, clamp(hipW * 0.10, 5.5, 16), 0.96);
    }
  }
}

/**
 * Draws twin bowed forearm bones (Radius & Ulna) or twin lower leg bones (Tibia & Fibula).
 */
function drawTwinBones(
  sink: XrayDrawSink,
  a: Pt,
  b: Pt,
  shaftR: number,
  headR: number,
  spread: number,
  intensity = 1.0
): void {
  const dir = normalize(sub(b, a), { x: 0, y: -1 });
  const perp: Pt = { x: -dir.y, y: dir.x };
  const a1 = add(a, scale(perp, spread * 0.55));
  const b1 = add(b, scale(perp, spread * 0.65));
  const a2 = add(a, scale(perp, -spread * 0.55));
  const b2 = add(b, scale(perp, -spread * 0.65));

  drawAnatomicalBone(sink, a1, b1, shaftR * 0.66, headR * 0.74, intensity * 0.96);
  drawAnatomicalBone(sink, a2, b2, shaftR * 0.54, headR * 0.64, intensity * 0.86);
}

/**
 * Draws an articulated 21-point X-ray hand skeleton (carpal wrist cluster + 5 metacarpals + 14 phalanges).
 */
export function drawXrayHandSkeleton(
  sink: XrayDrawSink,
  hand: TrackedHand,
  proj: StageProjection
): void {
  const pts = hand.landmarks.map((p) => videoNormToStagePx(p.x, p.y, proj));
  const palmPx = Math.max(24, dist(pts[0], pts[9]));

  // 1. Carpal wrist cluster (small glowing pebble bones bridging forearm to metacarpals)
  const wrist = pts[0];
  const palmDir = normalize(sub(pts[9], wrist), { x: 0, y: 1 });
  const palmPerp: Pt = { x: -palmDir.y, y: palmDir.x };
  const carpalR = clamp(palmPx * 0.055, 2.2, 6.2);
  const carpalOffsets: [number, number][] = [
    [-0.14, 0.03],
    [-0.04, 0.06],
    [0.06, 0.06],
    [0.15, 0.03],
    [0.0, -0.02],
  ];
  for (const [ox, oy] of carpalOffsets) {
    const cp = add(add(wrist, scale(palmPerp, ox * palmPx)), scale(palmDir, oy * palmPx));
    drawJoint(sink, cp, carpalR, 0.88);
  }

  // 2. All 20 anatomical hand bones (5 metacarpals + 15 phalange segments)
  for (const [iA, iB, sScale, hScale] of HAND_BONE_CHAINS) {
    const shaftR = clamp(palmPx * sScale * 0.42, 1.5, 5.4);
    const headR = clamp(palmPx * hScale * 0.45, 2.1, 6.8);
    drawAnatomicalBone(sink, pts[iA], pts[iB], shaftR, headR, 0.96);
  }

  // 3. Glowing knuckle joint capsules at MCP, PIP, DIP
  const jointIndices = [1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15, 17, 18, 19];
  for (const idx of jointIndices) {
    const isMcp = idx === 1 || idx === 5 || idx === 9 || idx === 13 || idx === 17;
    const r = clamp(palmPx * (isMcp ? 0.054 : 0.042), 1.8, 5.5);
    drawJoint(sink, pts[idx], r, isMcp ? 0.92 : 0.78);
  }
}

/**
 * Renders the complete living anatomical X-Ray skeleton for a tracked 33-point MediaPipe Pose,
 * seamlessly snapping forearm wrists onto any active 21-point TrackedHands.
 */
export function drawXrayBodySkeleton(
  sink: XrayDrawSink,
  pose: TrackedPose,
  hands: TrackedHand[],
  proj: StageProjection,
  nowSec: number,
  audioRms: number,
  realisticSkullNeckAnchor: Pt | null = null
): void {
  const lm = pose.landmarks;
  if (lm.length < 25) return;

  // Require at least the shoulders to be detected with reasonable confidence
  const shVis = Math.min(lm[11]?.visibility ?? 0, lm[12]?.visibility ?? 0);
  if (shVis < 0.25) return;

  const toPx = (idx: number): Pt => videoNormToStagePx(lm[idx].x, lm[idx].y, proj);

  const p11 = toPx(11);
  const p12 = toPx(12);
  const shoulderW = dist(p11, p12);
  if (shoulderW < 24) return;

  // Canonical viewer-left / viewer-right shoulders so anatomy stays right-side-up whether mirrored or not
  const sLeft = p11.x <= p12.x ? p11 : p12;
  const sRight = p11.x <= p12.x ? p12 : p11;
  const rightAxis = normalize(sub(sRight, sLeft), { x: 1, y: 0 });

  // Anatomical down vector perpendicular to shoulders (in fxCamera, down is negative Y!)
  let downAxis: Pt = { x: rightAxis.y, y: -rightAxis.x };
  if (downAxis.y > 0) {
    downAxis = { x: -downAxis.x, y: -downAxis.y };
  }
  const upAxis: Pt = { x: -downAxis.x, y: -downAxis.y };

  const shMid = lerpPt(sLeft, sRight, 0.5);

  // Stabilized anatomical hips: blend observed hips with proportional torso anchor when cropped by desk webcam
  const rawHip1 = toPx(23);
  const rawHip2 = toPx(24);
  const rawHLeft = rawHip1.x <= rawHip2.x ? rawHip1 : rawHip2;
  const rawHRight = rawHip1.x <= rawHip2.x ? rawHip2 : rawHip1;
  const rawHipMid = lerpPt(rawHLeft, rawHRight, 0.5);

  const fallbackTorsoH = shoulderW * 1.44;
  const fallbackHipMid = add(shMid, scale(downAxis, fallbackTorsoH));
  const fallbackHLeft = add(fallbackHipMid, scale(rightAxis, -shoulderW * 0.37));
  const fallbackHRight = add(fallbackHipMid, scale(rightAxis, shoulderW * 0.37));

  const hipVis = Math.min(lm[23]?.visibility ?? 0, lm[24]?.visibility ?? 0);
  const hipBelowDist = dot(sub(rawHipMid, shMid), downAxis);
  const hipValid = hipVis > 0.35 && hipBelowDist > shoulderW * 0.65 && hipBelowDist < shoulderW * 2.4;
  const hipBlend = hipValid ? smoothstep(0.35, 0.78, hipVis) : 0;

  const hipLeft = lerpPt(fallbackHLeft, rawHLeft, hipBlend);
  const hipRight = lerpPt(fallbackHRight, rawHRight, hipBlend);
  const torsoH = clamp(dist(shMid, lerpPt(hipLeft, hipRight, 0.5)), shoulderW * 1.05, shoulderW * 2.0);

  // 1. Skull: use realistic 3D articulated XraySkullRig when ready; fallback to procedural vector skull otherwise
  const skullBase = realisticSkullNeckAnchor
    ? realisticSkullNeckAnchor
    : drawXraySkull(sink, lm, toPx, shoulderW, rightAxis, upAxis).skullBase;

  // 2. Spine, Clavicles, 8-Pair Ribcage, Sternum, Scapulae & Pelvis
  const hipMidY = (hipLeft.y + hipRight.y) * 0.5;
  const drawPelvisFull = hipMidY > -torsoH * 0.35;
  drawXrayTorso(
    sink,
    sLeft,
    sRight,
    hipLeft,
    hipRight,
    skullBase,
    rightAxis,
    downAxis,
    shoulderW,
    torsoH,
    nowSec,
    audioRms,
    drawPelvisFull
  );

  // Pre-project any active HandLandmarker wrists so forearm radius/ulna snap seamlessly onto the hand bones
  const handWrists = hands.map((h) => videoNormToStagePx(h.landmarks[0].x, h.landmarks[0].y, proj));
  const snapWrist = (poseWrist: Pt): Pt => {
    let best = poseWrist;
    let bestDist = shoulderW * 0.45;
    for (const hw of handWrists) {
      const d = dist(poseWrist, hw);
      if (d < bestDist) {
        bestDist = d;
        best = hw;
      }
    }
    return best;
  };

  // 3. Arms: Shoulders (11/12) -> Elbows (13/14) -> Wrists (15/16)
  const armPairs: [number, number, number][] = [
    [11, 13, 15],
    [12, 14, 16],
  ];
  const armShaftR = clamp(shoulderW * 0.044, 3.2, 10.5);
  const armHeadR = clamp(shoulderW * 0.072, 5.0, 16.5);

  for (const [shIdx, elIdx, wrIdx] of armPairs) {
    const sh = toPx(shIdx);
    drawJoint(sink, sh, armHeadR * 1.08, 1.04);

    if ((lm[elIdx]?.visibility ?? 0) > 0.28) {
      const el = toPx(elIdx);
      drawAnatomicalBone(sink, sh, el, armShaftR, armHeadR, 1.0);
      drawJoint(sink, el, armHeadR * 0.92, 1.0);

      if ((lm[wrIdx]?.visibility ?? 0) > 0.25) {
        const wr = snapWrist(toPx(wrIdx));
        // Twin Radius & Ulna forearm bones!
        drawTwinBones(sink, el, wr, armShaftR * 0.84, armHeadR * 0.80, armShaftR * 1.15, 0.96);
        drawJoint(sink, wr, armHeadR * 0.68, 0.94);

        // If HandLandmarker isn't currently tracking this wrist, draw simplified pose hand stub (17/19/21 or 18/20/22)
        const hasDetailedHand = handWrists.some((hw) => dist(hw, wr) < shoulderW * 0.22);
        if (!hasDetailedHand) {
          const pinkyIdx = wrIdx === 15 ? 17 : 18;
          const indexIdx = wrIdx === 15 ? 19 : 20;
          const thumbIdx = wrIdx === 15 ? 21 : 22;
          for (const tipIdx of [thumbIdx, indexIdx, pinkyIdx]) {
            if ((lm[tipIdx]?.visibility ?? 0) > 0.3) {
              drawAnatomicalBone(sink, wr, toPx(tipIdx), armShaftR * 0.34, armHeadR * 0.34, 0.82);
            }
          }
        }
      }
    }
  }

  // 4. Legs: Hips (23/24) -> Knees (25/26) -> Ankles (27/28) when visible in full-body framing
  const legPairs: [number, number, number][] = [
    [23, 25, 27],
    [24, 26, 28],
  ];
  const legShaftR = clamp(shoulderW * 0.056, 4.0, 13.5);
  const legHeadR = clamp(shoulderW * 0.088, 6.2, 20.0);

  for (const [hIdx, kIdx, aIdx] of legPairs) {
    if ((lm[hIdx]?.visibility ?? 0) > 0.4 && (lm[kIdx]?.visibility ?? 0) > 0.4) {
      const h = toPx(hIdx);
      const k = toPx(kIdx);
      drawAnatomicalBone(sink, h, k, legShaftR, legHeadR, 0.98);
      // Patella (kneecap)
      drawJoint(sink, k, legHeadR * 0.92, 1.02);

      if ((lm[aIdx]?.visibility ?? 0) > 0.35) {
        const a = toPx(aIdx);
        // Twin Tibia & Fibula shin bones
        drawTwinBones(sink, k, a, legShaftR * 0.82, legHeadR * 0.78, legShaftR * 1.15, 0.94);
        drawJoint(sink, a, legHeadR * 0.70, 0.92);
      }
    }
  }
}
