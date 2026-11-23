import './style.css';
import { AudioEngine } from './audio/AudioEngine';
import { MidiEngine } from './audio/MidiEngine';
import { BgSwipeDetector, pickRandomNextBg } from './core/BgSwipeDetector';
import { StringManager } from './core/StringManager';
import {
  detectBrowserLocale,
  getLocaleNativeName,
  resolveInitialLocale,
  saveLocalePreference,
  t,
  type LocaleId,
  type TranslationKey,
} from './i18n';
import { PerformanceRecorder } from './media/Recorder';
import { AirLooper, type RecordedLoopEvent } from './music/AirLooper';
import { StageRenderer } from './render/StageRenderer';
import type {
  ActiveFinger,
  AppSettings,
  CameraFilterMode,
  LoopBars,
  PresetId,
  TrackedFace,
  TrackedHand,
  TrackedPose,
  Vec2,
} from './types';

const BG_CYCLE: CameraFilterMode[] = ['cinema', 'portrait', 'cyber', 'xray', 'clean'];
import { ControlPanel } from './ui/ControlPanel';
import { HandTracker } from './vision/HandTracker';

const INITIAL_SETTINGS: AppSettings = {
  scale: 'pentatonic_cn',
  timbre: 'harp',
  theme: 'plasma',
  cameraFilter: 'cinema',
  handVisual: 'hologram',
  spaceFx: true,
  reverbAmount: 0.45,
  mirrorCamera: true,
  localMute: false,
};

class AirStringsApp {
  private settings: AppSettings = { ...INITIAL_SETTINGS };
  private locale: LocaleId;
  private localePref: LocaleId | 'auto';
  private stageContainer: HTMLElement;
  private videoEl: HTMLVideoElement;
  private hudRoot: HTMLElement;

  private renderer: StageRenderer;
  private strings: StringManager;
  private audio: AudioEngine;
  private looper: AirLooper;
  private midi: MidiEngine;
  private tracker: HandTracker;
  private bgSwipe = new BgSwipeDetector();
  private recorder: PerformanceRecorder;
  private ui: ControlPanel;

  private cameraStream: MediaStream | null = null;
  private cameraActive = false;
  private latestHands: TrackedHand[] = [];
  private latestPose: TrackedPose | null = null;
  private latestFace: TrackedFace | null = null;
  private customBgObjectUrl: string | null = null;

  // Pointer / mouse fallback state
  private pointerPos: Vec2 | null = null;
  private prevPointerPos: Vec2 | null = null;
  private pointerDownActive = false;

  // Frame timing
  private lastFrameMs = performance.now();
  private frameIndex = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private currentFps = 60;
  private lastHudUpdateMs = 0;

