import type { CameraFilterMode, TrackedHand, Vec2 } from '../types';

export interface BgSwipeTrigger {
  direction: 1 | -1; // +1 left->right, -1 right->left
  point: Vec2;
}

interface SwipeTrack {
  startX: number;
  startY: number;
  startMs: number;
  lastX: number;
  lastY: number;
  lastMs: number;
  dirSign: number; // -1, 0, +1
  peakPalmSize: number;
}

/**
 * Cycles sequentially to the next background mode in round-robin loop order.
 */
export function pickNextCyclicBg(
  current: CameraFilterMode,
  modes: readonly CameraFilterMode[]
): CameraFilterMode {
  if (modes.length === 0) return current;
  const idx = modes.indexOf(current);
  return modes[(idx + 1) % modes.length];
}

/**
 * Rotation-invariant estimate of whether the dorsal (back) of a hand faces the camera.
 * Evaluated in RAW (unmirrored) MediaPipe image space (+X right, +Y down).
 */
export function isHandBackFacing(
  rawLandmarks: readonly { x: number; y: number }[],
  mediaPipeHandedness: 'Left' | 'Right'
): boolean {
  if (rawLandmarks.length < 18) return false;
  const p0 = rawLandmarks[0];
  const p5 = rawLandmarks[5];
  const p9 = rawLandmarks[9];
  const p17 = rawLandmarks[17];

  const palmSize = Math.hypot(p9.x - p0.x, p9.y - p0.y);
  if (palmSize < 0.025) return false;

  const v1x = p5.x - p0.x;
  const v1y = p5.y - p0.y;
  const v2x = p17.x - p0.x;
  const v2y = p17.y - p0.y;
  const normCross = (v1x * v2y - v1y * v2x) / (palmSize * palmSize);

  // In MediaPipe Tasks Vision on raw unmirrored webcam frames, subject Right hand = 'Right'
  const handSign = mediaPipeHandedness === 'Right' ? 1 : -1;
  return handSign * normCross > 0.10;
}

/**
 * Detects an intentional close-up open-hand horizontal swipe across the face
 * (left->right or right->left) to randomly switch the stage background.
 *
 * Resilient to:
 * - Fast motion blur dropping 1-4 frames mid-swipe (grace window preserves trajectory)
 * - MediaPipe handedness flip uncertainty on close dorsal hands
 * - Varying laptop/desktop camera framing (face anywhere in y=[0.12..0.84], plus live Face/Pose anchor)
 * - Diagonal/horizontal wrist tilt (uses aspect-corrected palmSize from HandTracker)
 */
export class BgSwipeDetector {
  private tracks = new Map<string, SwipeTrack>();
  private cooldownUntilMs = 0;

  // Remembered live face center; defaults to mid-frame (covers both eye-level and desk laptop webcams!)
  private faceCenter: Vec2 = { x: 0.5, y: 0.48 };
  private hasLiveFaceAnchor = false;

  // Ergonomic, thoroughly tested thresholds
  private readonly minPalmSize = 0.115; // aspect-corrected close-up palm near face
  private readonly maxFaceDy = 0.36; // generous vertical band around face (or live anchor ±0.30)
  private readonly faceBandHalfW = 0.22; // swipe must cross through the central face horizontal zone
  private readonly minTravelX = 0.18; // minimum horizontal swipe travel across stage
  private readonly minAvgSpeed = 0.34; // normalized screen widths / sec
  private readonly maxSwipeWindowMs = 850;
  private readonly frameDropGraceMs = 260; // keep swipe alive across brief motion-blur dropouts!
  private readonly cooldownMs = 950;

  updateFaceAnchor(cx: number, cy: number): void {
    if (!this.hasLiveFaceAnchor) {
      this.faceCenter.x = cx;
      this.faceCenter.y = cy;
      this.hasLiveFaceAnchor = true;
    } else {
      this.faceCenter.x = this.faceCenter.x * 0.85 + cx * 0.15;
      this.faceCenter.y = this.faceCenter.y * 0.85 + cy * 0.15;
    }
  }

  reset(): void {
    this.tracks.clear();
  }

