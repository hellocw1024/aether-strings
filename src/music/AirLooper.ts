import type {
  LoopBars,
  LoopRenderSnapshot,
  LoopState,
  MuteEvent,
  PluckEvent,
  RetuneEvent,
  TimbreId,
  Vec2,
} from '../types';

export interface RecordedLoopEvent {
  kind: 'pluck' | 'retune' | 'mute';
  phase: number; // [0, 1)
  layer: number;
  createdCycle: number;
  stringId: number;
  point: Vec2;
  u: number;
  velocity: number;
  freq: number;
  midi: number;
  noteName: string;
  pitchNorm: number;
  pan: number;
  pluckDir: number;
  timbre: TimbreId;
  stepChanged: boolean;
  lastFiredMs: number;
}

export interface LooperTickResult {
  triggers: RecordedLoopEvent[];
  beatTick: { beatIndex: number; isDownbeat: boolean; isCountIn: boolean } | null;
  stateChanged: boolean;
}

const BEATS_PER_BAR = 4;

export class AirLooper {
  private state: LoopState = 'idle';
  private bars: LoopBars = 4;
  private bpm = 100;
  private metronomeEnabled = true;

  private phase = 0; // [0, 1) within loop (or within 1-bar count-in)
  private cycleCount = 0;
  private currentLayer = 0;
  private lastBeatIndex = -1;
  private beatPulse = 0;

  private events: RecordedLoopEvent[] = [];
  private tapTimestamps: number[] = [];

  getState(): LoopState {
    return this.state;
  }

  getBars(): LoopBars {
    return this.bars;
  }

  getBpm(): number {
    return this.bpm;
  }

  isMetronomeEnabled(): boolean {
    return this.metronomeEnabled;
  }

  setMetronome(enabled: boolean): void {
    this.metronomeEnabled = enabled;
  }

  setBpm(bpm: number): void {
    this.bpm = Math.max(60, Math.min(160, Math.round(bpm)));
  }

  setBars(bars: LoopBars): void {
    if (this.state === 'idle' || this.events.length === 0) {
      this.bars = bars;
    } else {
      // Scale existing phase positions proportionally if changed mid-session
      const ratio = this.bars / bars;
      this.bars = bars;
      this.events = this.events
        .map((e) => ({ ...e, phase: e.phase * ratio }))
        .filter((e) => e.phase < 1);
      this.phase = Math.min(0.999, this.phase * ratio);
    }
  }

  getLoopDurationSec(): number {
    return this.bars * BEATS_PER_BAR * (60 / this.bpm);
  }

  getBarDurationSec(): number {
    return BEATS_PER_BAR * (60 / this.bpm);
  }

  getLayerCount(): number {
    if (this.events.length === 0) return 0;
    const layers = new Set(this.events.map((e) => e.layer));
    return layers.size;
  }

  getEventCount(): number {
    return this.events.length;
  }

  /**
   * Smart one-button transport control (also mapped to Spacebar):
   * - idle (empty) -> count_in -> recording -> auto-playing
   * - idle (has events) -> playing
   * - count_in -> idle (cancel)
   * - recording -> playing immediately
   * - playing -> overdub (new layer)
   * - overdub -> playing
   */
  togglePrimaryAction(): LoopState {
    if (this.state === 'idle') {
      if (this.events.length > 0) {
        this.state = 'playing';
        this.phase = 0;
        this.lastBeatIndex = -1;
        this.cycleCount++;
      } else {
        this.state = 'count_in';
        this.phase = 0;
        this.lastBeatIndex = -1;
        this.currentLayer = 0;
        this.cycleCount = 0;
      }
    } else if (this.state === 'count_in') {
      this.state = 'idle';
      this.phase = 0;
      this.lastBeatIndex = -1;
    } else if (this.state === 'recording') {
      this.state = this.events.length > 0 ? 'playing' : 'idle';
    } else if (this.state === 'playing') {
      this.currentLayer = this.getMaxLayer() + 1;
      this.state = 'overdub';
    } else if (this.state === 'overdub') {
      this.state = 'playing';
    }
    return this.state;
  }