  constructor() {
    const resolved = resolveInitialLocale();
    this.locale = resolved.locale;
    this.localePref = resolved.preference;

    this.stageContainer = document.getElementById('stage-container')!;
    this.videoEl = document.getElementById('webcam') as HTMLVideoElement;
    this.hudRoot = document.getElementById('hud-root')!;

    document.body.dataset.theme = this.settings.theme;

    this.renderer = new StageRenderer(this.stageContainer);
    this.strings = new StringManager();
    this.audio = new AudioEngine();
    this.looper = new AirLooper();
    this.midi = new MidiEngine();
    this.midi.setLocale(this.locale);
    this.tracker = new HandTracker();
    this.recorder = new PerformanceRecorder();

    this.strings.setScale(this.settings.scale);
    this.strings.setAspect(this.renderer.getAspect());
    this.renderer.setTheme(this.settings.theme);
    this.renderer.setCameraFilter(this.settings.cameraFilter);
    this.renderer.setHandVisual(this.settings.handVisual);
    this.renderer.setMirror(this.settings.mirrorCamera);

    // Pre-seed a clean constellation behind the welcome card
    this.strings.loadPreset('web');

    this.ui = new ControlPanel(this.hudRoot, this.settings, this.locale, this.localePref, {
      onStartCamera: () => this.startCameraSession(),
      onStartDemo: () => this.startDemoSession(),
      onToggleCamera: () => this.toggleCamera(),
      onToggleRecord: () => this.toggleRecording(),
      onUndo: () => this.handleUndo(),
      onClear: () => this.handleClear(),
      onPreset: (preset) => this.handlePreset(preset),
      onSettingChange: (key, value) => this.handleSettingChange(key, value),
      onLocaleChange: (pref) => this.handleLocaleChange(pref),
      onUploadCustomBg: (file) => this.handleUploadCustomBg(file),
      onClearCustomBg: () => this.handleClearCustomBg(),
      // V2 Air Looper
      onLoopPrimary: () => this.handleLoopPrimary(),
      onLoopStop: () => this.handleLoopStop(),
      onLoopUndoLayer: () => this.handleLoopUndoLayer(),
      onLoopClear: () => this.handleLoopClear(),
      onLoopBars: (bars) => this.handleLoopBars(bars),
      onLoopBpmDelta: (delta) => this.handleLoopBpmDelta(delta),
      onLoopTapTempo: () => this.handleLoopTapTempo(),
      onLoopToggleMetronome: () => this.handleLoopToggleMetronome(),
      // V2 Web MIDI
      onMidiConnect: () => this.handleMidiConnect(),
      onMidiSelectPort: (portId) => this.midi.selectOutput(portId),
      onMidiChannel: (ch) => this.midi.setChannel(ch),
      onMidiToggleEnabled: () => this.midi.setEnabled(!this.midi.isEnabled()),
      onMidiPanic: () => {
        this.midi.allNotesOff();
        this.syncMidiUi();
        this.ui.showToast(this.tr('toastMidiPanic'));
      },
    });

    this.midi.onChange(() => this.syncMidiUi());
    this.syncLooperUi();
    this.syncMidiUi();

    this.bindPointerAndResize();
    this.bindImageDragDrop();
    this.exposeDebugHandle();
    requestAnimationFrame((tMs) => this.loop(tMs));
  }

  private tr(key: TranslationKey, vars?: Record<string, string | number>): string {
    return t(this.locale, key, vars);
  }

  private handleLocaleChange(pref: LocaleId | 'auto'): void {
    saveLocalePreference(pref);
    this.localePref = pref;
    this.locale = pref === 'auto' ? detectBrowserLocale() : pref;
    this.midi.setLocale(this.locale);
    this.ui.setLocale(this.locale, this.localePref);
    this.syncLooperUi();
    this.syncMidiUi();
    this.ui.showToast(this.tr('toastLangChanged', { name: getLocaleNativeName(this.locale) }));
  }