  update(hands: TrackedHand[], nowMs: number): BgSwipeTrigger | null {
    if (nowMs < this.cooldownUntilMs) {
      this.tracks.clear();
      return null;
    }

    const vertTolerance = this.hasLiveFaceAnchor ? 0.30 : this.maxFaceDy;

    for (const hand of hands) {
      const inFaceBand = Math.abs(hand.palmCenter.y - this.faceCenter.y) <= vertTolerance;
      const isOpen = hand.fiveFingersOpen && !hand.pinchActive;
      const isClose = hand.palmSize >= this.minPalmSize;

      // Allow a track that already started close & open to survive brief 1-frame finger/size flicker
      const existing = this.tracks.get(hand.id);
      const eligible = isOpen && isClose && inFaceBand;

      if (!eligible) {
        // Keep existing track alive briefly during fast-swipe blur instead of wiping immediately!
        if (existing && nowMs - existing.lastMs > this.frameDropGraceMs) {
          this.tracks.delete(hand.id);
        }
        continue;
      }

      const cx = hand.palmCenter.x;
      const cy = hand.palmCenter.y;

      if (!existing || nowMs - existing.lastMs > this.frameDropGraceMs) {
        this.tracks.set(hand.id, {
          startX: cx,
          startY: cy,
          startMs: nowMs,
          lastX: cx,
          lastY: cy,
          lastMs: nowMs,
          dirSign: 0,
          peakPalmSize: hand.palmSize,
        });
        continue;
      }

      const stepDx = cx - existing.lastX;
      // Ignore tiny micro-jitter reversals (< 0.025) so natural slight wrist wobble never resets a swipe
      let nextDir = existing.dirSign;
      if (Math.abs(stepDx) >= 0.025) {
        nextDir = stepDx > 0 ? 1 : -1;
      } else if (existing.dirSign === 0 && Math.abs(cx - existing.startX) >= 0.02) {
        nextDir = cx > existing.startX ? 1 : -1;
      }

      if (
        (existing.dirSign !== 0 && nextDir !== 0 && nextDir !== existing.dirSign) ||
        nowMs - existing.startMs > this.maxSwipeWindowMs
      ) {
        this.tracks.set(hand.id, {
          startX: existing.lastX,
          startY: existing.lastY,
          startMs: existing.lastMs,
          lastX: cx,
          lastY: cy,
          lastMs: nowMs,
          dirSign: nextDir,
          peakPalmSize: hand.palmSize,
        });
        continue;
      }

      existing.lastX = cx;
      existing.lastY = cy;
      existing.lastMs = nowMs;
      existing.dirSign = nextDir;
      existing.peakPalmSize = Math.max(existing.peakPalmSize, hand.palmSize);

      const totalDx = cx - existing.startX;
      const totalDy = cy - existing.startY;
      const elapsedSec = Math.max(0.04, (nowMs - existing.startMs) / 1000);
      const avgSpeed = Math.abs(totalDx) / elapsedSec;

      const minX = Math.min(existing.startX, cx);
      const maxX = Math.max(existing.startX, cx);
      const crossedFace =
        minX <= this.faceCenter.x + this.faceBandHalfW &&
        maxX >= this.faceCenter.x - this.faceBandHalfW;
      // Predominantly horizontal gesture across face (prevents vertical strums from triggering)
      const isHorizontal = Math.abs(totalDx) > Math.abs(totalDy) * 1.25;

      if (
        Math.abs(totalDx) >= this.minTravelX &&
        avgSpeed >= this.minAvgSpeed &&
        crossedFace &&
        isHorizontal
      ) {
        this.tracks.clear();
        this.cooldownUntilMs = nowMs + this.cooldownMs;
        return {
          direction: totalDx > 0 ? 1 : -1,
          point: { x: cx, y: cy },
        };
      }
    }

    // Expire stale tracks only after grace window (survives fast-swipe 1-3 frame dropouts!)
    for (const [id, tr] of this.tracks.entries()) {
      if (nowMs - tr.lastMs > this.frameDropGraceMs) {
        this.tracks.delete(id);
      }
    }

    return null;
  }
}
