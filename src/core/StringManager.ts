import {
  aspectDistance,
  closestPointOnSegment,
  distance,
  intersectFingerWithString,
  midpoint,
} from './geometry';
import {
  detectHarmonicInterval,
  lengthToPitch,
  MIN_STRING_LENGTH,
} from '../music/scales';
import type {
  ActiveFinger,
  AirString,
  DeleteEvent,
  MuteEvent,
  PluckEvent,
  PresetId,
  PreviewString,
  ResonancePair,
  RetuneEvent,
  ScaleId,
  TrackedHand,
  Vec2,
} from '../types';

export interface FrameEvents {
  plucks: PluckEvent[];
  retunes: RetuneEvent[];
  mutes: MuteEvent[];
  deletes: DeleteEvent[];
  created: AirString[];
}

const ENDPOINT_GRAB_RADIUS = 0.068;
const PLUCK_COOLDOWN_MS = 85;
const MUTE_COOLDOWN_MS = 260;
const PALM_MUTE_RADIUS = 0.055;
const DELETE_BORDER_MARGIN = 0.042;
const MAX_STRINGS = 16;

export class StringManager {
  public strings: AirString[] = [];
  public preview: PreviewString | null = null;
  public resonances: ResonancePair[] = [];

  private nextId = 1;
  private scaleId: ScaleId = 'pentatonic_cn';
  private aspect = 16 / 9;

  // Per (fingerId:stringId) last pluck timestamp (ms)
  private pluckCooldowns = new Map<string, number>();

  // Track two-hand string creation session
  private creatingWithHands = false;
  private lastValidPreview: PreviewString | null = null;

  // Pointer-based creation & grab state (for mouse/trackpad play)
  private pointerCreating = false;
  private pointerStart: Vec2 | null = null;

  setScale(scaleId: ScaleId): void {
    this.scaleId = scaleId;
    for (const s of this.strings) {
      s.pitch = lengthToPitch(s.length, this.scaleId);
    }
    if (this.preview) {
      this.preview.pitch = lengthToPitch(this.preview.length, this.scaleId);
    }
  }

  getScale(): ScaleId {
    return this.scaleId;
  }

  setAspect(aspect: number): void {
    if (Number.isFinite(aspect) && aspect > 0.2) {
      this.aspect = aspect;
    }
  }

  private computeLength(p1: Vec2, p2: Vec2): number {
    return aspectDistance(p1, p2, this.aspect);
  }

  addString(p1: Vec2, p2: Vec2, nowMs = performance.now()): AirString | null {
    const length = this.computeLength(p1, p2);
    if (length < MIN_STRING_LENGTH) return null;

    if (this.strings.length >= MAX_STRINGS) {
      this.strings.shift();
    }

    const str: AirString = {
      id: this.nextId++,
      p1: { ...p1 },
      p2: { ...p2 },
      length,
      pitch: lengthToPitch(length, this.scaleId),
      amplitude: 0.25,
      phase: 0,
      pluckPos: 0.5,
      pluckDir: 1,
      energy: 0.45,
      lastPluckTime: nowMs,
      mutedUntil: 0,
      grabbedEnd: null,
      grabHandId: null,
      deleteProgress: 0,
    };
    this.strings.push(str);
    return str;
  }

  removeStringById(id: number): DeleteEvent | null {
    const idx = this.strings.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    const [removed] = this.strings.splice(idx, 1);
    return {
      stringId: removed.id,
      p1: { ...removed.p1 },
      p2: { ...removed.p2 },
      pitchNorm: removed.pitch.pitchNorm,
    };
  }

  undoLastString(): DeleteEvent | null {
    if (this.strings.length === 0) return null;
    const last = this.strings[this.strings.length - 1];
    return this.removeStringById(last.id);
  }

  clearAll(): DeleteEvent[] {
    const events: DeleteEvent[] = this.strings.map((s) => ({
      stringId: s.id,
      p1: { ...s.p1 },
      p2: { ...s.p2 },
      pitchNorm: s.pitch.pitchNorm,
    }));
    this.strings = [];
    this.preview = null;
    this.resonances = [];
    this.creatingWithHands = false;
    this.lastValidPreview = null;
    return events;
  }

