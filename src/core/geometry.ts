import type { Vec2 } from '../types';

export function distance(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

/**
 * Aspect-corrected distance (treats viewport width/height accurately so
 * diagonal vs vertical vs horizontal strings have physically consistent length).
 */
export function aspectDistance(a: Vec2, b: Vec2, aspect: number): number {
  const dx = (a.x - b.x) * aspect;
  const dy = a.y - b.y;
  // Normalize back to width-equivalent units
  return Math.hypot(dx, dy) / Math.max(1, aspect);
}

export function lerpVec2(a: Vec2, b: Vec2, t: number): Vec2 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  };
}

export function midpoint(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
}

export interface SegmentIntersection {
  point: Vec2;
  tFinger: number; // parameter along finger motion [0, 1]
  uString: number; // parameter along string [0, 1]
  normalSpeed: number; // perpendicular crossing speed
  pluckDir: number; // +1 or -1 side of string normal
}

/**
 * Strict 2D segment-segment intersection between finger motion (fPrev -> fCurr)
 * and string segment (s1 -> s2). Prevents tunneling on fast strums.
 */
export function intersectFingerWithString(
  fPrev: Vec2,
  fCurr: Vec2,
  s1: Vec2,
  s2: Vec2
): SegmentIntersection | null {
  const rx = fCurr.x - fPrev.x;
  const ry = fCurr.y - fPrev.y;
  const sx = s2.x - s1.x;
  const sy = s2.y - s1.y;

  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-7) return null; // parallel or stationary

  const qpx = s1.x - fPrev.x;
  const qpy = s1.y - fPrev.y;

  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;

  // Slightly inset string endpoints so endpoint grabs don't trigger accidental plucks
  if (t >= 0 && t <= 1 && u >= 0.03 && u <= 0.97) {
    const sLen = Math.hypot(sx, sy);
    if (sLen < 1e-6) return null;
    // Unit normal to string
    const nx = -sy / sLen;
    const ny = sx / sLen;
    const dotNormal = rx * nx + ry * ny;

    return {
      point: {
        x: s1.x + u * sx,
        y: s1.y + u * sy,
      },
      tFinger: t,
      uString: u,
      normalSpeed: Math.abs(dotNormal),
      pluckDir: dotNormal >= 0 ? 1 : -1,
    };
  }

  return null;
}

export interface ClosestPointResult {
  point: Vec2;
  u: number;
  dist: number;
}

export function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): ClosestPointResult {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < 1e-9) {
    return { point: { ...a }, u: 0, dist: distance(p, a) };
  }
  const u = Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq));
  const point = { x: a.x + u * abx, y: a.y + u * aby };
  return { point, u, dist: distance(p, point) };
}
