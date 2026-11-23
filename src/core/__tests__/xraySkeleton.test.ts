import { describe, expect, it } from 'vitest';
import type { PoseLandmark, TrackedFace, TrackedHand, TrackedPose } from '../../types';
import {
  drawXrayBodySkeleton,
  drawXrayHandSkeleton,
  videoNormToStagePx,
  type StageProjection,
  type XrayDrawSink,
} from '../../render/xraySkeleton';
import { computeSkullPlacement } from '../../render/XraySkullRig';

function makeMockSink() {
  let triCount = 0;
  let badNumbers = 0;
  const check = (...vals: number[]) => {
    for (const v of vals) {
      if (!Number.isFinite(v)) badNumbers++;
    }
  };
  const sink: XrayDrawSink = {
    pushTri(x1, y1, x2, y2, x3, y3, r, g, b) {
      check(x1, y1, x2, y2, x3, y3, r, g, b);
      triCount += 1;
    },
    pushSegment(x1, y1, x2, y2, thickness, r, g, b) {
      check(x1, y1, x2, y2, thickness, r, g, b);
      triCount += 2;
    },
    pushRing(cx, cy, radius, thickness, r, g, b, segments) {
      check(cx, cy, radius, thickness, r, g, b, segments);
      triCount += segments * 2;
    },
    pushFilledCircle(cx, cy, radius, r, g, b, segments) {
      check(cx, cy, radius, r, g, b, segments);
      triCount += segments;
    },
  };
  return {
    sink,
    getTriCount: () => triCount,
    getBadNumbers: () => badNumbers,
  };
}

function makeStandardPose(lowerBodyVisible: boolean): TrackedPose {
  const lm: PoseLandmark[] = Array.from({ length: 33 }, () => ({
    x: 0.5,
    y: 0.5,
    z: 0,
    visibility: 0.95,
  }));
  const set = (idx: number, x: number, y: number, visibility = 0.95) => {
    lm[idx] = { x, y, z: 0, visibility };
  };
  // Head
  set(0, 0.50, 0.21); // nose
  set(2, 0.53, 0.19); // left eye
  set(5, 0.47, 0.19); // right eye
  set(7, 0.56, 0.20); // left ear
  set(8, 0.44, 0.20); // right ear
  set(9, 0.52, 0.25); // mouth L
  set(10, 0.48, 0.25); // mouth R
  // Shoulders & Arms
  set(11, 0.62, 0.36); // left shoulder
  set(12, 0.38, 0.36); // right shoulder
  set(13, 0.70, 0.52); // left elbow
  set(14, 0.30, 0.52); // right elbow
  set(15, 0.64, 0.48); // left wrist (raised playing strings)
  set(16, 0.36, 0.48); // right wrist
  set(17, 0.63, 0.45);
  set(18, 0.37, 0.45);
  set(19, 0.62, 0.44);
  set(20, 0.38, 0.44);
  set(21, 0.61, 0.46);
  set(22, 0.39, 0.46);
  // Hips & Legs
  const lv = lowerBodyVisible ? 0.92 : 0.08;
  set(23, 0.58, 0.70, lv);
  set(24, 0.42, 0.70, lv);
  set(25, 0.59, 0.86, lv);
  set(26, 0.41, 0.86, lv);
  set(27, 0.59, 0.98, lv);
  set(28, 0.41, 0.98, lv);

  return { landmarks: lm, timestampMs: 1000 };
}

function makeMockHand(wristX: number, wristY: number): TrackedHand {
  const pts = [
    [0, 0], // 0 wrist
    [-0.03, -0.02], [-0.05, -0.05], [-0.06, -0.08], [-0.07, -0.10], // thumb
    [-0.025, -0.07], [-0.03, -0.11], [-0.032, -0.14], [-0.033, -0.17], // index
    [0, -0.075], [0, -0.12], [0, -0.155], [0, -0.185], // middle
    [0.024, -0.07], [0.028, -0.11], [0.03, -0.14], [0.032, -0.168], // ring
    [0.045, -0.055], [0.052, -0.085], [0.056, -0.11], [0.06, -0.132], // pinky
  ];
  const landmarks = pts.map(([dx, dy]) => ({ x: wristX + dx, y: wristY + dy, z: 0 }));
  return {
    id: 'hand-0',
    handedness: 'Right',
    landmarks,
    pinchActive: false,
    pinchPos: { x: wristX, y: wristY - 0.12 },
    palmCenter: { x: wristX, y: wristY - 0.05 },
    palmSize: 0.075,
    openPalm: false,
    backFacing: false,
    fiveFingersOpen: true,
    closedFist: false,
    extendedFingers: [4, 8, 12, 16, 20],
    activeFingers: [],
  };
}