  loadPreset(preset: PresetId, nowMs = performance.now()): AirString[] {
    this.clearAll();
    const pairs: [Vec2, Vec2][] = [];

    if (preset === 'harp') {
      // Ergonomic fan harp: 7 graduated strings spanning bass -> crystalline treble
      const count = 7;
      for (let i = 0; i < count; i++) {
        const t = i / (count - 1);
        const y = 0.19 + t * 0.60;
        const halfSpan = 0.075 + t * 0.29;
        const tilt = (0.5 - t) * 0.05;
        pairs.push([
          { x: 0.5 - halfSpan, y: y - tilt },
          { x: 0.5 + halfSpan, y: y + tilt },
        ]);
      }
    } else if (preset === 'guzheng') {
      // Classic horizontal parallel 7-string guzheng rack spanning full 3-octave scale
      const count = 7;
      for (let i = 0; i < count; i++) {
        const t = i / (count - 1);
        const y = 0.20 + t * 0.58;
        const halfSpan = 0.075 + t * 0.295;
        pairs.push([
          { x: 0.5 - halfSpan, y },
          { x: 0.5 + halfSpan, y },
        ]);
      }
    } else if (preset === 'web') {
      // Inspired by the video's intersecting 6-string constellation (full color & pitch spectrum!)
      pairs.push(
        [{ x: 0.40, y: 0.22 }, { x: 0.56, y: 0.24 }], // high crystalline magenta treble
        [{ x: 0.34, y: 0.34 }, { x: 0.61, y: 0.31 }], // warm gold upper-mid
        [{ x: 0.20, y: 0.56 }, { x: 0.72, y: 0.24 }], // long diagonal emerald lead
        [{ x: 0.35, y: 0.56 }, { x: 0.55, y: 0.68 }], // bright gold-magenta accent
        [{ x: 0.49, y: 0.69 }, { x: 0.75, y: 0.51 }], // emerald-gold counter voice
        [{ x: 0.13, y: 0.80 }, { x: 0.85, y: 0.77 }]  // deep electric-cyan bass anchor
      );
    } else if (preset === 'star') {
      // 6-string orbital constellation spanning short treble chords to wide bass chords
      const cx = 0.5;
      const cy = 0.5;
      const chords: [number, number, number][] = [
        [-2.35, -0.30, 0.39], // deep bass
        [-1.85, 0.08, 0.35],
        [-1.15, 0.60, 0.31],
        [-0.30, 1.18, 0.27],
        [0.55, 1.75, 0.23],
        [1.45, 2.38, 0.19],  // bright high treble
      ];
      for (const [a1, a2, radius] of chords) {
        pairs.push([
          { x: cx + Math.cos(a1) * radius * 1.12, y: cy + Math.sin(a1) * radius * 0.94 },
          { x: cx + Math.cos(a2) * radius * 1.12, y: cy + Math.sin(a2) * radius * 0.94 },
        ]);
      }
    }

    const created: AirString[] = [];
    for (const [a, b] of pairs) {
      const s = this.addString(a, b, nowMs);
      if (s) created.push(s);
    }
    return created;
  }

  /**
   * Main per-frame update taking tracked hands and optional extra pointer finger(s).
   */
  update(
    hands: TrackedHand[],
    extraFingers: ActiveFinger[],
    dtSec: number,
    nowMs: number
  ): FrameEvents {
    const events: FrameEvents = {
      plucks: [],
      retunes: [],
      mutes: [],
      deletes: [],
      created: [],
    };

    const safeDt = Math.max(1 / 240, Math.min(0.1, dtSec));

    // 1. Decay vibrating string physics
    for (const str of this.strings) {
      // Higher pitched strings decay slightly faster visually, like physical acoustics
      const decayRate = 1.65 + str.pitch.pitchNorm * 1.45;
      str.amplitude *= Math.exp(-decayRate * safeDt);
      str.energy *= Math.exp(-decayRate * 0.82 * safeDt);
      if (str.amplitude < 0.002) str.amplitude = 0;
      if (str.energy < 0.002) str.energy = 0;
      // Visual standing-wave phase oscillation (scaled down from audio Hz so waves look crisp)
      const visFreq = 9 + str.pitch.pitchNorm * 22;
      str.phase += safeDt * visFreq * Math.PI * 2;
    }

    // 2. Process hand pinch gestures (grab existing endpoint vs two-hand create string)
    this.processHandPinches(hands, safeDt, nowMs, events);

    // 3. Process Palm Mute (open steady palm touching a vibrating string)
    this.processPalmMute(hands, nowMs, events);

    // 4. Process finger plucking & multi-finger strumming
    const pluckFingers: ActiveFinger[] = [...extraFingers];
    for (const hand of hands) {
      // Skip hands currently pinching or open-palm muting
      if (hand.pinchActive || hand.openPalm) continue;
      for (const f of hand.activeFingers) {
        pluckFingers.push(f);
      }
    }

    this.processPlucks(pluckFingers, safeDt, nowMs, events);

    // 5. Detect consonant harmonic resonances between actively vibrating strings
    this.updateResonances();

    return events;
  }

