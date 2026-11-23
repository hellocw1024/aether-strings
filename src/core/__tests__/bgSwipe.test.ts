import { describe, expect, it } from 'vitest';
import { BgSwipeDetector, isHandBackFacing, pickNextCyclicBg } from '../BgSwipeDetector';
import type { CameraFilterMode, TrackedHand } from '../../types';

function makeRawHand(indexX: number, pinkyX: number, wristY = 0.7, knuckleY = 0.45) {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
  lm[0] = { x: 0.5, y: wristY };
  lm[5] = { x: indexX, y: knuckleY };
  lm[9] = { x: (indexX + pinkyX) * 0.5, y: knuckleY };
  lm[17] = { x: pinkyX, y: knuckleY };
  return lm;
}

function makeTrackedHand(overrides: Partial<TrackedHand>): TrackedHand {
  return {
    id: 'hand-0',
    handedness: 'Right',
    landmarks: Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.52, z: 0 })),
    pinchActive: false,
    pinchPos: { x: 0.5, y: 0.52 },
    palmCenter: { x: 0.5, y: 0.52 },
    palmSize: 0.16,
    openPalm: false,
    backFacing: true,
    fiveFingersOpen: true,
    closedFist: false,
    extendedFingers: [4, 8, 12, 16, 20],
    activeFingers: [],
    ...overrides,
  };
}

describe('Face-Swipe Cyclic Background Switch', () => {
  it('cycles sequentially in round-robin loop order across all background modes', () => {
    const all: CameraFilterMode[] = ['cinema', 'portrait', 'cyber', 'xray', 'clean'];
    let cur: CameraFilterMode = 'cinema';
    const visited: CameraFilterMode[] = [];
    for (let i = 0; i < all.length; i++) {
      cur = pickNextCyclicBg(cur, all);
      visited.push(cur);
    }
    expect(visited).toEqual(['portrait', 'cyber', 'xray', 'clean', 'cinema']);
  });

  it('distinguishes back-of-hand vs palm-facing for Tasks Vision handedness', () => {
    // Subject Right hand ('Right'), fingers UP, back facing camera: index (5) camera-left, pinky (17) camera-right
    expect(isHandBackFacing(makeRawHand(0.40, 0.60), 'Right')).toBe(true);
    expect(isHandBackFacing(makeRawHand(0.60, 0.40), 'Right')).toBe(false);

    // Subject Left hand ('Left'), fingers UP, back facing camera: index (5) camera-right, pinky (17) camera-left
    expect(isHandBackFacing(makeRawHand(0.60, 0.40), 'Left')).toBe(true);
    expect(isHandBackFacing(makeRawHand(0.40, 0.60), 'Left')).toBe(false);
  });

  it('triggers reliably on left->right and right->left face swipes, including desk webcam y=0.62 and brief blur dropouts', () => {
    const det = new BgSwipeDetector();

    // Simulate desk laptop webcam where face is at y=0.62 + 1 dropped motion-blur frame mid-swipe!
    let triggered = null;
    const frames: (number | null)[] = [0.30, 0.39, null, 0.52, 0.61];
    for (let i = 0; i < frames.length; i++) {
      const x = frames[i];
      const hands =
        x === null ? [] : [makeTrackedHand({ palmCenter: { x, y: 0.62 }, palmSize: 0.14 })];
      const res = det.update(hands, 1000 + i * 50);
      if (res) triggered = res;
    }

    expect(triggered).not.toBeNull();
    expect(triggered!.direction).toBe(1);

    // Follow-through inside 950ms cooldown must NOT double-trigger
    let duringCooldown = null;
    for (let i = 0; i < 5; i++) {
      const res = det.update(
        [makeTrackedHand({ palmCenter: { x: 0.66 - i * 0.09, y: 0.62 }, palmSize: 0.16 })],
        1300 + i * 40
      );
      if (res) duringCooldown = res;
    }
    expect(duringCooldown).toBeNull();

    // After cooldown expires (> 2200ms), right->left swipe triggers direction = -1
    let rightToLeft = null;
    for (let i = 0; i < 5; i++) {
      const res = det.update(
        [makeTrackedHand({ palmCenter: { x: 0.68 - i * 0.08, y: 0.34 }, palmSize: 0.15 })],
        2300 + i * 50
      );
      if (res) rightToLeft = res;
    }
    expect(rightToLeft).not.toBeNull();
    expect(rightToLeft!.direction).toBe(-1);
  });

  it('rejects distant playing hands, fists/pinches, vertical strums, and stationary palm mutes', () => {
    // 1. Distant hand at playing distance
    {
      const det = new BgSwipeDetector();
      let hit = false;
      for (let i = 0; i < 6; i++) {
        if (det.update([makeTrackedHand({ palmSize: 0.08, palmCenter: { x: 0.25 + i * 0.1, y: 0.48 } })], 1000 + i * 50)) hit = true;
      }
      expect(hit).toBe(false);
    }

    // 2. Closed fist / non-open fingers
    {
      const det = new BgSwipeDetector();
      let hit = false;
      for (let i = 0; i < 6; i++) {
        if (det.update([makeTrackedHand({ fiveFingersOpen: false, palmCenter: { x: 0.25 + i * 0.1, y: 0.48 } })], 1000 + i * 50)) hit = true;
      }
      expect(hit).toBe(false);
    }

    // 3. Vertical strum (not horizontal across face)
    {
      const det = new BgSwipeDetector();
      let hit = false;
      for (let i = 0; i < 6; i++) {
        if (det.update([makeTrackedHand({ palmCenter: { x: 0.48 + i * 0.01, y: 0.20 + i * 0.10 } })], 1000 + i * 50)) hit = true;
      }
      expect(hit).toBe(false);
    }

    // 4. Stationary open-palm mute
    {
      const det = new BgSwipeDetector();
      let hit = false;
      for (let i = 0; i < 8; i++) {
        if (det.update([makeTrackedHand({ palmCenter: { x: 0.50 + i * 0.005, y: 0.48 } })], 1000 + i * 60)) hit = true;
      }
      expect(hit).toBe(false);
    }
  });
});
