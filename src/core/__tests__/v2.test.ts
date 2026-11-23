import { describe, expect, it } from 'vitest';
import processorSrc from '../../../public/audio/karplus-processor.js?raw';
import { MidiEngine, type MidiAccessLike, type MidiOutputLike } from '../../audio/MidiEngine';
import { AirLooper } from '../../music/AirLooper';
import type { PluckEvent } from '../../types';

function makePluck(overrides: Partial<PluckEvent> = {}): PluckEvent {
  return {
    stringId: 1,
    point: { x: 0.5, y: 0.5 },
    u: 0.5,
    velocity: 0.8,
    freq: 261.63,
    midi: 60,
    noteName: 'C4',
    pitchNorm: 0.5,
    pan: 0,
    pluckDir: 1,
    ...overrides,
  };
}

describe('V2 AirLooper', () => {
  it('runs a 1-bar count-in then automatically enters recording and locks into playback', () => {
    const looper = new AirLooper();
    looper.setBars(2);
    looper.setBpm(120); // 1 beat = 0.5s, 1 bar = 2.0s, 2-bar loop = 4.0s

    expect(looper.togglePrimaryAction()).toBe('count_in');

    // Advance 2.0s in 50ms steps -> should transition count_in -> recording
    let now = 0;
    let countInBeats = 0;
    for (let i = 0; i < 42; i++) {
      now += 50;
      const tick = looper.update(0.05, now);
      if (tick.beatTick?.isCountIn) countInBeats++;
    }
    expect(countInBeats).toBe(4);
    expect(looper.getState()).toBe('recording');

    // Record a note with 'guzheng' timbre at ~0.25 phase (1.0s into 4s loop)
    for (let i = 0; i < 18; i++) {
      now += 50;
      looper.update(0.05, now);
    }
    looper.recordPluck(makePluck({ midi: 63, noteName: 'Eb4' }), 'guzheng', now);

    // Finish remaining 3.1s of base loop -> auto-locks into 'playing'
    for (let i = 0; i < 65; i++) {
      now += 50;
      looper.update(0.05, now);
    }
    expect(looper.getState()).toBe('playing');
    expect(looper.getLayerCount()).toBe(1);

    // Advance through a full playback cycle and confirm the recorded note triggers once with 'guzheng' timbre
    const fired: string[] = [];
    for (let i = 0; i < 80; i++) {
      now += 50;
      const tick = looper.update(0.05, now);
      for (const ev of tick.triggers) {
        fired.push(`${ev.noteName}:${ev.timbre}`);
      }
    }
    expect(fired).toEqual(['Eb4:guzheng']);
  });

  it('supports multi-layer overdub without self-echo and cleanly undoes only the latest layer', () => {
    const looper = new AirLooper();
    looper.setBars(2);
    looper.setBpm(120); // 4.0s loop
    looper.togglePrimaryAction(); // count_in

    // Skip count-in (2.0s)
    let now = 0;
    for (let i = 0; i < 41; i++) {
      now += 50;
      looper.update(0.05, now);
    }
    expect(looper.getState()).toBe('recording');

    // Layer 0 note recorded at phase ~0.0125
    looper.recordPluck(makePluck({ midi: 60, noteName: 'C4' }), 'guitar', now);
    // Lock immediately to playing (still in cycle 0, no self-echo)
    expect(looper.togglePrimaryAction()).toBe('playing');
    // Enter overdub (Layer 1)
    expect(looper.togglePrimaryAction()).toBe('overdub');

    looper.recordPluck(makePluck({ midi: 67, noteName: 'G4' }), 'synth', now);
    // Immediate tiny tick in same cycle must NOT double-trigger newly recorded Layer 0 or Layer 1 notes
    const immediate = looper.update(0.02, now + 20);
    expect(immediate.triggers).toHaveLength(0);

    expect(looper.getLayerCount()).toBe(2);
    expect(looper.getEventCount()).toBe(2);

    // Advance one full 4.0s loop so playhead wraps to cycle 1 -> both Layer 0 & Layer 1 fire once!
    const replayed: string[] = [];
    for (let i = 0; i < 82; i++) {
      now += 50;
      const t = looper.update(0.05, now);
      for (const ev of t.triggers) replayed.push(`${ev.noteName}:${ev.timbre}`);
    }
    expect(replayed).toEqual(['C4:guitar', 'G4:synth']);

    // Undo latest layer removes only Layer 1 ('G4'), preserving Layer 0 ('C4')
    expect(looper.undoLastLayer()).toBe(1);
    expect(looper.getLayerCount()).toBe(1);
    expect(looper.getEventCount()).toBe(1);
  });

  it('computes BPM accurately via tapTempo and clamps within [60, 160]', () => {
    const looper = new AirLooper();
    looper.tapTempo(1000);
    looper.tapTempo(1500); // 500ms = 120 BPM
    expect(looper.tapTempo(2000)).toBe(120);
    expect(looper.tapTempo(2100)).toBeLessThanOrEqual(160);
  });
});

