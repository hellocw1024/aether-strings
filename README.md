# AETHER STRINGS · 全息手势弹琴

A real-time WebGL2 HDR holographic air-string instrument powered by MediaPipe computer vision, Karplus-Strong / Modal Web Audio synthesis, Air Looper, and Web MIDI.

## Features

- **Air-String Gesture Instrument**: Pinch with both hands to draw glowing strings in mid-air, strum with extended fingers, drag endpoints to retune or delete at edges, palm-mute strings, and hold a closed fist to summon a 5-sector holographic timbre wheel with live audition.
- **5 Physical/Synth AudioWorklet Engines**: Ethereal Harp, Guzheng, Nylon Guitar, Cyber Synth, and Crystal Singing Bowl, plus 8 musical scales (`Pentatonic`, `Minor Pentatonic`, `Blues`, `Harmonic Minor`, `Melodic Minor`, `Major`, `Minor`, `Fretless`) and stereo space reverb.
- **Air Looper, Web MIDI & 2K Recording**: Multi-layer live loop overdubbing with HDR progress ring, DAW Web MIDI output, and native Full-HD / 2K (up to 2560px, 20 Mbps H.264 MP4) performance recording.
- **5 Artistic Worlds & Camera FX**: `Plasma`, `Ink Wash`, `Abyssal Caustics`, `Celestial Sigil`, and `Synthwave 1984`, with color-coded crisp Retina pitch labels at string endpoints.
- **Camera Stage Modes & Face-Swipe Switcher**:
  - `Cinema`, `Portrait Starfield`, `Matrix Digital Rain` (`cyber`), `3D Articulated X-Ray Skeleton & Jaw Tracking` (`xray`), `Natural` (`clean`), plus custom background image upload / drag-and-drop.
  - Swipe an open hand close across your face (left→right or right→left) to cycle through stage backgrounds.
- **10-Language Auto-Detected UI**: Chinese, English, Japanese, Korean, French, German, Italian, Spanish, Russian, and Arabic (with RTL layout), automatically matching browser language.
- **Offline-Ready Models**: Includes local MediaPipe WASM and Hand / Pose / Face / Selfie Segmentation models under `public/mediapipe/`.

## Quick Start

```bash
npm install
npm run dev
```

Open `http://localhost:5173/` in Chrome/Edge/Safari, grant camera permission for gesture play, or click the mouse/trackpad demo button to try immediately.

## Scripts

```bash
npm run dev        # Start local Vite dev server
npm run test       # Run Vitest unit & DSP test suite
npm run typecheck  # Run TypeScript strict type check
npm run build      # Build production bundle
```