describe('X-Ray Anatomical Skeleton Renderer', () => {
  it('inverts coverUvForAspect accurately across 16:9, ultrawide, and square viewports', () => {
    const cases: StageProjection[] = [
      { width: 1280, height: 720, videoAspect: 16 / 9 },
      { width: 2560, height: 1080, videoAspect: 16 / 9 }, // wider than video
      { width: 980, height: 985, videoAspect: 16 / 9 }, // taller than video
    ];

    for (const proj of cases) {
      // Center always stays dead center
      const c = videoNormToStagePx(0.5, 0.5, proj);
      expect(c.x).toBeCloseTo(proj.width * 0.5, 4);
      expect(c.y).toBeCloseTo(proj.height * 0.5, 4);

      // Verify exact inverse against BG_FRAG coverUvForAspect(vUv, videoAspect, mirror=0)
      const lx = 0.62;
      const ly = 0.34;
      const px = videoNormToStagePx(lx, ly, proj);
      const vUvX = px.x / proj.width;
      const vUvY = px.y / proj.height;
      const sA = proj.width / proj.height;

      let camX = vUvX;
      let camY = vUvY;
      if (sA > proj.videoAspect) {
        camY = (vUvY - 0.5) * (proj.videoAspect / sA) + 0.5;
      } else {
        camX = (vUvX - 0.5) * (sA / proj.videoAspect) + 0.5;
      }

      expect(camX).toBeCloseTo(lx, 5);
      expect(1 - camY).toBeCloseTo(ly, 5);
    }
  });

  it('draws full-body anatomical skeleton with zero NaNs and modest triangle budget', () => {
    const { sink, getTriCount, getBadNumbers } = makeMockSink();
    const pose = makeStandardPose(true);
    const hands = [makeMockHand(0.36, 0.48), makeMockHand(0.64, 0.48)];
    const proj: StageProjection = { width: 1280, height: 720, videoAspect: 16 / 9 };

    drawXrayBodySkeleton(sink, pose, hands, proj, 1.25, 0.3);
    for (const h of hands) {
      drawXrayHandSkeleton(sink, h, proj);
    }

    expect(getBadNumbers()).toBe(0);
    // Rich anatomy (skull + teeth + spine + 8-pair ribs + pelvis + limbs + 2x21-bone hands),
    // yet comfortably under MAX_QUADS (20,000 quads = 40,000 tris)
    expect(getTriCount()).toBeGreaterThan(1000);
    expect(getTriCount()).toBeLessThan(12000);
  });

  it('stabilizes torso ribcage gracefully for desk-webcam upper-body framing (hips out of frame)', () => {
    const { sink, getTriCount, getBadNumbers } = makeMockSink();
    const pose = makeStandardPose(false);
    const proj: StageProjection = { width: 1280, height: 720, videoAspect: 16 / 9 };

    drawXrayBodySkeleton(sink, pose, [], proj, 2.0, 0.1);

    expect(getBadNumbers()).toBe(0);
    expect(getTriCount()).toBeGreaterThan(800);
    expect(getTriCount()).toBeLessThan(10000);
  });

  it('computes accurate 3D skull placement and live jaw opening from TrackedFace', () => {
    const proj: StageProjection = { width: 1280, height: 720, videoAspect: 16 / 9 };
    const closedFace: TrackedFace = {
      foreheadTop: { x: 0.5, y: 0.14 },
      chinBottom: { x: 0.5, y: 0.42 },
      cheekLeft: { x: 0.42, y: 0.28 },
      cheekRight: { x: 0.58, y: 0.28 },
      eyeLeft: { x: 0.46, y: 0.24 },
      eyeRight: { x: 0.54, y: 0.24 },
      noseTip: { x: 0.5, y: 0.30 },
      upperLipInner: { x: 0.5, y: 0.35 },
      lowerLipInner: { x: 0.5, y: 0.352 },
      mouthLeft: { x: 0.47, y: 0.35 },
      mouthRight: { x: 0.53, y: 0.35 },
      pitch: 0.05,
      yaw: 0.12,
      roll: 0.04,
      jawOpen: 0.02,
      jawShiftX: 0,
      mouthStretch: 0,
      timestampMs: 1000,
    };

    const wideOpenFace: TrackedFace = {
      ...closedFace,
      chinBottom: { x: 0.5, y: 0.48 },
      lowerLipInner: { x: 0.5, y: 0.40 },
      jawOpen: 0.85,
      jawShiftX: 0.35,
    };

    const pClosed = computeSkullPlacement(closedFace, null, proj)!;
    const pOpen = computeSkullPlacement(wideOpenFace, null, proj)!;

    expect(pClosed).not.toBeNull();
    expect(pOpen).not.toBeNull();
    expect(pClosed.width).toBeGreaterThan(180);
    expect(pClosed.jawOpen).toBeLessThan(0.15);
    expect(pOpen.jawOpen).toBeGreaterThan(0.8);
    expect(pOpen.jawShiftX).toBeCloseTo(0.35, 3);
    // Eye sockets should stay anchored cleanly over real eye midpoint even as chin drops!
    expect(Math.abs(pOpen.cx - pClosed.cx)).toBeLessThan(2);
    expect(Math.abs(pOpen.cy - pClosed.cy)).toBeLessThan(2);

    // Fallback to PoseLandmarker when FaceLandmarker hasn't locked yet
    const pFallback = computeSkullPlacement(null, makeStandardPose(true), proj);
    expect(pFallback).not.toBeNull();
    expect(pFallback!.width).toBeGreaterThan(100);
  });
});