  private processHandPinches(
    hands: TrackedHand[],
    dtSec: number,
    nowMs: number,
    events: FrameEvents
  ): void {
    const pinchingHands = hands.filter((h) => h.pinchActive);
    const activeHandIds = new Set(pinchingHands.map((h) => h.id));

    // Release any endpoint whose hand stopped pinching (check flick/border delete on release)
    const toDeleteIds: number[] = [];
    for (const str of this.strings) {
      if (str.grabHandId && str.grabHandId !== 'pointer') {
        if (!activeHandIds.has(str.grabHandId)) {
          if (str.deleteProgress >= 0.85) {
            toDeleteIds.push(str.id);
          } else {
            str.grabHandId = null;
            str.grabbedEnd = null;
            str.deleteProgress = 0;
          }
        }
      }
    }
    for (const id of toDeleteIds) {
      const del = this.removeStringById(id);
      if (del) events.deletes.push(del);
    }

    // Update currently grabbed endpoints by hands
    const handsGrabbing = new Set<string>();
    for (const str of this.strings) {
      if (!str.grabHandId || str.grabHandId === 'pointer') continue;
      const hand = pinchingHands.find((h) => h.id === str.grabHandId);
      if (!hand || !str.grabbedEnd) continue;
      handsGrabbing.add(hand.id);
      const deleted = this.moveGrabbedEndpoint(str, hand.pinchPos, dtSec, nowMs, events);
      if (deleted) {
        handsGrabbing.delete(hand.id);
      }
    }

    // If a non-grabbing hand is pinching AND we aren't already in 2-hand creation, try grabbing an endpoint
    if (!this.creatingWithHands) {
      for (const hand of pinchingHands) {
        if (handsGrabbing.has(hand.id)) continue;
        const hit = this.findNearestFreeEndpoint(hand.pinchPos, ENDPOINT_GRAB_RADIUS);
        if (hit) {
          hit.string.grabHandId = hand.id;
          hit.string.grabbedEnd = hit.end;
          handsGrabbing.add(hand.id);
        }
      }
    }

    // Two-hand string creation: both hands pinching and NEITHER is grabbing an endpoint
    const freePinchers = pinchingHands.filter((h) => !handsGrabbing.has(h.id));
    if (freePinchers.length >= 2) {
      const p1 = freePinchers[0].pinchPos;
      const p2 = freePinchers[1].pinchPos;
      const length = this.computeLength(p1, p2);
      const valid = length >= MIN_STRING_LENGTH;
      this.creatingWithHands = true;
      this.preview = {
        p1: { ...p1 },
        p2: { ...p2 },
        length,
        pitch: lengthToPitch(length, this.scaleId),
        valid,
      };
      if (valid) {
        this.lastValidPreview = {
          ...this.preview,
          p1: { ...p1 },
          p2: { ...p2 },
        };
      }
    } else if (this.creatingWithHands) {
      // User released at least one pinch -> commit the preview string!
      const toCommit = this.preview?.valid ? this.preview : this.lastValidPreview;
      if (toCommit && toCommit.valid) {
        const created = this.addString(toCommit.p1, toCommit.p2, nowMs);
        if (created) {
          events.created.push(created);
        }
      }
      this.creatingWithHands = false;
      this.preview = null;
      this.lastValidPreview = null;
    }
  }