  stop(): void {
    this.state = 'idle';
    this.phase = 0;
    this.lastBeatIndex = -1;
    this.beatPulse = 0;
  }

  clear(): void {
    this.events = [];
    this.currentLayer = 0;
    this.cycleCount = 0;
    this.stop();
  }

  undoLastLayer(): number {
    if (this.events.length === 0) return 0;
    const maxLayer = this.getMaxLayer();
    const before = this.events.length;
    this.events = this.events.filter((e) => e.layer !== maxLayer);
    if (this.events.length === 0 && (this.state === 'playing' || this.state === 'overdub')) {
      this.stop();
    }
    return before - this.events.length;
  }

  tapTempo(nowMs: number): number {
    if (
      this.tapTimestamps.length > 0 &&
      nowMs - this.tapTimestamps[this.tapTimestamps.length - 1] > 2200
    ) {
      this.tapTimestamps = [];
    }
    this.tapTimestamps.push(nowMs);
    if (this.tapTimestamps.length > 5) {
      this.tapTimestamps.shift();
    }
    if (this.tapTimestamps.length >= 2) {
      let sum = 0;
      for (let i = 1; i < this.tapTimestamps.length; i++) {
        sum += this.tapTimestamps[i] - this.tapTimestamps[i - 1];
      }
      const avgMs = sum / (this.tapTimestamps.length - 1);
      if (avgMs > 180) {
        this.setBpm(60000 / avgMs);
      }
    }
    return this.bpm;
  }

  recordPluck(ev: PluckEvent, timbre: TimbreId, nowMs: number): void {
    if (this.state !== 'recording' && this.state !== 'overdub') return;
    this.events.push({
      kind: 'pluck',
      phase: this.phase,
      layer: this.currentLayer,
      createdCycle: this.cycleCount,
      stringId: ev.stringId,
      point: { ...ev.point },
      u: ev.u,
      velocity: ev.velocity,
      freq: ev.freq,
      midi: ev.midi,
      noteName: ev.noteName,
      pitchNorm: ev.pitchNorm,
      pan: ev.pan,
      pluckDir: ev.pluckDir,
      timbre,
      stepChanged: false,
      lastFiredMs: nowMs,
    });
  }

  recordRetune(ev: RetuneEvent, timbre: TimbreId, nowMs: number): void {
    if (this.state !== 'recording' && this.state !== 'overdub') return;
    // Only capture meaningful pitch bends or quantized steps so event list stays lean
    if (!ev.stepChanged) return;
    this.events.push({
      kind: 'retune',
      phase: this.phase,
      layer: this.currentLayer,
      createdCycle: this.cycleCount,
      stringId: ev.stringId,
      point: { ...ev.point },
      u: 0.5,
      velocity: 0.5,
      freq: ev.freq,
      midi: ev.midi,
      noteName: ev.noteName,
      pitchNorm: ev.pitchNorm,
      pan: 0,
      pluckDir: 1,
      timbre,
      stepChanged: ev.stepChanged,
      lastFiredMs: nowMs,
    });
  }

  recordMute(ev: MuteEvent, timbre: TimbreId, nowMs: number): void {
    if (this.state !== 'recording' && this.state !== 'overdub') return;
    this.events.push({
      kind: 'mute',
      phase: this.phase,
      layer: this.currentLayer,
      createdCycle: this.cycleCount,
      stringId: ev.stringId,
      point: { ...ev.point },
      u: 0.5,
      velocity: 0,
      freq: 0,
      midi: 0,
      noteName: '',
      pitchNorm: 0.5,
      pan: 0,
      pluckDir: 1,
      timbre,
      stepChanged: false,
      lastFiredMs: nowMs,
    });
  }

