export interface Vec2 {
  x: number; // normalized [0, 1] in mirrored stage space
  y: number; // normalized [0, 1]
}

export interface Vec3 extends Vec2 {
  z: number;
}

export type ScaleId =
  | 'pentatonic_cn'
  | 'minor_pentatonic'
  | 'blues'
  | 'harmonic_minor'
  | 'melodic_minor'
  | 'major'
  | 'minor'
  | 'fretless';

export type TimbreId = 'harp' | 'guzheng' | 'guitar' | 'synth' | 'crystal';

export type ThemeId = 'plasma' | 'ink' | 'abyss' | 'celestial' | 'synthwave';

export type ParticleShape = 'spark' | 'petal' | 'bubble' | 'star' | 'pixel';

export type ShockwaveShape = 'hex' | 'ink' | 'ripple' | 'sigil' | 'flare';

export type CameraFilterMode = 'cinema' | 'portrait' | 'cyber' | 'xray' | 'clean';

export type HandVisualMode = 'hologram' | 'classic' | 'minimal';

export type PresetId = 'harp' | 'guzheng' | 'web' | 'star';

export interface PitchInfo {
  freq: number;
  midi: number;
  noteIndex: number;
  noteName: string;
  pitchNorm: number; // 0 (lowest) .. 1 (highest)
  fretCount: number;
}

export interface AirString {
  id: number;
  p1: Vec2;
  p2: Vec2;
  length: number;
  pitch: PitchInfo;
  // Vibration & visual energy state
  amplitude: number; // 0..1 normalized displacement intensity
  phase: number;
  pluckPos: number; // 0..1 along string
  pluckDir: number; // +1 or -1 normal direction
  energy: number; // 0..1 glow intensity
  lastPluckTime: number;
  mutedUntil: number;
  // Grabbing state
  grabbedEnd: 1 | 2 | null;
  grabHandId: string | null;
  deleteProgress: number; // 0..1 visual warning when dragged near border
}

export interface PreviewString {
  p1: Vec2;
  p2: Vec2;
  length: number;
  pitch: PitchInfo;
  valid: boolean;
}

export interface ActiveFinger {
  id: string; // e.g. "hand0-8" or "mouse"
  handId: string;
  landmarkIndex: number;
  pos: Vec2;
  prevPos: Vec2;
  speed: number;
  isPrimary: boolean;
}

export interface TrackedHand {
  id: string;
  handedness: 'Left' | 'Right';
  landmarks: Vec3[]; // 21 mirrored normalized landmarks
  pinchActive: boolean;
  pinchPos: Vec2;
  palmCenter: Vec2;
  palmSize: number; // normalized dist(0, 9), depth proxy
  openPalm: boolean; // open flat hand (palm facing camera) for Palm Mute
  backFacing: boolean; // dorsal/back of hand facing camera
  fiveFingersOpen: boolean; // all 5 fingers clearly extended
  extendedFingers: number[]; // fingertip indices among [4, 8, 12, 16, 20]
  activeFingers: ActiveFinger[];
}

export interface PoseLandmark extends Vec3 {
  visibility: number;
}

export interface TrackedPose {
  landmarks: PoseLandmark[]; // 33 MediaPipe Pose landmarks (normalized video space, mirrored if mirror=true)
  timestampMs: number;
}

export interface TrackedFace {
  foreheadTop: Vec2;
  chinBottom: Vec2;
  cheekLeft: Vec2;
  cheekRight: Vec2;
  eyeLeft: Vec2;
  eyeRight: Vec2;
  noseTip: Vec2;
  upperLipInner: Vec2;
  lowerLipInner: Vec2;
  mouthLeft: Vec2;
  mouthRight: Vec2;
  pitch: number; // radians: nod up/down
  yaw: number; // radians: turn left/right
  roll: number; // radians: tilt
  jawOpen: number; // 0 (closed) .. 1 (wide open)
  jawShiftX: number; // -1 .. +1 lateral jaw slide
  mouthStretch: number; // 0 .. 1 mouth width stretch
  timestampMs: number;
}

export interface PluckEvent {
  stringId: number;
  point: Vec2;
  u: number;
  velocity: number; // 0..1
  freq: number;
  midi: number;
  noteName: string;
  pitchNorm: number;
  pan: number; // -1..1
  pluckDir: number;
}

export interface RetuneEvent {
  stringId: number;
  freq: number;
  midi: number;
  noteName: string;
  pitchNorm: number;
  stepChanged: boolean;
  point: Vec2;
}

export interface MuteEvent {
  stringId: number;
  point: Vec2;
}

export interface DeleteEvent {
  stringId: number;
  p1: Vec2;
  p2: Vec2;
  pitchNorm: number;
}

export interface ResonancePair {
  aId: number;
  bId: number;
  pA: Vec2;
  pB: Vec2;
  strength: number; // 0..1
  intervalName: 'octave' | 'fifth' | 'fourth';
  pitchNorm: number;
}

export type LoopState = 'idle' | 'count_in' | 'recording' | 'playing' | 'overdub';

export type LoopBars = 2 | 4 | 8;

export interface LoopVisualEvent {
  phase: number; // 0..1 around loop ring
  pitchNorm: number; // 0..1 for color
  layer: number;
  lastFiredMs: number;
}

export interface LoopRenderSnapshot {
  state: LoopState;
  phase: number; // 0..1 progress around ring
  countInBeat: number; // 1..4 during count_in
  bars: LoopBars;
  bpm: number;
  layerCount: number;
  eventCount: number;
  events: LoopVisualEvent[];
  beatPulse: number; // 0..1 decaying flash on every beat
}

export interface MidiPortInfo {
  id: string;
  name: string;
  manufacturer: string;
}

export interface AppSettings {
  scale: ScaleId;
  timbre: TimbreId;
  theme: ThemeId;
  cameraFilter: CameraFilterMode;
  handVisual: HandVisualMode;
  spaceFx: boolean;
  reverbAmount: number; // 0..1
  mirrorCamera: boolean;
  localMute: boolean;
}
