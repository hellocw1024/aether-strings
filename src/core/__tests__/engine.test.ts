import { describe, expect, it } from 'vitest';
import {
  buildScaleMidiTable,
  detectHarmonicInterval,
  lengthToPitch,
  SCALES,
} from '../../music/scales';
import { intersectFingerWithString } from '../geometry';
import { StringManager } from '../StringManager';
import { OneEuroFilter1D } from '../../vision/OneEuroFilter';
import type { ActiveFinger, TrackedHand, Vec2, Vec3 } from '../../types';

function makeDummyLandmarks(center: Vec2): Vec3[] {
  return Array.from({ length: 21 }, () => ({ x: center.x, y: center.y, z: 0 }));
}

function makeHand(
  id: string,
  opts: Partial<TrackedHand> & { pos?: Vec2 } = {}
): TrackedHand {
  const pos = opts.pos ?? { x: 0.5, y: 0.5 };
  return {
    id,
    handedness: opts.handedness ?? 'Right',
    landmarks: opts.landmarks ?? makeDummyLandmarks(pos),
    pinchActive: opts.pinchActive ?? false,
    pinchPos: opts.pinchPos ?? pos,
    palmCenter: opts.palmCenter ?? pos,
    palmSize: opts.palmSize ?? 0.14,
    openPalm: opts.openPalm ?? false,
    backFacing: opts.backFacing ?? false,
    fiveFingersOpen: opts.fiveFingersOpen ?? false,
    closedFist: opts.closedFist ?? false,
    extendedFingers: opts.extendedFingers ?? [8],
    activeFingers: opts.activeFingers ?? [],
  };
}

describe('Music scales & pitch quantization', () => {
  it('defines exact pitch classes for all active scales and removes duplicates/hirajoshi', () => {
    expect('hirajoshi' in SCALES).toBe(false);
    expect('major_pentatonic' in SCALES).toBe(false);

    const expected: Record<string, number[]> = {
      pentatonic_cn: [0, 2, 4, 7, 9],
      harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
      melodic_minor: [0, 2, 3, 5, 7, 9, 11],
      minor_pentatonic: [0, 3, 5, 7, 10],
      blues: [0, 3, 5, 6, 7, 10],
    };

    for (const [id, intervals] of Object.entries(expected)) {
      const table = buildScaleMidiTable(id as keyof typeof SCALES);
      const pitchClasses = [...new Set(table.map((m) => m % 12))].sort((a, b) => a - b);
      expect(pitchClasses).toEqual(intervals);
    }
  });

  it('maps shorter strings to higher frequencies monotonically', () => {
    const longP = lengthToPitch(0.72, 'minor_pentatonic');
    const midP = lengthToPitch(0.35, 'minor_pentatonic');
    const shortP = lengthToPitch(0.12, 'minor_pentatonic');
    expect(shortP.freq).toBeGreaterThan(midP.freq);
    expect(midP.freq).toBeGreaterThan(longP.freq);
  });

  it('supports smooth continuous pitch in fretless mode', () => {
    const a = lengthToPitch(0.40, 'fretless');
    const b = lengthToPitch(0.39, 'fretless');
    expect(b.freq).toBeGreaterThan(a.freq);
    expect(b.midi - a.midi).toBeLessThan(1.0);
  });

  it('detects consonant harmonic intervals for resonance arcs', () => {
    expect(detectHarmonicInterval(60, 72)).toBe('octave');
    expect(detectHarmonicInterval(60, 67)).toBe('fifth');
    expect(detectHarmonicInterval(60, 65)).toBe('fourth');
    expect(detectHarmonicInterval(60, 61)).toBeNull();
  });
});

describe('Geometry & One-Euro filter', () => {
  it('detects fast finger segment crossing a horizontal string', () => {
    const hit = intersectFingerWithString(
      { x: 0.5, y: 0.3 },
      { x: 0.5, y: 0.7 },
      { x: 0.2, y: 0.5 },
      { x: 0.8, y: 0.5 }
    );
    expect(hit).not.toBeNull();
    expect(hit!.point.x).toBeCloseTo(0.5, 4);
    expect(hit!.point.y).toBeCloseTo(0.5, 4);
    expect(hit!.uString).toBeCloseTo(0.5, 4);
    expect(hit!.normalSpeed).toBeCloseTo(0.4, 4);
  });

  it('returns null when finger does not cross string', () => {
    const miss = intersectFingerWithString(
      { x: 0.5, y: 0.1 },
      { x: 0.5, y: 0.3 },
      { x: 0.2, y: 0.5 },
      { x: 0.8, y: 0.5 }
    );
    expect(miss).toBeNull();
  });

  it('smooths high-frequency jitter while converging to target', () => {
    const f = new OneEuroFilter1D(1.5, 0.05);
    const out1 = f.filter(0.5, 0.0);
    const out2 = f.filter(0.55, 0.016);
    expect(out1).toBe(0.5);
    expect(out2).toBeGreaterThan(0.5);
    expect(out2).toBeLessThan(0.55);
  });
});