describe('V2 Web MIDI Engine', () => {
  function createMockMidi() {
    const sent: number[][] = [];
    const output: MidiOutputLike = {
      id: 'iac-1',
      name: 'IAC Driver Bus 1',
      manufacturer: 'Apple',
      send(data) {
        sent.push(Array.from(data));
      },
    };
    const access: MidiAccessLike = {
      outputs: new Map([[output.id, output]]),
      onstatechange: null,
    };
    const engine = new MidiEngine(async () => access);
    return { engine, sent };
  }

  it('sends Note On, 14-bit Pitch Bend, Legato retune, Note Off, and All Notes Off (CC123)', async () => {
    const { engine, sent } = createMockMidi();
    const res = await engine.connect();
    expect(res.ok).toBe(true);
    expect(engine.isEnabled()).toBe(true);
    expect(engine.getOutputs()).toHaveLength(1);

    // Trigger pluck on string 1 at C4 (MIDI 60)
    engine.noteOn(1, 60, 0.8);
    expect(sent.some((m) => m[0] === 0x90 && m[1] === 60 && m[2] === 102)).toBe(true);

    // Continuous fretless bend +1 semitone -> 14-bit Pitch Bend message (0xE0)
    sent.length = 0;
    engine.retune(1, 61.0, false);
    const bendMsg = sent.find((m) => m[0] === 0xe0);
    expect(bendMsg).toBeDefined();
    const bendVal = bendMsg![1] | (bendMsg![2] << 7);
    expect(bendVal).toBeGreaterThan(11000); // ~12288 (+1 semitone of ±2st range)

    // Quantized fret step -> Note Off old (60) + Note On new (63)
    sent.length = 0;
    engine.retune(1, 63, true);
    expect(sent.some((m) => m[0] === 0x80 && m[1] === 60)).toBe(true);
    expect(sent.some((m) => m[0] === 0x90 && m[1] === 63)).toBe(true);

    // Palm Mute -> immediate Note Off (63)
    sent.length = 0;
    engine.noteOff(1);
    expect(sent.some((m) => m[0] === 0x80 && m[1] === 63)).toBe(true);

    // Panic -> CC 123 (All Notes Off) + CC 120 (All Sound Off)
    sent.length = 0;
    engine.allNotesOff();
    expect(sent.some((m) => m[0] === 0xb0 && m[1] === 123)).toBe(true);
    expect(sent.some((m) => m[0] === 0xb0 && m[1] === 120)).toBe(true);
  });
});