  private handleUploadCustomBg(file: File): void {
    if (!file.type.startsWith('image/')) {
      this.ui.showToast(this.tr('toastCustomBgErr'));
      return;
    }
    const nextUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      if (this.customBgObjectUrl) {
        URL.revokeObjectURL(this.customBgObjectUrl);
      }
      this.customBgObjectUrl = nextUrl;
      this.renderer.setCustomBackground(img);
      this.ui.setCustomBgActive(true);
      // If camera is running in pure natural mode, automatically switch to Portrait FX so user sees their backdrop!
      if (this.cameraActive && this.settings.cameraFilter === 'clean') {
        this.settings.cameraFilter = 'portrait';
        this.renderer.setCameraFilter('portrait');
        this.ui.setActiveBgMode('portrait');
        void this.tracker.ensureSegmenter();
      }
      this.ui.showToast(this.tr('toastCustomBgLoaded', { name: file.name }));
    };
    img.onerror = () => {
      URL.revokeObjectURL(nextUrl);
      this.ui.showToast(this.tr('toastCustomBgErr'));
    };
    img.src = nextUrl;
  }

  private handleClearCustomBg(): void {
    if (this.customBgObjectUrl) {
      URL.revokeObjectURL(this.customBgObjectUrl);
      this.customBgObjectUrl = null;
    }
    this.renderer.setCustomBackground(null);
    this.ui.setCustomBgActive(false);
    this.ui.showToast(this.tr('toastCustomBgCleared'));
  }

  private bindImageDragDrop(): void {
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragDepth++;
      this.stageContainer.classList.add('drop-active');
    });
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
    });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) this.stageContainer.classList.remove('drop-active');
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      this.stageContainer.classList.remove('drop-active');
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type.startsWith('image/')) {
        this.handleUploadCustomBg(file);
      }
    });
  }

  private async startCameraSession(): Promise<void> {
    this.ui.setStartStatus(this.tr('statusInitAudio'));
    await this.audio.init();
    this.audio.setTimbre(this.settings.timbre);
    this.audio.setSpaceFx(this.settings.spaceFx);
    this.audio.setLocalMute(this.settings.localMute);

    try {
      await this.enableCamera((msg) => this.ui.setStartStatus(msg));
      this.ui.hideStartOverlay();
      this.ui.showToast(this.tr('toastCamReady'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.ui.setStartStatus(this.tr('statusCamFail', { error: msg }));
      this.ui.showToast(this.tr('toastCamFallback'));
    }
  }

  private async startDemoSession(): Promise<void> {
    await this.audio.init();
    this.audio.setTimbre(this.settings.timbre);
    this.audio.setSpaceFx(this.settings.spaceFx);
    this.audio.setLocalMute(this.settings.localMute);
    if (this.strings.strings.length === 0) {
      this.strings.loadPreset('web');
    }
    this.ui.hideStartOverlay();
    this.ui.showToast(this.tr('toastDemoReady'));
  }

  private async toggleCamera(): Promise<void> {
    await this.audio.resume();
    if (this.cameraActive) {
      this.disableCamera();
      this.ui.showToast(this.tr('toastCamOff'));
    } else {
      try {
        this.ui.showToast(this.tr('toastCamStarting'));
        await this.enableCamera();
        this.ui.showToast(this.tr('toastCamOn'));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.ui.showToast(this.tr('toastCamErr', { error: msg }));
      }
    }
  }

  private async enableCamera(onStatus?: (msg: string) => void): Promise<void> {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error(this.tr('errCamUnsupported'));
    }
    onStatus?.(this.tr('statusReqCam'));
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 60 },
        facingMode: 'user',
      },
      audio: false,
    });

    this.cameraStream = stream;
    this.videoEl.srcObject = stream;
    await this.videoEl.play();

    await this.tracker.init((key) => onStatus?.(this.tr(key)));
    if (this.settings.cameraFilter === 'portrait' || this.settings.cameraFilter === 'cyber') {
      onStatus?.(this.tr('statusLoadingSeg'));
      await this.tracker.ensureSegmenter();
    } else if (this.settings.cameraFilter === 'xray') {
      onStatus?.(this.tr('statusLoadingSeg'));
      await Promise.all([
        this.tracker.ensureSegmenter(),
        this.tracker.ensurePoseLandmarker(),
        this.tracker.ensureFaceLandmarker(),
      ]);
    }

    this.renderer.attachVideo(this.videoEl);
    this.cameraActive = true;
    this.ui.setCameraActive(true);
  }

  private disableCamera(): void {
    this.cameraActive = false;
    this.latestHands = [];
    this.latestPose = null;
    this.latestFace = null;
    this.bgSwipe.reset();
    this.renderer.attachVideo(null);
    this.renderer.updateSegmentationMask(null);
    if (this.cameraStream) {
      for (const track of this.cameraStream.getTracks()) {
        track.stop();
      }
      this.cameraStream = null;
    }
    this.videoEl.srcObject = null;
    this.ui.setCameraActive(false);
  }

  private toggleRecording(): void {
    if (this.recorder.isRecording()) {
      this.recorder.stop();
      this.ui.setRecordingState(false);
      this.ui.showToast(this.tr('toastRecDone'));
    } else {
      void this.audio.resume().then(() => {
        const ok = this.recorder.start(this.renderer.canvas, this.audio.getRecordingStream());
        if (ok) {
          this.ui.setRecordingState(true, 0);
          this.ui.showToast(this.tr('toastRecStart'));
        } else {
          this.ui.showToast(this.tr('toastRecUnsupported'));
        }
      });
    }
  }

  private handleUndo(): void {
    const del = this.strings.undoLastString();
    if (del) {
      this.audio.mute(del.stringId);
      this.midi.noteOff(del.stringId);
      this.renderer.spawnDeleteShatter(del.p1, del.p2);
    }
  }

  private handleClear(): void {
    const dels = this.strings.clearAll();
    this.audio.hardStopAll();
    this.midi.allNotesOff();
    for (const d of dels) {
      this.renderer.spawnDeleteShatter(d.p1, d.p2);
    }
  }

  private handlePreset(preset: PresetId): void {
    void this.audio.resume();
    this.audio.hardStopAll();
    this.midi.allNotesOff();
    const created = this.strings.loadPreset(preset);
    for (const s of created) {
      this.renderer.spawnStringCreated(s.p1, s.p2, s.pitch.pitchNorm);
    }
  }

  private handleSettingChange<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    this.settings[key] = value;
    if (key === 'scale') {
      this.strings.setScale(value as AppSettings['scale']);
    } else if (key === 'timbre') {
      const nextTimbre = value as AppSettings['timbre'];
      this.audio.setTimbre(nextTimbre);
      void this.audio.resume().then(() => {
        this.audio.pluck(9999, 261.63, 0.75, 0.35, 0, nextTimbre);
      });
    } else if (key === 'theme') {
      this.renderer.setTheme(value as AppSettings['theme']);
    } else if (key === 'cameraFilter') {
      const mode = value as AppSettings['cameraFilter'];
      this.renderer.setCameraFilter(mode);
      if ((mode === 'portrait' || mode === 'cyber') && this.cameraActive) {
        if (mode === 'portrait') this.ui.showToast(this.tr('toastPortraitLoading'));
        void this.tracker.ensureSegmenter();
      } else if (mode === 'xray' && this.cameraActive) {
        this.ui.showToast(this.tr('toastPortraitLoading'));
        void this.tracker.ensureSegmenter();
        void this.tracker.ensurePoseLandmarker();
        void this.tracker.ensureFaceLandmarker();
      }
      if (mode !== 'portrait' && mode !== 'cyber' && mode !== 'xray') {
        this.renderer.updateSegmentationMask(null);
      }
      if (mode !== 'xray') {
        this.latestPose = null;
        this.latestFace = null;
      }
    } else if (key === 'handVisual') {
      this.renderer.setHandVisual(value as AppSettings['handVisual']);
    } else if (key === 'spaceFx') {
      this.audio.setSpaceFx(Boolean(value));
    } else if (key === 'localMute') {
      this.audio.setLocalMute(Boolean(value));
      this.ui.showToast(this.tr(value ? 'toastLocalMuted' : 'toastLocalUnmuted'));
    }
  }

  // --- V2 Air Looper handlers ---

  private handleLoopPrimary(): void {
    void this.audio.resume();
    const next = this.looper.togglePrimaryAction();
    this.syncLooperUi();
    if (next === 'count_in') {
      this.ui.showToast(this.tr('toastLoopCountIn', { bars: this.looper.getBars() }));
    } else if (next === 'overdub') {
      this.ui.showToast(this.tr('toastLoopOverdub', { layer: this.looper.getLayerCount() + 1 }));
    } else if (next === 'playing') {
      this.ui.showToast(this.tr('toastLoopPlaying', { layers: this.looper.getLayerCount() }));
    }
  }

  private handleLoopStop(): void {
    this.looper.stop();
    this.syncLooperUi();
    this.ui.showToast(this.tr('toastLoopStopped'));
  }

  private handleLoopUndoLayer(): void {
    const removed = this.looper.undoLastLayer();
    this.syncLooperUi();
    if (removed > 0) {
      this.ui.showToast(this.tr('toastLoopUndo', { count: removed }));
    }
  }

  private handleLoopClear(): void {
    this.looper.clear();
    this.syncLooperUi();
    this.ui.showToast(this.tr('toastLoopCleared'));
  }

  private handleLoopBars(bars: LoopBars): void {
    this.looper.setBars(bars);
    this.syncLooperUi();
    this.ui.showToast(this.tr('toastLoopBars', { bars }));
  }

  private handleLoopBpmDelta(delta: number): void {
    this.looper.setBpm(this.looper.getBpm() + delta);
    this.syncLooperUi();
  }

  private handleLoopTapTempo(): void {
    void this.audio.resume();
    const bpm = this.looper.tapTempo(performance.now());
    this.audio.playMetronomeClick(false, false);
    this.syncLooperUi();
    this.ui.showToast(this.tr('toastLoopBpm', { bpm }));
  }

  private handleLoopToggleMetronome(): void {
    const next = !this.looper.isMetronomeEnabled();
    this.looper.setMetronome(next);
    this.syncLooperUi();
    this.ui.showToast(this.tr(next ? 'toastMetroOn' : 'toastMetroOff'));
  }

  private syncLooperUi(): void {
    this.ui.updateLooperUi(this.looper.getRenderSnapshot(), this.looper.isMetronomeEnabled());
  }

  // --- V2 Web MIDI handlers ---

  private async handleMidiConnect(): Promise<void> {
    const res = await this.midi.connect();
    this.syncMidiUi();
    this.ui.showToast(res.message);
  }

  private syncMidiUi(): void {
    this.ui.updateMidiUi(
      this.midi.getOutputs(),
      this.midi.getSelectedPortId(),
      this.midi.isEnabled(),
      this.midi.getChannel(),
      this.midi.getLastMessage()
    );
  }

  private triggerLoopedEvent(ev: RecordedLoopEvent, nowMs: number): void {
    const virtualId = 10000 + ev.layer * 100 + (ev.stringId % 99);
    if (ev.kind === 'pluck') {
      this.audio.pluck(virtualId, ev.freq, ev.velocity * 0.92, ev.u, ev.pan, ev.timbre);
      this.midi.noteOn(virtualId, ev.midi, ev.velocity * 0.92);
      this.ui.updateNote(ev.noteName, ev.freq);

      const liveStr = this.strings.strings.find((s) => s.id === ev.stringId);
      if (liveStr) {
        liveStr.amplitude = Math.max(liveStr.amplitude, ev.velocity * 0.72);
        liveStr.energy = Math.max(liveStr.energy, ev.velocity * 0.8);
        liveStr.pluckPos = ev.u;
        liveStr.pluckDir = ev.pluckDir;
        liveStr.lastPluckTime = nowMs;
      }

      this.renderer.spawnGhostPluckBurst(ev.point, ev.pitchNorm, ev.velocity);
    } else if (ev.kind === 'retune') {
      this.audio.retune(virtualId, ev.freq, ev.stepChanged);
      this.midi.retune(virtualId, ev.midi, ev.stepChanged);
    } else if (ev.kind === 'mute') {
      this.audio.mute(virtualId);
      this.midi.noteOff(virtualId);
      this.renderer.spawnMutePulse(ev.point);
    }
  }

  private bindPointerAndResize(): void {
    const canvas = this.renderer.canvas;

    const toNorm = (e: PointerEvent): Vec2 => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width))),
        y: Math.max(0, Math.min(1, (e.clientY - rect.top) / Math.max(1, rect.height))),
      };
    };

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointerdown', (e) => {
      void this.audio.resume();
      const pos = toNorm(e);
      this.pointerPos = pos;
      this.prevPointerPos = pos;
      this.pointerDownActive = true;
      const forceCreate = e.shiftKey || e.button === 2;
      this.strings.pointerDown(pos, forceCreate);
    });

    canvas.addEventListener('pointermove', (e) => {
      const pos = toNorm(e);
      const now = performance.now();
      if (!this.pointerPos) {
        this.prevPointerPos = pos;
      }
      this.pointerPos = pos;

      if (this.pointerDownActive && this.strings.isPointerBusy()) {
        const ev = this.strings.pointerMove(pos, 1 / 60, now);
        this.handleFrameEvents(ev, now);
      }
    });

    const releasePointer = () => {
      if (!this.pointerDownActive) return;
      this.pointerDownActive = false;
      const now = performance.now();
      const ev = this.strings.pointerUp(now);
      this.handleFrameEvents(ev, now);
    };

    window.addEventListener('pointerup', releasePointer);
    canvas.addEventListener('pointerleave', () => {
      if (!this.pointerDownActive) {
        this.pointerPos = null;
        this.prevPointerPos = null;
      }
    });

    window.addEventListener('resize', () => {
      const w = this.stageContainer.clientWidth || window.innerWidth;
      const h = this.stageContainer.clientHeight || window.innerHeight;
      this.renderer.resize(w, h);
      this.strings.setAspect(this.renderer.getAspect());
    });
  }

  private handleFrameEvents(events: ReturnType<StringManager['update']>, nowMs: number): void {
    for (const created of events.created) {
      this.renderer.spawnStringCreated(created.p1, created.p2, created.pitch.pitchNorm);
      this.audio.playLockChime(created.pitch.freq);
      this.ui.updateNote(created.pitch.noteName, created.pitch.freq);
    }

    for (const pluck of events.plucks) {
      this.audio.pluck(pluck.stringId, pluck.freq, pluck.velocity, pluck.u, pluck.pan);
      this.midi.noteOn(pluck.stringId, pluck.midi, pluck.velocity);
      this.looper.recordPluck(pluck, this.settings.timbre, nowMs);
      this.renderer.spawnPluckBurst(pluck.point, pluck.pitchNorm, pluck.velocity, pluck.pluckDir);
      this.ui.updateNote(pluck.noteName, pluck.freq);
    }

    for (const retune of events.retunes) {
      this.audio.retune(retune.stringId, retune.freq, retune.stepChanged);
      this.midi.retune(retune.stringId, retune.midi, retune.stepChanged);
      this.looper.recordRetune(retune, this.settings.timbre, nowMs);
      this.ui.updateNote(retune.noteName, retune.freq);
      if (retune.stepChanged) {
        const s = this.strings.strings.find((item) => item.id === retune.stringId);
        if (s && s.energy > 0.05) {
          this.renderer.spawnRetuneShimmer(s.p1, s.p2, retune.pitchNorm);
        }
      }
    }

    for (const mute of events.mutes) {
      this.audio.mute(mute.stringId);
      this.midi.noteOff(mute.stringId);
      this.looper.recordMute(mute, this.settings.timbre, nowMs);
      this.renderer.spawnMutePulse(mute.point);
    }

    for (const del of events.deletes) {
      this.audio.mute(del.stringId);
      this.midi.noteOff(del.stringId);
      this.renderer.spawnDeleteShatter(del.p1, del.p2);
    }
  }

  private loop(nowMs: number): void {
    const dtSec = Math.max(1 / 240, Math.min(0.08, (nowMs - this.lastFrameMs) / 1000));
    this.lastFrameMs = nowMs;

    if (this.cameraActive) {
      this.frameIndex++;
      const detected = this.tracker.detectHands(this.videoEl, nowMs, this.settings.mirrorCamera);
      if (detected !== null) {
        this.latestHands = detected;
      }
      if (this.settings.cameraFilter === 'portrait' || this.settings.cameraFilter === 'cyber') {
        const mask = this.tracker.detectSegmentation(this.videoEl, nowMs);
        if (mask) this.renderer.updateSegmentationMask(mask);
        this.latestPose = null;
        this.latestFace = null;
      } else if (this.settings.cameraFilter === 'xray') {
        // Stagger Face, Pose, and Segmentation across alternating display frames so all 4 ML models
        // never stack on a single frame — boosting live X-Ray framerate significantly while 1€ filters keep motion silky!
        const phase = this.frameIndex % 4;
        if (phase === 0 || phase === 2) {
          this.latestFace = this.tracker.detectFace(this.videoEl, nowMs, this.settings.mirrorCamera);
        } else if (phase === 1) {
          this.latestPose = this.tracker.detectPose(this.videoEl, nowMs, this.settings.mirrorCamera);
        } else {
          const mask = this.tracker.detectSegmentation(this.videoEl, nowMs);
          if (mask) this.renderer.updateSegmentationMask(mask);
        }
      } else {
        this.latestPose = null;
        this.latestFace = null;
      }

      // Feed live face center when tracked so the close-up back-of-hand swipe aligns to the user's actual face
      if (this.latestFace) {
        this.bgSwipe.updateFaceAnchor(
          (this.latestFace.eyeLeft.x + this.latestFace.eyeRight.x) * 0.5,
          this.latestFace.noseTip.y
        );
      } else if (this.latestPose && (this.latestPose.landmarks[0]?.visibility ?? 0) > 0.45) {
        this.bgSwipe.updateFaceAnchor(
          this.latestPose.landmarks[0].x,
          this.latestPose.landmarks[0].y
        );
      }

      // Close-up open-hand swipe across face -> randomly switch to a different stage background!
      const bgSwipeTrigger = this.bgSwipe.update(this.latestHands, nowMs);
      if (bgSwipeTrigger) {
        const nextMode = pickRandomNextBg(this.settings.cameraFilter, BG_CYCLE);
        this.handleSettingChange('cameraFilter', nextMode);
        this.ui.setActiveBgMode(nextMode);
        this.audio.playLockChime(bgSwipeTrigger.direction > 0 ? 587.33 : 440);
        this.renderer.spawnBgSwipeFlash(bgSwipeTrigger.point);
        this.ui.showToast(
          this.tr('toastBg', { name: this.tr(`bg_${nextMode}` as TranslationKey) })
        );
      }
    }

    const extraFingers: ActiveFinger[] = [];
    if (this.pointerPos && this.prevPointerPos && !this.strings.isPointerBusy()) {
      const speed =
        Math.hypot(
          this.pointerPos.x - this.prevPointerPos.x,
          this.pointerPos.y - this.prevPointerPos.y
        ) / dtSec;
      extraFingers.push({
        id: 'mouse-0',
        handId: 'mouse',
        landmarkIndex: 8,
        pos: { ...this.pointerPos },
        prevPos: { ...this.prevPointerPos },
        speed,
        isPrimary: true,
      });
    }
    if (this.pointerPos) {
      this.prevPointerPos = { ...this.pointerPos };
    }

    const events = this.strings.update(this.latestHands, extraFingers, dtSec, nowMs);
    this.handleFrameEvents(events, nowMs);

    const loopTick = this.looper.update(dtSec, nowMs);
    if (loopTick.beatTick) {
      this.audio.playMetronomeClick(loopTick.beatTick.isDownbeat, loopTick.beatTick.isCountIn);
    }
    for (const trig of loopTick.triggers) {
      this.triggerLoopedEvent(trig, nowMs);
    }
    const loopSnapshot = this.looper.getRenderSnapshot();

    const audioMetrics = this.audio.getReactiveMetrics();
    this.renderer.render(
      dtSec,
      this.strings.strings,
      this.strings.preview,
      this.strings.resonances,
      this.latestHands,
      this.pointerPos,
      audioMetrics,
      this.cameraActive ? this.videoEl : null,
      loopSnapshot,
      nowMs,
      this.latestPose,
      this.latestFace
    );

    this.fpsAccum += dtSec;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.45) {
      this.currentFps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }
    if (nowMs - this.lastHudUpdateMs >= 140 || loopTick.stateChanged) {
      this.lastHudUpdateMs = nowMs;
      this.ui.updateStats(this.strings.strings.length, this.currentFps);
      this.ui.updateLooperUi(loopSnapshot, this.looper.isMetronomeEnabled());
      if (this.midi.isEnabled()) {
        this.syncMidiUi();
      }
      if (this.recorder.isRecording()) {
        this.ui.setRecordingState(true, this.recorder.getElapsedSec());
      }
    }

    requestAnimationFrame((tMs) => this.loop(tMs));
  }

  private exposeDebugHandle(): void {
    (window as unknown as Record<string, unknown>).__airStrings = {
      getState: () => ({
        locale: this.locale,
        localePref: this.localePref,
        hasCustomBg: this.customBgObjectUrl !== null,
        stringCount: this.strings.strings.length,
        settings: { ...this.settings },
        audioReady: this.audio.isReady(),
        cameraActive: this.cameraActive,
        looper: this.looper.getRenderSnapshot(),
        fps: Math.round(this.currentFps),
      }),
      loadPreset: (p: PresetId) => this.handlePreset(p),
    };
  }
}

new AirStringsApp();
