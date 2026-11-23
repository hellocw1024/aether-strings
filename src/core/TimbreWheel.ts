import type { TimbreId, TimbreWheelSnapshot, TrackedHand, Vec2 } from '../types';

export const TIMBRE_WHEEL_ORDER: TimbreId[] = [
  'harp',
  'guzheng',
  'guitar',
  'synth',
  'crystal',
];

export interface TimbreWheelEvents {
  snapshot: TimbreWheelSnapshot;
  opened: boolean;
  auditionTimbre: TimbreId | null;
  confirmedTimbre: TimbreId | null;
  suppressPluckHandId: string | null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Maps a cursor offset from the wheel anchor (in normalized space with y top->bottom)
 * into one of the 5 clockwise sectors starting at 12 o'clock (index 0 = UP),
 * or returns null when inside the center deadzone.
 */
export function resolveWheelSector(
  anchor: Vec2,
  cursor: Vec2,
  aspect: number,
  deadzone = 0.055
): number | null {
  const dx = (cursor.x - anchor.x) * Math.max(0.5, aspect);
  const dy = cursor.y - anchor.y;
  const r = Math.hypot(dx, dy);
  if (r < deadzone) return null;

  // Clockwise angle from straight UP (dx=0, dy=-1) in [0, 2*PI)
  const rawAng = Math.atan2(dx, -dy);
  const normAng = (rawAng + Math.PI * 2) % (Math.PI * 2);
  const sectorSpan = (Math.PI * 2) / TIMBRE_WHEEL_ORDER.length;
  return Math.floor(((normAng + sectorSpan * 0.5) % (Math.PI * 2)) / sectorSpan);
}

/**
 * State machine for the Iron-Man style "Closed Fist -> Holographic 5-Sector Timbre Wheel":
 * 1. Hold a closed fist steady for ~340ms -> wheel blooms open around the fist.
 * 2. Move fist toward any of the 5 glowing sectors -> highlights & plays live audition note.
 * 3. Open/release fist -> confirms the hovered timbre (or cancels if inside center deadzone).
 */
export class TimbreWheelController {
  private phase: 'idle' | 'charging' | 'open' = 'idle';
  private handId: string | null = null;
  private anchor: Vec2 = { x: 0.5, y: 0.5 };
  private cursor: Vec2 = { x: 0.5, y: 0.5 };
  private chargeStartMs = 0;
  private chargeStartPos: Vec2 = { x: 0.5, y: 0.5 };
  private chargeProgress = 0;
  private openAnim = 0;
  private hoveredIndex: number | null = null;
  private lastSeenHandMs = 0;
  private releaseStartMs: number | null = null;
  private suppressHandId: string | null = null;
  private suppressUntilMs = 0;

  private readonly chargeDurationMs = 340;
  private readonly maxChargeDrift = 0.085;
  private readonly releaseDebounceMs = 45;
  private readonly handLostTimeoutMs = 280;
  private readonly postReleaseSuppressMs = 280;
  private readonly deadzone = 0.055;

  isActive(): boolean {
    return this.phase === 'open';
  }

  reset(): void {
    this.phase = 'idle';
    this.handId = null;
    this.chargeProgress = 0;
    this.openAnim = 0;
    this.hoveredIndex = null;
    this.releaseStartMs = null;
  }