describe('Karplus-Strong AudioWorklet DSP stability', () => {
  function loadProcessorClass() {
    let Registered: (new () => {
      port: { onmessage: ((ev: { data: unknown }) => void) | null };
      process: (inputs: unknown[], outputs: Float32Array[][]) => boolean;
    }) | null = null;

    class MockWorkletProcessor {
      port = { onmessage: null as ((ev: { data: unknown }) => void) | null };
    }

    const fn = new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', processorSrc);
    fn(
      MockWorkletProcessor,
      (_name: string, cls: typeof Registered) => {
        Registered = cls;
      },
      48000
    );
    return Registered!;
  }

  it('produces genuinely distinct acoustic signatures across all 5 timbres, decays cleanly, and hardStops immediately', () => {
    const ProcessorClass = loadProcessorClass();
    const timbres = ['harp', 'guzheng', 'guitar', 'synth', 'crystal'] as const;
    const hfRatioByTimbre: Record<string, number> = {};
    const attackRiseByTimbre: Record<string, number> = {};

    for (const timbre of timbres) {
      const proc = new ProcessorClass();
      const outL = new Float32Array(128);
      const outR = new Float32Array(128);

      // Pluck C4 (261.63 Hz) for spectral & envelope comparison
      proc.port.onmessage?.({
        data: {
          type: 'pluck',
          stringId: 1,
          freq: 261.63,
          velocity: 0.9,
          pluckPos: 0.35,
          pan: 0,
          timbre,
        },
      });

      const captureSamples = (blocks: number): Float32Array => {
        const buf = new Float32Array(blocks * 128);
        for (let b = 0; b < blocks; b++) {
          proc.process([], [[outL, outR]]);
          buf.set(outL, b * 128);
        }
        return buf;
      };

      const rmsOf = (buf: Float32Array) => {
        let s = 0;
        for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        return Math.sqrt(s / buf.length);
      };

      // High-frequency energy ratio via first-difference RMS / signal RMS (proxy for spectral brightness)
      const hfRatio = (buf: Float32Array) => {
        let diffSq = 0;
        let sigSq = 0;
        for (let i = 1; i < buf.length; i++) {
          const d = buf[i] - buf[i - 1];
          diffSq += d * d;
          sigSq += buf[i] * buf[i];
        }
        return Math.sqrt(diffSq / Math.max(1e-12, sigSq));
      };

      const head = captureSamples(60); // first ~160ms
      const attackRms = rmsOf(head);
      expect(attackRms, `${timbre} attack should be audible`).toBeGreaterThan(0.03);
      hfRatioByTimbre[timbre] = hfRatio(head);

      // Compare first 3ms vs 20-40ms to verify smooth mallet swell on crystal vs instant pluck
      const earlyRms = rmsOf(head.subarray(0, 144));
      const midRms = rmsOf(head.subarray(960, 1920));
      attackRiseByTimbre[timbre] = earlyRms / Math.max(1e-6, midRms);

      // Advance ~5 seconds total -> must strictly decay toward silence
      captureSamples(1815);
      const tail = captureSamples(40);
      const tailRms = rmsOf(tail);
      expect(tailRms, `${timbre} must decay strictly instead of sustaining forever`).toBeLessThan(
        attackRms * 0.25
      );
      expect(tailRms, `${timbre} tail should approach silence`).toBeLessThan(0.015);

      // Verify hardStop produces exact zero on the very next render block
      proc.port.onmessage?.({ data: { type: 'hardStop' } });
      const afterHardStop = rmsOf(captureSamples(4));
      expect(afterHardStop).toBe(0);
    }

    // Prove timbres are quantitatively distinct:
    // 1. Guzheng is significantly brighter than warm classical nylon guitar
    expect(hfRatioByTimbre.guzheng).toBeGreaterThan(hfRatioByTimbre.guitar * 1.6);
    // 2. Cyber synth has substantially higher harmonic density than warm guitar
    expect(hfRatioByTimbre.synth).toBeGreaterThan(hfRatioByTimbre.guitar * 1.3);
    // 3. Crystal bowl has a smooth velvet mallet onset (low early/mid ratio) compared to crisp plucked guzheng
    expect(attackRiseByTimbre.crystal).toBeLessThan(attackRiseByTimbre.guzheng * 0.45);
  });
});
