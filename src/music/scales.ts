import type { PitchInfo, ScaleId } from '../types';

export interface ScaleDefinition {
  id: ScaleId;
  label: string;
  shortLabel: string;
  intervals: number[]; // semitone offsets within an octave (empty for fretless)
  rootMidi: number; // lowest C3 = 48 (video spans ~D#3 to C6)
  octaves: number;
}

export const SCALES: Record<ScaleId, ScaleDefinition> = {
  pentatonic_cn: {
    id: 'pentatonic_cn',
    label: '中国五声宫调',
    shortLabel: '中国五声',
    intervals: [0, 2, 4, 7, 9], // C, D, E, G, A
    rootMidi: 48, // C3
    octaves: 3,
  },
  minor_pentatonic: {
    id: 'minor_pentatonic',
    label: '小调五声音阶 (Minor Pentatonic)',
    shortLabel: '小调五声',
    intervals: [0, 3, 5, 7, 10], // C, Eb, F, G, Bb
    rootMidi: 48,
    octaves: 3,
  },
  blues: {
    id: 'blues',
    label: '蓝调音阶 (Blues Scale)',
    shortLabel: '蓝调',
    intervals: [0, 3, 5, 6, 7, 10], // C, Eb, F, F#, G, Bb
    rootMidi: 48,
    octaves: 3,
  },
  harmonic_minor: {
    id: 'harmonic_minor',
    label: '和声小调 (Harmonic Minor)',
    shortLabel: '和声小调',
    intervals: [0, 2, 3, 5, 7, 8, 11], // C, D, Eb, F, G, Ab, B
    rootMidi: 48,
    octaves: 3,
  },
  melodic_minor: {
    id: 'melodic_minor',
    label: '旋律小调 (Melodic Minor)',
    shortLabel: '旋律小调',
    intervals: [0, 2, 3, 5, 7, 9, 11], // C, D, Eb, F, G, A, B
    rootMidi: 48,
    octaves: 3,
  },
  major: {
    id: 'major',
    label: 'C 自然大调',
    shortLabel: '自然大调',
    intervals: [0, 2, 4, 5, 7, 9, 11],
    rootMidi: 48,
    octaves: 3,
  },
  minor: {
    id: 'minor',
    label: 'C 自然小调',
    shortLabel: '自然小调',
    intervals: [0, 2, 3, 5, 7, 8, 10],
    rootMidi: 48,
    octaves: 3,
  },
  fretless: {
    id: 'fretless',
    label: '无品连续滑音',
    shortLabel: '无品滑音',
    intervals: [],
    rootMidi: 48,
    octaves: 3,
  },
};

const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

// Typical comfortable normalized string lengths on desktop/webcam viewports:
// ~0.11 (short high crystalline treble) to ~0.72 (wide bass string across frame)
export const MIN_STRING_LENGTH = 0.10;
export const MAX_STRING_LENGTH = 0.72;

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function midiToNoteName(midi: number): string {
  const rounded = Math.round(midi);
  const name = NOTE_NAMES[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return `${name}${octave}`;
}

export function buildScaleMidiTable(scaleId: ScaleId): number[] {
  const def = SCALES[scaleId];
  if (def.intervals.length === 0) return [];
  const table: number[] = [];
  for (let oct = 0; oct < def.octaves; oct++) {
    for (const iv of def.intervals) {
      table.push(def.rootMidi + oct * 12 + iv);
    }
  }
  // Include top octave root (e.g. C6 = 84)
  table.push(def.rootMidi + def.octaves * 12);
  return table;
}

/**
 * Physics-inspired mapping: shorter string => higher frequency.
 * Uses logarithmic length mapping so equal fractional shortening yields equal pitch steps,
 * matching real stringed instruments (f ~ 1 / L).
 */
export function lengthToPitch(length: number, scaleId: ScaleId): PitchInfo {
  const clamped = Math.min(MAX_STRING_LENGTH, Math.max(MIN_STRING_LENGTH, length));
  // Log-inverse mapping: 0 at MAX_STRING_LENGTH (lowest pitch), 1 at MIN_STRING_LENGTH (highest pitch)
  const logMin = Math.log(MIN_STRING_LENGTH);
  const logMax = Math.log(MAX_STRING_LENGTH);
  const pitchNorm = Math.min(1, Math.max(0, (logMax - Math.log(clamped)) / (logMax - logMin)));

  const def = SCALES[scaleId];
  const fretCount = Math.max(6, Math.min(20, Math.round(clamped * 28)));

  if (scaleId === 'fretless' || def.intervals.length === 0) {
    const minMidi = def.rootMidi;
    const maxMidi = def.rootMidi + def.octaves * 12;
    const midi = minMidi + pitchNorm * (maxMidi - minMidi);
    const freq = midiToFreq(midi);
    return {
      freq,
      midi,
      noteIndex: Math.round(midi * 4),
      noteName: midiToNoteName(midi),
      pitchNorm,
      fretCount,
    };
  }

  const table = buildScaleMidiTable(scaleId);
  const idx = Math.min(table.length - 1, Math.max(0, Math.round(pitchNorm * (table.length - 1))));
  const midi = table[idx];
  const freq = midiToFreq(midi);
  const quantizedNorm = table.length > 1 ? idx / (table.length - 1) : 0.5;

  return {
    freq,
    midi,
    noteIndex: idx,
    noteName: midiToNoteName(midi),
    pitchNorm: quantizedNorm,
    fretCount,
  };
}

/**
 * Checks whether two MIDI notes form a strong consonant harmonic interval
 * (octave, perfect fifth, or perfect fourth) for visual resonance arcs.
 */
export function detectHarmonicInterval(
  midiA: number,
  midiB: number
): 'octave' | 'fifth' | 'fourth' | null {
  const diff = Math.abs(Math.round(midiA) - Math.round(midiB));
  if (diff === 0) return null;
  const mod = diff % 12;
  if (mod === 0) return 'octave';
  if (mod === 7) return 'fifth';
  if (mod === 5) return 'fourth';
  return null;
}