  update(dtSec: number, nowMs: number): LooperTickResult {
    const result: LooperTickResult = {
      triggers: [],
      beatTick: null,
      stateChanged: false,
    };

    const safeDt = Math.max(0, Math.min(0.1, dtSec));
    this.beatPulse *= Math.exp(-8.0 * safeDt);
    if (this.beatPulse < 0.004) this.beatPulse = 0;

    if (this.state === 'idle') {
      return result;
    }

    if (this.state === 'count_in') {
      const barDur = this.getBarDurationSec();
      const nextPhase = this.phase + safeDt / barDur;
      const beatIdx = Math.min(BEATS_PER_BAR - 1, Math.floor(this.phase * BEATS_PER_BAR));
      if (beatIdx !== this.lastBeatIndex) {
        this.lastBeatIndex = beatIdx;
        this.beatPulse = beatIdx === 0 ? 1.0 : 0.65;
        result.beatTick = { beatIndex: beatIdx, isDownbeat: beatIdx === 0, isCountIn: true };
      }

      if (nextPhase >= 1) {
        this.state = 'recording';
        this.phase = nextPhase - 1;
        this.lastBeatIndex = 0;
        this.beatPulse = 1.0;
        result.stateChanged = true;
        result.beatTick = { beatIndex: 0, isDownbeat: true, isCountIn: false };
      } else {
        this.phase = nextPhase;
      }
      return result;
    }

    // Active loop states: recording | playing | overdub
    const loopDur = this.getLoopDurationSec();
    const prevPhase = this.phase;
    let nextPhase = prevPhase + safeDt / loopDur;
    let wrapped = false;

    if (nextPhase >= 1) {
      wrapped = true;
      nextPhase = nextPhase % 1;
      this.cycleCount++;
      if (this.state === 'recording') {
        // Automatically lock base loop and enter seamless playback
        this.state = this.events.length > 0 ? 'playing' : 'idle';
        result.stateChanged = true;
        if (this.state === 'idle') {
          this.phase = 0;
          return result;
        }
      }
    }

    // Collect loop events crossed in [prevPhase, nextPhase) with wrap-around handling
    if (this.state === 'playing' || this.state === 'overdub') {
      for (const ev of this.events) {
        // Never double-trigger an event in the same cycle it was just recorded
        if (ev.createdCycle >= this.cycleCount) continue;
        const hit = wrapped
          ? ev.phase >= prevPhase || ev.phase < nextPhase
          : ev.phase >= prevPhase && ev.phase < nextPhase;
        if (hit) {
          ev.lastFiredMs = nowMs;
          result.triggers.push(ev);
        }
      }
    }

    this.phase = nextPhase;

    // Beat / downbeat tick detection
    const totalBeats = this.bars * BEATS_PER_BAR;
    const beatIdx = Math.floor(this.phase * totalBeats) % totalBeats;
    if (beatIdx !== this.lastBeatIndex) {
      this.lastBeatIndex = beatIdx;
      const isDownbeat = beatIdx % BEATS_PER_BAR === 0;
      this.beatPulse = isDownbeat ? 0.95 : 0.42;
      if (this.metronomeEnabled || this.state === 'recording') {
        result.beatTick = { beatIndex: beatIdx, isDownbeat, isCountIn: false };
      }
    }

    return result;
  }

  getRenderSnapshot(): LoopRenderSnapshot {
    const countInBeat =
      this.state === 'count_in'
        ? Math.min(BEATS_PER_BAR, Math.floor(this.phase * BEATS_PER_BAR) + 1)
        : 0;
    return {
      state: this.state,
      phase: this.phase,
      countInBeat,
      bars: this.bars,
      bpm: this.bpm,
      layerCount: this.getLayerCount(),
      eventCount: this.events.length,
      beatPulse: this.beatPulse,
      events: this.events
        .filter((e) => e.kind === 'pluck')
        .map((e) => ({
          phase: e.phase,
          pitchNorm: e.pitchNorm,
          layer: e.layer,
          lastFiredMs: e.lastFiredMs,
        })),
    };
  }

  private getMaxLayer(): number {
    let max = -1;
    for (const e of this.events) {
      if (e.layer > max) max = e.layer;
    }
    return max;
  }
}