  private moveGrabbedEndpoint(
    str: AirString,
    newPos: Vec2,
    dtSec: number,
    nowMs: number,
    events: FrameEvents
  ): boolean {
    const prevNoteIndex = str.pitch.noteIndex;
    const prevFreq = str.pitch.freq;

    if (str.grabbedEnd === 1) {
      str.p1 = { x: newPos.x, y: newPos.y };
    } else if (str.grabbedEnd === 2) {
      str.p2 = { x: newPos.x, y: newPos.y };
    }

    // Check border delete zone (pull endpoint to screen edge to dissolve string)
    const inDeleteZone =
      newPos.x < DELETE_BORDER_MARGIN ||
      newPos.x > 1 - DELETE_BORDER_MARGIN ||
      newPos.y < DELETE_BORDER_MARGIN ||
      newPos.y > 1 - DELETE_BORDER_MARGIN;

    if (inDeleteZone) {
      str.deleteProgress = Math.min(1, str.deleteProgress + dtSec * 3.8);
      if (str.deleteProgress >= 1) {
        const del = this.removeStringById(str.id);
        if (del) events.deletes.push(del);
        return true;
      }
    } else {
      str.deleteProgress = Math.max(0, str.deleteProgress - dtSec * 5.0);
    }

    str.length = this.computeLength(str.p1, str.p2);
    str.pitch = lengthToPitch(str.length, this.scaleId);

    const stepChanged = str.pitch.noteIndex !== prevNoteIndex;
    const freqChanged = Math.abs(str.pitch.freq - prevFreq) > 0.35;

    if (stepChanged || freqChanged) {
      if (stepChanged && str.energy > 0.04) {
        // Re-energize visual wave slightly on fret-crossing slide, like video 00:14-00:18
        str.amplitude = Math.min(1, Math.max(str.amplitude, 0.32));
        str.energy = Math.min(1, Math.max(str.energy, 0.55));
        str.lastPluckTime = nowMs;
      }
      events.retunes.push({
        stringId: str.id,
        freq: str.pitch.freq,
        midi: str.pitch.midi,
        noteName: str.pitch.noteName,
        pitchNorm: str.pitch.pitchNorm,
        stepChanged,
        point: midpoint(str.p1, str.p2),
      });
    }

    return false;
  }

  private processPalmMute(hands: TrackedHand[], nowMs: number, events: FrameEvents): void {
    for (const hand of hands) {
      if (!hand.openPalm || hand.pinchActive) continue;
      for (const str of this.strings) {
        if (str.energy < 0.06 || nowMs < str.mutedUntil) continue;
        const closest = closestPointOnSegment(hand.palmCenter, str.p1, str.p2);
        if (closest.dist <= PALM_MUTE_RADIUS) {
          str.amplitude *= 0.12;
          str.energy *= 0.15;
          str.mutedUntil = nowMs + MUTE_COOLDOWN_MS;
          events.mutes.push({
            stringId: str.id,
            point: closest.point,
          });
        }
      }
    }
  }

  private processPlucks(
    fingers: ActiveFinger[],
    dtSec: number,
    nowMs: number,
    events: FrameEvents
  ): void {
    for (const finger of fingers) {
      // Ignore microscopic sensor jitter
      const moveDist = distance(finger.prevPos, finger.pos);
      if (moveDist < 0.0018) continue;

      for (const str of this.strings) {
        if (nowMs < str.mutedUntil) continue;
        const hit = intersectFingerWithString(finger.prevPos, finger.pos, str.p1, str.p2);
        if (!hit) continue;

        const key = `${finger.id}:${str.id}`;
        const lastTime = this.pluckCooldowns.get(key) ?? -Infinity;
        if (nowMs - lastTime < PLUCK_COOLDOWN_MS) continue;
        this.pluckCooldowns.set(key, nowMs);

        // Normalize perpendicular speed into musical velocity [0.22, 1.0]
        const speedPerSec = hit.normalSpeed / dtSec;
        const velocity = Math.min(1, Math.max(0.22, 0.22 + (speedPerSec / 2.2) * 0.78));

        str.amplitude = Math.min(1, Math.max(str.amplitude * 0.45 + velocity * 0.85, velocity));
        str.energy = Math.min(1, Math.max(str.energy * 0.35 + velocity * 0.9, velocity));
        str.pluckPos = hit.uString;
        str.pluckDir = hit.pluckDir;
        str.phase = 0;
        str.lastPluckTime = nowMs;

        const center = midpoint(str.p1, str.p2);
        const pan = Math.max(-0.85, Math.min(0.85, (center.x * 2 - 1) * 0.85));

        events.plucks.push({
          stringId: str.id,
          point: hit.point,
          u: hit.uString,
          velocity,
          freq: str.pitch.freq,
          midi: str.pitch.midi,
          noteName: str.pitch.noteName,
          pitchNorm: str.pitch.pitchNorm,
          pan,
          pluckDir: hit.pluckDir,
        });
      }
    }
  }