describe('StringManager gesture state machine', () => {
  it('creates a preview on two-hand pinch and commits string on release', () => {
    const mgr = new StringManager();
    const h0 = makeHand('hand-0', { pinchActive: true, pinchPos: { x: 0.25, y: 0.5 } });
    const h1 = makeHand('hand-1', { pinchActive: true, pinchPos: { x: 0.75, y: 0.5 } });

    const ev1 = mgr.update([h0, h1], [], 1 / 60, 100);
    expect(ev1.created).toHaveLength(0);
    expect(mgr.preview).not.toBeNull();
    expect(mgr.preview!.valid).toBe(true);

    // Release right hand pinch -> commits the string!
    h1.pinchActive = false;
    const ev2 = mgr.update([h0, h1], [], 1 / 60, 116);
    expect(ev2.created).toHaveLength(1);
    expect(mgr.strings).toHaveLength(1);
    expect(mgr.preview).toBeNull();
  });

  it('triggers pluck on finger crossing and enforces anti-jitter cooldown', () => {
    const mgr = new StringManager();
    mgr.addString({ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }, 0);

    const finger: ActiveFinger = {
      id: 'hand-0-8',
      handId: 'hand-0',
      landmarkIndex: 8,
      prevPos: { x: 0.5, y: 0.42 },
      pos: { x: 0.5, y: 0.58 },
      speed: 3.0,
      isPrimary: true,
    };
    const hand = makeHand('hand-0', { activeFingers: [finger] });

    const ev1 = mgr.update([hand], [], 1 / 60, 200);
    expect(ev1.plucks).toHaveLength(1);
    expect(ev1.plucks[0].velocity).toBeGreaterThan(0.5);

    // Immediate reverse jitter 20ms later should be blocked by cooldown
    finger.prevPos = { x: 0.5, y: 0.58 };
    finger.pos = { x: 0.5, y: 0.42 };
    const ev2 = mgr.update([hand], [], 1 / 60, 220);
    expect(ev2.plucks).toHaveLength(0);

    // After cooldown (>85ms), plucking works again
    const ev3 = mgr.update([hand], [], 1 / 60, 320);
    expect(ev3.plucks).toHaveLength(1);
  });

  it('grabs an endpoint with single-hand pinch, bends pitch higher when shortened, and deletes at edge', () => {
    const mgr = new StringManager();
    const s = mgr.addString({ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }, 0)!;
    const initialFreq = s.pitch.freq;

    // Grab right endpoint (0.75, 0.5)
    const hand = makeHand('hand-1', { pinchActive: true, pinchPos: { x: 0.74, y: 0.5 } });
    mgr.update([hand], [], 1 / 60, 100);
    expect(s.grabbedEnd).toBe(2);

    // Shorten string dramatically to (0.42, 0.5)
    hand.pinchPos = { x: 0.42, y: 0.5 };
    const evRetune = mgr.update([hand], [], 1 / 60, 116);
    expect(evRetune.retunes.length).toBeGreaterThan(0);
    expect(s.pitch.freq).toBeGreaterThan(initialFreq);

    // Drag endpoint into right delete border and hold briefly
    hand.pinchPos = { x: 0.99, y: 0.5 };
    let deletedCount = 0;
    for (let step = 0; step < 30; step++) {
      const ev = mgr.update([hand], [], 0.02, 200 + step * 20);
      deletedCount += ev.deletes.length;
    }
    expect(deletedCount).toBe(1);
    expect(mgr.strings).toHaveLength(0);
  });

  it('damps ringing string when open steady palm touches it (Palm Mute)', () => {
    const mgr = new StringManager();
    const s = mgr.addString({ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }, 0)!;
    s.energy = 0.9;
    s.amplitude = 0.8;

    const hand = makeHand('hand-0', {
      openPalm: true,
      palmCenter: { x: 0.5, y: 0.51 },
    });
    const ev = mgr.update([hand], [], 1 / 60, 500);
    expect(ev.mutes).toHaveLength(1);
    expect(s.energy).toBeLessThan(0.2);
  });

  it('loads all 4 string array presets cleanly', () => {
    const mgr = new StringManager();
    expect(mgr.loadPreset('harp').length).toBe(7);
    expect(mgr.loadPreset('guzheng').length).toBe(7);
    expect(mgr.loadPreset('web').length).toBe(6);
    expect(mgr.loadPreset('star').length).toBe(6);
  });
});