  update(
    hands: TrackedHand[],
    activeTimbre: TimbreId,
    blockedHandIds: ReadonlySet<string>,
    aspect: number,
    dtSec: number,
    nowMs: number
  ): TimbreWheelEvents {
    let opened = false;
    let auditionTimbre: TimbreId | null = null;
    let confirmedTimbre: TimbreId | null = null;

    if (this.phase === 'idle') {
      this.openAnim = Math.max(0, this.openAnim - dtSec * 8);
      for (const h of hands) {
        if (h.closedFist && !h.pinchActive && !blockedHandIds.has(h.id)) {
          this.phase = 'charging';
          this.handId = h.id;
          this.chargeStartMs = nowMs;
          this.chargeStartPos = { ...h.palmCenter };
          this.anchor = { ...h.palmCenter };
          this.cursor = { ...h.palmCenter };
          this.chargeProgress = 0;
          this.lastSeenHandMs = nowMs;
          break;
        }
      }
    } else if (this.phase === 'charging') {
      const h = hands.find((item) => item.id === this.handId);
      if (!h || !h.closedFist || h.pinchActive || blockedHandIds.has(h.id)) {
        this.reset();
      } else {
        this.lastSeenHandMs = nowMs;
        this.cursor = { ...h.palmCenter };
        this.anchor = { ...h.palmCenter };
        const drift = Math.hypot(
          h.palmCenter.x - this.chargeStartPos.x,
          h.palmCenter.y - this.chargeStartPos.y
        );
        if (drift > this.maxChargeDrift) {
          // Hand moved too fast -> re-anchor charge start instead of false-triggering
          this.chargeStartMs = nowMs;
          this.chargeStartPos = { ...h.palmCenter };
          this.chargeProgress = 0;
        } else {
          this.chargeProgress = clamp((nowMs - this.chargeStartMs) / this.chargeDurationMs, 0, 1);
          if (this.chargeProgress >= 1) {
            this.phase = 'open';
            this.openAnim = 0.05;
            this.hoveredIndex = null;
            this.releaseStartMs = null;
            // Clamp wheel center cleanly inside stage margins so all 5 petals & labels stay visible!
            this.anchor = {
              x: clamp(h.palmCenter.x, 0.22, 0.78),
              y: clamp(h.palmCenter.y, 0.27, 0.68),
            };
            this.cursor = { ...h.palmCenter };
            opened = true;
          }
        }
      }
    } else if (this.phase === 'open') {
      this.openAnim = Math.min(1, this.openAnim + dtSec * 6.5);
      const h = hands.find((item) => item.id === this.handId);

      if (!h) {
        if (nowMs - this.lastSeenHandMs > this.handLostTimeoutMs) {
          this.reset();
        }
      } else {
        this.lastSeenHandMs = nowMs;
        this.cursor = { ...h.palmCenter };

        // Check if user opened/released their fist to confirm selection
        const clearlyOpen = !h.closedFist && h.extendedFingers.length >= 2;
        if (clearlyOpen || !h.closedFist) {
          if (this.releaseStartMs === null) {
            this.releaseStartMs = nowMs;
          }
          if (clearlyOpen || nowMs - this.releaseStartMs >= this.releaseDebounceMs) {
            if (this.hoveredIndex !== null) {
              confirmedTimbre = TIMBRE_WHEEL_ORDER[this.hoveredIndex];
            }
            this.suppressHandId = h.id;
            this.suppressUntilMs = nowMs + this.postReleaseSuppressMs;
            this.reset();
          }
        } else {
          this.releaseStartMs = null;
          const nextSector = resolveWheelSector(this.anchor, this.cursor, aspect, this.deadzone);
          if (nextSector !== this.hoveredIndex) {
            this.hoveredIndex = nextSector;
            if (nextSector !== null) {
              auditionTimbre = TIMBRE_WHEEL_ORDER[nextSector];
            }
          }
        }
      }
    }

    const suppressPluckHandId =
      this.phase === 'open'
        ? this.handId
        : nowMs < this.suppressUntilMs
          ? this.suppressHandId
          : null;

    return {
      snapshot: {
        phase: this.phase,
        handId: this.handId,
        anchor: { ...this.anchor },
        cursor: { ...this.cursor },
        chargeProgress: this.chargeProgress,
        openAnim: this.openAnim,
        hoveredIndex: this.hoveredIndex,
        activeTimbre,
        sectors: TIMBRE_WHEEL_ORDER,
      },
      opened,
      auditionTimbre,
      confirmedTimbre,
      suppressPluckHandId,
    };
  }
}
