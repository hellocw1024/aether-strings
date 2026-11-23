import { describe, expect, it } from 'vitest';
import {
  resolveWheelSector,
  TIMBRE_WHEEL_ORDER,
  TimbreWheelController,
} from '../TimbreWheel';
import type { TrackedHand } from '../../types';

function makeHand(overrides: Partial<TrackedHand>): TrackedHand {
  return {
    id: 'hand-0',
    handedness: 'Right',
    landmarks: Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 })),
    pinchActive: false,
    pinchPos: { x: 0.5, y: 0.5 },
    palmCenter: { x: 0.5, y: 0.5 },
    palmSize: 0.14,
    openPalm: false,
    backFacing: false,
    fiveFingersOpen: false,
    closedFist: true,
    extendedFingers: [],
    activeFingers: [],
    ...overrides,
  };
}

describe('Closed-Fist Holographic Timbre Wheel', () => {
  it('resolves all 5 clockwise sectors accurately and keeps center deadzone null', () => {
    const anchor = { x: 0.5, y: 0.5 };
    const aspect = 16 / 9;

    // Center deadzone -> cancel / null
    expect(resolveWheelSector(anchor, { x: 0.51, y: 0.51 }, aspect)).toBeNull();

    // 0: straight UP (12 o'clock) -> harp
    expect(resolveWheelSector(anchor, { x: 0.5, y: 0.35 }, aspect)).toBe(0);
    // 1: upper-right (~72°) -> guzheng
    expect(resolveWheelSector(anchor, { x: 0.62, y: 0.45 }, aspect)).toBe(1);
    // 2: lower-right (~144°) -> guitar
    expect(resolveWheelSector(anchor, { x: 0.57, y: 0.64 }, aspect)).toBe(2);
    // 3: lower-left (~216°) -> synth
    expect(resolveWheelSector(anchor, { x: 0.43, y: 0.64 }, aspect)).toBe(3);
    // 4: upper-left (~288°) -> crystal
    expect(resolveWheelSector(anchor, { x: 0.38, y: 0.45 }, aspect)).toBe(4);
  });

  it('charges on steady closed fist, opens after 340ms, auditions on hover, confirms on release, and suppresses immediate strums', () => {
    const wheel = new TimbreWheelController();
    const emptyBusy = new Set<string>();
    const aspect = 16 / 9;

    // 1. Start charging at t=1000
    let ev = wheel.update([makeHand({ palmCenter: { x: 0.5, y: 0.5 } })], 'harp', emptyBusy, aspect, 0.016, 1000);
    expect(ev.snapshot.phase).toBe('charging');
    expect(ev.opened).toBe(false);

    // 2. Hold steady past 340ms -> opens at t=1360
    ev = wheel.update([makeHand({ palmCenter: { x: 0.505, y: 0.502 } })], 'harp', emptyBusy, aspect, 0.016, 1360);
    expect(ev.snapshot.phase).toBe('open');
    expect(ev.opened).toBe(true);
    expect(ev.suppressPluckHandId).toBe('hand-0');

    // 3. Move fist toward lower-left (sector 3 = synth) -> fires audition once!
    ev = wheel.update([makeHand({ palmCenter: { x: 0.42, y: 0.64 } })], 'harp', emptyBusy, aspect, 0.016, 1420);
    expect(ev.snapshot.hoveredIndex).toBe(3);
    expect(ev.auditionTimbre).toBe(TIMBRE_WHEEL_ORDER[3]);

    // Holding on same sector does NOT spam audition
    ev = wheel.update([makeHand({ palmCenter: { x: 0.42, y: 0.64 } })], 'harp', emptyBusy, aspect, 0.016, 1460);
    expect(ev.auditionTimbre).toBeNull();

    // 4. Open fist -> confirms 'synth' and keeps post-release pluck suppression active!
    ev = wheel.update(
      [makeHand({ closedFist: false, extendedFingers: [8, 12, 16, 20], palmCenter: { x: 0.42, y: 0.64 } })],
      'harp',
      emptyBusy,
      aspect,
      0.016,
      1500
    );
    expect(ev.confirmedTimbre).toBe('synth');
    expect(ev.snapshot.phase).toBe('idle');
    expect(ev.suppressPluckHandId).toBe('hand-0');

    // 5. After 280ms post-release window, pluck suppression clears
    ev = wheel.update(
      [makeHand({ closedFist: false, extendedFingers: [8], palmCenter: { x: 0.42, y: 0.64 } })],
      'synth',
      emptyBusy,
      aspect,
      0.016,
      1850
    );
    expect(ev.suppressPluckHandId).toBeNull();
  });

  it('cancels cleanly when released in center deadzone or aborted before charge completes', () => {
    const wheel = new TimbreWheelController();
    const busy = new Set<string>(['hand-0']);

    // Busy hand (grabbing a string) must NOT arm the wheel
    let ev = wheel.update([makeHand({})], 'harp', busy, 16 / 9, 0.016, 1000);
    expect(ev.snapshot.phase).toBe('idle');

    // Brief fist < 340ms resets cleanly without opening
    const free = new Set<string>();
    wheel.update([makeHand({})], 'harp', free, 16 / 9, 0.016, 2000);
    ev = wheel.update([makeHand({ closedFist: false })], 'harp', free, 16 / 9, 0.016, 2200);
    expect(ev.snapshot.phase).toBe('idle');
    expect(ev.opened).toBe(false);

    // Open wheel then release inside deadzone -> cancels without changing timbre
    wheel.update([makeHand({ palmCenter: { x: 0.5, y: 0.5 } })], 'harp', free, 16 / 9, 0.016, 3000);
    wheel.update([makeHand({ palmCenter: { x: 0.5, y: 0.5 } })], 'harp', free, 16 / 9, 0.016, 3380);
    ev = wheel.update(
      [makeHand({ closedFist: false, extendedFingers: [8, 12, 16], palmCenter: { x: 0.5, y: 0.5 } })],
      'harp',
      free,
      16 / 9,
      0.016,
      3440
    );
    expect(ev.confirmedTimbre).toBeNull();
    expect(ev.snapshot.phase).toBe('idle');
  });
});