  private updateResonances(): void {
    const active = this.strings.filter((s) => s.energy > 0.24);
    const pairs: ResonancePair[] = [];

    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i];
        const b = active[j];
        const interval = detectHarmonicInterval(a.pitch.midi, b.pitch.midi);
        if (!interval) continue;
        const strength = Math.min(1, Math.sqrt(a.energy * b.energy));
        if (strength < 0.26) continue;

        const pA = midpoint(a.p1, a.p2);
        const pB = midpoint(b.p1, b.p2);
        pairs.push({
          aId: a.id,
          bId: b.id,
          pA,
          pB,
          strength,
          intervalName: interval,
          pitchNorm: (a.pitch.pitchNorm + b.pitch.pitchNorm) * 0.5,
        });
      }
    }

    // Keep top 4 strongest harmonic arcs so visuals stay pristine
    pairs.sort((x, y) => y.strength - x.strength);
    this.resonances = pairs.slice(0, 4);
  }

  private findNearestFreeEndpoint(
    pos: Vec2,
    maxDist: number
  ): { string: AirString; end: 1 | 2; dist: number } | null {
    let best: { string: AirString; end: 1 | 2; dist: number } | null = null;
    for (const s of this.strings) {
      if (s.grabHandId !== null) continue;
      const d1 = distance(pos, s.p1);
      if (d1 < maxDist && (!best || d1 < best.dist)) {
        best = { string: s, end: 1, dist: d1 };
      }
      const d2 = distance(pos, s.p2);
      if (d2 < maxDist && (!best || d2 < best.dist)) {
        best = { string: s, end: 2, dist: d2 };
      }
    }
    return best;
  }

  // --- Mouse / Trackpad seamless control helpers ---

  pointerDown(pos: Vec2, forceCreate: boolean): 'grab' | 'create' | 'none' {
    if (!forceCreate) {
      const hit = this.findNearestFreeEndpoint(pos, ENDPOINT_GRAB_RADIUS * 0.85);
      if (hit) {
        hit.string.grabHandId = 'pointer';
        hit.string.grabbedEnd = hit.end;
        return 'grab';
      }
    }
    if (forceCreate) {
      this.pointerCreating = true;
      this.pointerStart = { ...pos };
      this.preview = {
        p1: { ...pos },
        p2: { ...pos },
        length: 0,
        pitch: lengthToPitch(MIN_STRING_LENGTH, this.scaleId),
        valid: false,
      };
      return 'create';
    }
    return 'none';
  }

  pointerMove(pos: Vec2, dtSec: number, nowMs: number): FrameEvents {
    const events: FrameEvents = {
      plucks: [],
      retunes: [],
      mutes: [],
      deletes: [],
      created: [],
    };

    if (this.pointerCreating && this.pointerStart) {
      const length = this.computeLength(this.pointerStart, pos);
      this.preview = {
        p1: { ...this.pointerStart },
        p2: { ...pos },
        length,
        pitch: lengthToPitch(length, this.scaleId),
        valid: length >= MIN_STRING_LENGTH,
      };
      return events;
    }

    const grabbed = this.strings.find((s) => s.grabHandId === 'pointer');
    if (grabbed) {
      this.moveGrabbedEndpoint(grabbed, pos, Math.max(1 / 120, dtSec), nowMs, events);
    }

    return events;
  }

  pointerUp(nowMs = performance.now()): FrameEvents {
    const events: FrameEvents = {
      plucks: [],
      retunes: [],
      mutes: [],
      deletes: [],
      created: [],
    };

    if (this.pointerCreating) {
      if (this.preview && this.preview.valid) {
        const created = this.addString(this.preview.p1, this.preview.p2, nowMs);
        if (created) events.created.push(created);
      }
      this.pointerCreating = false;
      this.pointerStart = null;
      this.preview = null;
    }

    const grabbed = this.strings.find((s) => s.grabHandId === 'pointer');
    if (grabbed) {
      if (grabbed.deleteProgress >= 0.85) {
        const del = this.removeStringById(grabbed.id);
        if (del) events.deletes.push(del);
      } else {
        grabbed.grabHandId = null;
        grabbed.grabbedEnd = null;
        grabbed.deleteProgress = 0;
      }
    }

    return events;
  }

  isPointerBusy(): boolean {
    return this.pointerCreating || this.strings.some((s) => s.grabHandId === 'pointer');
  }
}
