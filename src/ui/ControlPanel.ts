import {
  detectBrowserLocale,
  getLocaleCode,
  getLocaleNativeName,
  isRtlLocale,
  SUPPORTED_LOCALES,
  t,
  type LocaleId,
  type TranslationKey,
} from '../i18n';
import { SCALES } from '../music/scales';
import { THEMES } from '../render/themes';
import type {
  AppSettings,
  CameraFilterMode,
  HandVisualMode,
  LoopBars,
  LoopRenderSnapshot,
  MidiPortInfo,
  PresetId,
  ScaleId,
  ThemeId,
  TimbreId,
} from '../types';

export interface ControlCallbacks {
  onStartCamera: () => Promise<void>;
  onStartDemo: () => Promise<void>;
  onToggleCamera: () => Promise<void>;
  onToggleRecord: () => void;
  onUndo: () => void;
  onClear: () => void;
  onPreset: (preset: PresetId) => void;
  onSettingChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  onLocaleChange: (pref: LocaleId | 'auto') => void;
  onUploadCustomBg: (file: File) => void;
  onClearCustomBg: () => void;
  // V2 Air Looper callbacks
  onLoopPrimary: () => void;
  onLoopStop: () => void;
  onLoopUndoLayer: () => void;
  onLoopClear: () => void;
  onLoopBars: (bars: LoopBars) => void;
  onLoopBpmDelta: (delta: number) => void;
  onLoopTapTempo: () => void;
  onLoopToggleMetronome: () => void;
  // V2 Web MIDI callbacks
  onMidiConnect: () => Promise<void>;
  onMidiSelectPort: (portId: string) => void;
  onMidiChannel: (ch: number) => void;
  onMidiToggleEnabled: () => void;
  onMidiPanic: () => void;
}

const TIMBRE_IDS: TimbreId[] = ['harp', 'guzheng', 'guitar', 'synth', 'crystal'];
const BG_IDS: CameraFilterMode[] = ['cinema', 'portrait', 'cyber', 'xray', 'clean'];
const HAND_IDS: HandVisualMode[] = ['hologram', 'classic', 'minimal'];
const PRESET_IDS: PresetId[] = ['web', 'harp', 'guzheng', 'star'];
const BAR_OPTIONS: LoopBars[] = [2, 4, 8];

export class ControlPanel {
  private root: HTMLElement;
  private settings: AppSettings;
  private cb: ControlCallbacks;

  private locale: LocaleId;
  private localePref: LocaleId | 'auto';
  private hotkeysBound = false;

  // Live UI state preserved cleanly across live language re-renders
  private overlayHidden = false;
  private cameraActive = false;
  private recording = false;
  private recElapsedSec = 0;
  private hasCustomBg = false;
  private lastNoteText = 'READY';
  private lastStringCount = 0;
  private lastFps = 60;
  private lastLoopSnap: LoopRenderSnapshot | null = null;
  private lastMetroEnabled = true;
  private lastMidiState: {
    ports: MidiPortInfo[];
    selectedPortId: string;
    enabled: boolean;
    channel: number;
    lastMessage: string;
  } | null = null;

  private noteEl!: HTMLElement;
  private themeCodeEl!: HTMLElement;
  private countEl!: HTMLElement;
  private fpsEl!: HTMLElement;
  private camBtn!: HTMLButtonElement;
  private recBtn!: HTMLButtonElement;
  private recLabelEl!: HTMLElement;
  private loopToggleBtn!: HTMLButtonElement;
  private loopDotEl!: HTMLElement;
  private midiToggleBtn!: HTMLButtonElement;
  private midiDotEl!: HTMLElement;
  private bgUploadBtn!: HTMLButtonElement;
  private bgClearBtn!: HTMLButtonElement;
  private bgFileInput!: HTMLInputElement;

  private looperBar!: HTMLElement;
  private loopMainBtn!: HTMLButtonElement;
  private loopStatEl!: HTMLElement;
  private bpmValEl!: HTMLElement;
  private metroBtn!: HTMLButtonElement;

  private midiPopover!: HTMLElement;
  private midiPortSel!: HTMLSelectElement;
  private midiChanSel!: HTMLSelectElement;
  private midiEnableBtn!: HTMLButtonElement;
  private midiLocalMuteBtn!: HTMLButtonElement;
  private midiLogEl!: HTMLElement;

  private startOverlay!: HTMLElement;
  private startStatusEl!: HTMLElement;
  private guidePopover!: HTMLElement;
  private toastEl!: HTMLElement;
  private toastTimer: number | null = null;
  private hudCollapsed = false;
  private looperVisible = false;
  private midiOpen = false;
  private guideOpen = false;

  constructor(
    root: HTMLElement,
    initialSettings: AppSettings,
    initialLocale: LocaleId,
    initialPref: LocaleId | 'auto',
    callbacks: ControlCallbacks
  ) {
    this.root = root;
    this.settings = { ...initialSettings };
    this.locale = initialLocale;
    this.localePref = initialPref;
    this.cb = callbacks;
    this.applyDocumentLocale();
    this.mount();
    this.bindHotkeysOnce();
  }

  private tr(key: TranslationKey, vars?: Record<string, string | number>): string {
    return t(this.locale, key, vars);
  }

  private applyDocumentLocale(): void {
    document.documentElement.lang = this.locale;
    document.documentElement.dir = isRtlLocale(this.locale) ? 'rtl' : 'ltr';
    document.title = this.tr('pageTitle');
  }

  setLocale(locale: LocaleId, pref: LocaleId | 'auto'): void {
    this.locale = locale;
    this.localePref = pref;
    this.applyDocumentLocale();
    this.mount();
    this.restoreLiveState();
  }

  private restoreLiveState(): void {
    if (this.overlayHidden) this.startOverlay.classList.add('hidden');
    this.root.classList.toggle('hud-collapsed', this.hudCollapsed);
    this.looperBar.classList.toggle('hidden', !this.looperVisible);
    this.loopToggleBtn.classList.toggle('active', this.looperVisible);
    this.midiPopover.classList.toggle('hidden', !this.midiOpen);
    this.midiToggleBtn.classList.toggle('active', this.midiOpen);
    this.guidePopover.classList.toggle('hidden', !this.guideOpen);

    this.noteEl.textContent = this.lastNoteText;
    this.setCameraActive(this.cameraActive);
    this.setRecordingState(this.recording, this.recElapsedSec);
    this.setCustomBgActive(this.hasCustomBg);
    this.updateStats(this.lastStringCount, this.lastFps);
    if (this.lastLoopSnap) {
      this.updateLooperUi(this.lastLoopSnap, this.lastMetroEnabled);
    }
    if (this.lastMidiState) {
      this.updateMidiUi(
        this.lastMidiState.ports,
        this.lastMidiState.selectedPortId,
        this.lastMidiState.enabled,
        this.lastMidiState.channel,
        this.lastMidiState.lastMessage
      );
    }
  }

  private mount(): void {
    const detectedCode = getLocaleCode(detectBrowserLocale());
    const langOptionsHtml = [
      `<option value="auto" ${this.localePref === 'auto' ? 'selected' : ''}>${this.tr('langAuto', { code: detectedCode })}</option>`,
      ...SUPPORTED_LOCALES.map(
        (l) =>
          `<option value="${l.id}" ${this.localePref === l.id ? 'selected' : ''}>${l.code} · ${l.nativeName}</option>`
      ),
    ].join('');

    const scaleOptionsHtml = (Object.keys(SCALES) as ScaleId[])
      .map((id) => {
        const label = this.tr(`scale_${id}` as TranslationKey);
        return `<option value="${id}" ${this.settings.scale === id ? 'selected' : ''}>${label}</option>`;
      })
      .join('');

    const timbreOptionsHtml = TIMBRE_IDS.map((id) => {
      const label = this.tr(`timbre_${id}` as TranslationKey);
      return `<option value="${id}" ${this.settings.timbre === id ? 'selected' : ''}>${label}</option>`;
    }).join('');

    const themeButtonsHtml = (Object.keys(THEMES) as ThemeId[])
      .map((id) => {
        const label = this.tr(`theme_${id}` as TranslationKey);
        return `<button class="seg-btn ${this.settings.theme === id ? 'active' : ''}" data-theme-btn="${id}">${label}</button>`;
      })
      .join('');

    const bgButtonsHtml = BG_IDS.map((id) => {
      const label = this.tr(`bg_${id}` as TranslationKey);
      return `<button class="seg-btn ${this.settings.cameraFilter === id ? 'active' : ''}" data-bg-btn="${id}">${label}</button>`;
    }).join('');

    const handButtonsHtml = HAND_IDS.map((id) => {
      const label = this.tr(`hand_${id}` as TranslationKey);
      return `<button class="seg-btn ${this.settings.handVisual === id ? 'active' : ''}" data-hand-btn="${id}">${label}</button>`;
    }).join('');

    const presetButtonsHtml = PRESET_IDS.map((id) => {
      const label = this.tr(`preset_${id}` as TranslationKey);
      return `<button class="seg-btn" data-preset-btn="${id}">${label}</button>`;
    }).join('');

    const activeBars = this.lastLoopSnap?.bars ?? 4;
    const barButtonsHtml = BAR_OPTIONS.map(
      (bars) =>
        `<button class="seg-btn ${bars === activeBars ? 'active' : ''}" data-bars-btn="${bars}">${this.tr('loopBarsUnit', { n: bars })}</button>`
    ).join('');

    const midiChanHtml = Array.from({ length: 16 }, (_, i) => {
      const ch = i + 1;
      return `<option value="${ch}">Ch ${ch}</option>`;
    }).join('');

    this.root.innerHTML = `
      <div class="top-bar">
        <div class="brand-cluster">
          <span class="brand-dot"></span>
          <span class="brand-title">AETHER // STRINGS</span>
          <span class="theme-code-tag" id="hud-theme-code">${THEMES[this.settings.theme].code}</span>
          <span class="brand-sep"></span>
          <div class="status-mono">
            <span class="note-pill" id="hud-note">READY</span>
            <span id="hud-count">${this.tr('hudStringsCount', { n: 0 })}</span>
            <span class="hide-sm" id="hud-fps">60 FPS</span>
          </div>
        </div>

        <div class="action-cluster">
          <select class="select-pill lang-select" id="sel-lang" title="${this.tr('langTitle')}">${langOptionsHtml}</select>
          <button class="pill-btn" id="btn-cam" title="${this.tr('btnCamTitle')}">${this.tr('btnCam')}</button>
          <button class="pill-btn" id="btn-looper" title="${this.tr('btnLooperTitle')}">
            <span class="status-dot" id="loop-dot"></span><span>${this.tr('btnLooper')}</span>
          </button>
          <button class="pill-btn" id="btn-midi" title="${this.tr('btnMidiTitle')}">
            <span class="status-dot" id="midi-dot"></span><span>${this.tr('btnMidi')}</span>
          </button>
          <button class="pill-btn" id="btn-rec" title="${this.tr('btnRecTitle')}">
            <span class="rec-dot"></span><span id="rec-label">${this.tr('btnRec')}</span>
          </button>
          <button class="pill-btn" id="btn-undo" title="${this.tr('btnUndoTitle')}">${this.tr('btnUndo')}</button>
          <button class="pill-btn" id="btn-clear" title="${this.tr('btnClearTitle')}">${this.tr('btnClear')}</button>
          <button class="pill-btn" id="btn-guide" title="${this.tr('btnGuideTitle')}">?</button>
          <button class="pill-btn" id="btn-collapse" title="${this.tr('btnPanelTitle')}">${this.tr('btnPanel')}</button>
        </div>
      </div>

      <div class="dock-wrap">
        <div class="looper-bar hidden" id="looper-bar">
          <button class="loop-main-btn" id="btn-loop-main">${this.tr('loopMainStart')}</button>
          <button class="seg-btn" id="btn-loop-stop" title="${this.tr('loopStopTitle')}">${this.tr('loopStop')}</button>
          <span class="loop-stat" id="loop-stat">${this.tr('loopStatIdle')}</span>
          <div class="seg-row">${barButtonsHtml}</div>
          <div class="bpm-ctrl">
            <button class="seg-btn" id="btn-bpm-down">-</button>
            <span class="bpm-val" id="bpm-val">100 BPM</span>
            <button class="seg-btn" id="btn-bpm-up">+</button>
            <button class="seg-btn" id="btn-bpm-tap" title="${this.tr('loopTapTitle')}">${this.tr('loopTap')}</button>
          </div>
          <button class="seg-btn active" id="btn-metro" title="${this.tr('loopMetroTitle')}">${this.tr('loopMetro')}</button>
          <button class="seg-btn" id="btn-loop-undo" title="${this.tr('loopUndoTitle')}">${this.tr('loopUndo')}</button>
          <button class="seg-btn" id="btn-loop-clear" title="${this.tr('loopClearTitle')}">${this.tr('loopClear')}</button>
        </div>

        <div class="dock">
          <div class="dock-row">
            <span class="row-tag">AUDIO.DSP</span>
            <div class="ctrl-group">
              <span class="ctrl-label">${this.tr('lblScale')}</span>
              <select class="select-pill" id="sel-scale">${scaleOptionsHtml}</select>
            </div>
            <div class="ctrl-group">
              <span class="ctrl-label">${this.tr('lblTimbre')}</span>
              <select class="select-pill" id="sel-timbre">${timbreOptionsHtml}</select>
            </div>
            <div class="ctrl-group">
              <span class="ctrl-label">${this.tr('lblPreset')}</span>
              <div class="seg-row">${presetButtonsHtml}</div>
            </div>
            <div class="ctrl-group">
              <button class="pill-btn ${this.settings.spaceFx ? 'active' : ''}" id="btn-space">${this.tr('lblSpaceFx')}</button>
            </div>
          </div>
          <div class="dock-divider"></div>
          <div class="dock-row">
            <span class="row-tag">STAGE.FX</span>
            <div class="ctrl-group">
              <span class="ctrl-label">${this.tr('lblTheme')}</span>
              <div class="seg-row">${themeButtonsHtml}</div>
            </div>
            <div class="ctrl-group">
              <span class="ctrl-label">${this.tr('lblBg')}</span>
              <div class="seg-row">${bgButtonsHtml}</div>
              <input type="file" id="input-bg-file" accept="image/*" class="hidden-file-input" />
              <button class="pill-btn bg-img-btn" id="btn-bg-upload" title="${this.tr('btnBgUploadTitle')}">${this.tr('btnBgUpload')}</button>
              <button class="pill-btn bg-img-btn hidden" id="btn-bg-clear" title="${this.tr('btnBgClearTitle')}">${this.tr('btnBgClear')}</button>
            </div>
            <div class="ctrl-group">
              <span class="ctrl-label">${this.tr('lblHand')}</span>
              <div class="seg-row">${handButtonsHtml}</div>
            </div>
          </div>
        </div>
        <div class="hint-strip">${this.tr('hintStrip')}</div>
      </div>

      <div class="midi-popover hidden" id="midi-popover">
        <div class="midi-header">
          <h3>${this.tr('midiTitle')}</h3>
          <button class="seg-btn" id="btn-midi-refresh">${this.tr('midiScan')}</button>
        </div>
        <div class="midi-row">
          <span>${this.tr('midiPortLabel')}</span>
          <select class="select-pill" id="sel-midi-port">
            <option value="">${this.tr('midiPortPrompt')}</option>
          </select>
        </div>
        <div class="midi-row">
          <span>${this.tr('midiChanLabel')}</span>
          <select class="select-pill" id="sel-midi-chan">${midiChanHtml}</select>
        </div>
        <div class="midi-actions">
          <button class="pill-btn" id="btn-midi-enable">${this.tr('midiOutOff')}</button>
          <button class="pill-btn" id="btn-midi-localmute">${this.tr('midiLocalOn')}</button>
        </div>
        <div class="midi-actions">
          <button class="pill-btn" id="btn-midi-panic">${this.tr('midiPanic')}</button>
        </div>
        <div class="midi-log" id="midi-log">${this.tr('midiDefaultLog')}</div>
      </div>

      <div class="guide-popover hidden" id="guide-popover">
        <h3>${this.tr('guideTitle')}</h3>
        <ul class="guide-list">
          <li><b>${this.tr('guidePinchTitle')}</b>: ${this.tr('guidePinchDesc')}</li>
          <li><b>${this.tr('guidePluckTitle')}</b>: ${this.tr('guidePluckDesc')}</li>
          <li><b>${this.tr('guideBendTitle')}</b>: ${this.tr('guideBendDesc')}</li>
          <li><b>${this.tr('guideDeleteTitle')}</b>: ${this.tr('guideDeleteDesc')}</li>
          <li><b>${this.tr('guideMuteTitle')}</b>: ${this.tr('guideMuteDesc')}</li>
          <li><b>${this.tr('guideWheelTitle')}</b>: ${this.tr('guideWheelDesc')}</li>
          <li><b>${this.tr('guideBgSwipeTitle')}</b>: ${this.tr('guideBgSwipeDesc')}</li>
          <li><b>${this.tr('guideLoopTitle')}</b>: ${this.tr('guideLoopDesc')}</li>
          <li><b>${this.tr('guideMidiTitle')}</b>: ${this.tr('guideMidiDesc')}</li>
          <li><b>${this.tr('guideMouseTitle')}</b>: ${this.tr('guideMouseDesc')}</li>
        </ul>
      </div>

      <div class="start-overlay" id="start-overlay">
        <div class="start-card">
          <span class="start-badge">WEBGL2 HDR BLOOM · KARPLUS-STRONG · AIR LOOPER · WEB MIDI</span>
          <h1 class="start-heading">${this.tr('startHeading')}</h1>
          <p class="start-sub">${this.tr('startSub')}</p>
          <div class="gesture-grid">
            <div class="gesture-item">
              <strong>${this.tr('startCard1Title')}</strong>
              <span>${this.tr('startCard1Desc')}</span>
            </div>
            <div class="gesture-item">
              <strong>${this.tr('startCard2Title')}</strong>
              <span>${this.tr('startCard2Desc')}</span>
            </div>
            <div class="gesture-item">
              <strong>${this.tr('startCard3Title')}</strong>
              <span>${this.tr('startCard3Desc')}</span>
            </div>
            <div class="gesture-item">
              <strong>${this.tr('startCard4Title')}</strong>
              <span>${this.tr('startCard4Desc')}</span>
            </div>
            <div class="gesture-item">
              <strong>${this.tr('startCard5Title')}</strong>
              <span>${this.tr('startCard5Desc')}</span>
            </div>
            <div class="gesture-item">
              <strong>${this.tr('startCard6Title')}</strong>
              <span>${this.tr('startCard6Desc')}</span>
            </div>
          </div>
          <div class="start-actions">
            <button class="cta-primary" id="btn-start-cam">${this.tr('startCamCta')}</button>
            <button class="cta-secondary" id="btn-start-demo">${this.tr('startDemoCta')}</button>
          </div>
          <div class="start-status" id="start-status"></div>
        </div>
      </div>

      <div class="toast" id="hud-toast"></div>
    `;

    this.noteEl = this.root.querySelector('#hud-note')!;
    this.themeCodeEl = this.root.querySelector('#hud-theme-code')!;
    this.countEl = this.root.querySelector('#hud-count')!;
    this.fpsEl = this.root.querySelector('#hud-fps')!;
    this.camBtn = this.root.querySelector('#btn-cam')!;
    this.recBtn = this.root.querySelector('#btn-rec')!;
    this.recLabelEl = this.root.querySelector('#rec-label')!;
    this.loopToggleBtn = this.root.querySelector('#btn-looper')!;
    this.loopDotEl = this.root.querySelector('#loop-dot')!;
    this.midiToggleBtn = this.root.querySelector('#btn-midi')!;
    this.midiDotEl = this.root.querySelector('#midi-dot')!;
    this.bgUploadBtn = this.root.querySelector('#btn-bg-upload')!;
    this.bgClearBtn = this.root.querySelector('#btn-bg-clear')!;
    this.bgFileInput = this.root.querySelector('#input-bg-file')!;

    this.looperBar = this.root.querySelector('#looper-bar')!;
    this.loopMainBtn = this.root.querySelector('#btn-loop-main')!;
    this.loopStatEl = this.root.querySelector('#loop-stat')!;
    this.bpmValEl = this.root.querySelector('#bpm-val')!;
    this.metroBtn = this.root.querySelector('#btn-metro')!;

    this.midiPopover = this.root.querySelector('#midi-popover')!;
    this.midiPortSel = this.root.querySelector('#sel-midi-port')!;
    this.midiChanSel = this.root.querySelector('#sel-midi-chan')!;
    this.midiEnableBtn = this.root.querySelector('#btn-midi-enable')!;
    this.midiLocalMuteBtn = this.root.querySelector('#btn-midi-localmute')!;
    this.midiLogEl = this.root.querySelector('#midi-log')!;

    this.startOverlay = this.root.querySelector('#start-overlay')!;
    this.startStatusEl = this.root.querySelector('#start-status')!;
    this.guidePopover = this.root.querySelector('#guide-popover')!;
    this.toastEl = this.root.querySelector('#hud-toast')!;

    this.bindEvents();
  }

  private bindEvents(): void {
    this.root.querySelector('#btn-start-cam')!.addEventListener('click', () => {
      void this.cb.onStartCamera();
    });
    this.root.querySelector('#btn-start-demo')!.addEventListener('click', () => {
      void this.cb.onStartDemo();
    });

    this.root.querySelector<HTMLSelectElement>('#sel-lang')!.addEventListener('change', (e) => {
      const val = (e.target as HTMLSelectElement).value as LocaleId | 'auto';
      this.cb.onLocaleChange(val);
    });

    this.camBtn.addEventListener('click', () => void this.cb.onToggleCamera());
    this.recBtn.addEventListener('click', () => this.cb.onToggleRecord());
    this.root.querySelector('#btn-undo')!.addEventListener('click', () => this.cb.onUndo());
    this.root.querySelector('#btn-clear')!.addEventListener('click', () => this.cb.onClear());

    this.loopToggleBtn.addEventListener('click', () => this.toggleLooperBar());
    this.midiToggleBtn.addEventListener('click', () => this.toggleMidiPopover());

    this.root.querySelector('#btn-guide')!.addEventListener('click', () => {
      this.midiOpen = false;
      this.midiPopover.classList.add('hidden');
      this.midiToggleBtn.classList.remove('active');
      this.guideOpen = !this.guideOpen;
      this.guidePopover.classList.toggle('hidden', !this.guideOpen);
    });
    this.root.querySelector('#btn-collapse')!.addEventListener('click', () => {
      this.toggleCollapse();
    });

    // Custom background upload / clear
    this.bgUploadBtn.addEventListener('click', () => {
      this.bgFileInput.value = '';
      this.bgFileInput.click();
    });
    this.bgFileInput.addEventListener('change', () => {
      const file = this.bgFileInput.files?.[0];
      if (file) {
        this.cb.onUploadCustomBg(file);
      }
    });
    this.bgClearBtn.addEventListener('click', () => {
      this.cb.onClearCustomBg();
    });

    // Air Looper controls
    this.loopMainBtn.addEventListener('click', () => this.cb.onLoopPrimary());
    this.root.querySelector('#btn-loop-stop')!.addEventListener('click', () => this.cb.onLoopStop());
    this.root.querySelector('#btn-loop-undo')!.addEventListener('click', () => this.cb.onLoopUndoLayer());
    this.root.querySelector('#btn-loop-clear')!.addEventListener('click', () => this.cb.onLoopClear());
    this.root.querySelector('#btn-bpm-down')!.addEventListener('click', () => this.cb.onLoopBpmDelta(-5));
    this.root.querySelector('#btn-bpm-up')!.addEventListener('click', () => this.cb.onLoopBpmDelta(5));
    this.root.querySelector('#btn-bpm-tap')!.addEventListener('click', () => this.cb.onLoopTapTempo());
    this.metroBtn.addEventListener('click', () => this.cb.onLoopToggleMetronome());

    this.root.querySelectorAll<HTMLButtonElement>('[data-bars-btn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const bars = Number(btn.dataset.barsBtn) as LoopBars;
        this.setActiveGroup('[data-bars-btn]', btn);
        this.cb.onLoopBars(bars);
      });
    });

    // Web MIDI popover controls
    this.root.querySelector('#btn-midi-refresh')!.addEventListener('click', () => {
      void this.cb.onMidiConnect();
    });
    this.midiPortSel.addEventListener('change', () => {
      if (this.midiPortSel.value) {
        this.cb.onMidiSelectPort(this.midiPortSel.value);
      }
    });
    this.midiChanSel.addEventListener('change', () => {
      this.cb.onMidiChannel(Number(this.midiChanSel.value));
    });
    this.midiEnableBtn.addEventListener('click', () => this.cb.onMidiToggleEnabled());
    this.midiLocalMuteBtn.addEventListener('click', () => {
      this.settings.localMute = !this.settings.localMute;
      this.updateLocalMuteUi();
      this.cb.onSettingChange('localMute', this.settings.localMute);
    });
    this.root.querySelector('#btn-midi-panic')!.addEventListener('click', () => this.cb.onMidiPanic());

    // Dock controls
    this.root.querySelector<HTMLSelectElement>('#sel-scale')!.addEventListener('change', (e) => {
      const val = (e.target as HTMLSelectElement).value as ScaleId;
      this.settings.scale = val;
      this.cb.onSettingChange('scale', val);
      this.showToast(this.tr('toastScale', { name: this.tr(`scale_${val}` as TranslationKey) }));
    });

    this.root.querySelector<HTMLSelectElement>('#sel-timbre')!.addEventListener('change', (e) => {
      const val = (e.target as HTMLSelectElement).value as TimbreId;
      this.settings.timbre = val;
      this.cb.onSettingChange('timbre', val);
      this.showToast(this.tr('toastTimbre', { name: this.tr(`timbre_${val}` as TranslationKey) }));
    });

    const spaceBtn = this.root.querySelector<HTMLButtonElement>('#btn-space')!;
    spaceBtn.addEventListener('click', () => {
      this.settings.spaceFx = !this.settings.spaceFx;
      spaceBtn.classList.toggle('active', this.settings.spaceFx);
      this.cb.onSettingChange('spaceFx', this.settings.spaceFx);
      this.showToast(this.tr(this.settings.spaceFx ? 'toastSpaceOn' : 'toastSpaceOff'));
    });

    this.root.querySelectorAll<HTMLButtonElement>('[data-theme-btn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.themeBtn as ThemeId;
        this.setActiveGroup('[data-theme-btn]', btn);
        this.settings.theme = id;
        document.body.dataset.theme = id;
        this.themeCodeEl.textContent = THEMES[id].code;
        this.cb.onSettingChange('theme', id);
        this.showToast(
          this.tr('toastTheme', {
            name: this.tr(`theme_${id}` as TranslationKey),
            sub: this.tr(`theme_${id}_sub` as TranslationKey),
          })
        );
      });
    });

    this.root.querySelectorAll<HTMLButtonElement>('[data-bg-btn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.bgBtn as CameraFilterMode;
        this.setActiveGroup('[data-bg-btn]', btn);
        this.settings.cameraFilter = id;
        this.cb.onSettingChange('cameraFilter', id);
        this.showToast(this.tr('toastBg', { name: this.tr(`bg_${id}` as TranslationKey) }));
      });
    });

    this.root.querySelectorAll<HTMLButtonElement>('[data-hand-btn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.handBtn as HandVisualMode;
        this.setActiveGroup('[data-hand-btn]', btn);
        this.settings.handVisual = id;
        this.cb.onSettingChange('handVisual', id);
      });
    });

    this.root.querySelectorAll<HTMLButtonElement>('[data-preset-btn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.presetBtn as PresetId;
        this.cb.onPreset(id);
        this.showToast(this.tr('toastPreset', { name: this.tr(`preset_${id}` as TranslationKey) }));
      });
    });
  }

  private bindHotkeysOnce(): void {
    if (this.hotkeysBound) return;
    this.hotkeysBound = true;
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.showLooperBar();
        this.cb.onLoopPrimary();
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        this.cb.onLoopUndoLayer();
        return;
      }
      const key = e.key.toLowerCase();
      if (key === 'z') this.cb.onUndo();
      else if (key === 'c') this.cb.onClear();
      else if (key === 'r') this.cb.onToggleRecord();
      else if (key === 'h') this.toggleCollapse();
      else if (key === 'l') this.toggleLooperBar();
      else if (key === 'm') this.toggleMidiPopover();
      else if (key === 'g') {
        this.midiOpen = false;
        this.midiPopover.classList.add('hidden');
        this.midiToggleBtn.classList.remove('active');
        this.guideOpen = !this.guideOpen;
        this.guidePopover.classList.toggle('hidden', !this.guideOpen);
      } else if (key === '1') this.cb.onPreset('web');
      else if (key === '2') this.cb.onPreset('harp');
      else if (key === '3') this.cb.onPreset('guzheng');
      else if (key === '4') this.cb.onPreset('star');
    });
  }

  private setActiveGroup(selector: string, activeBtn: HTMLButtonElement): void {
    this.root.querySelectorAll<HTMLButtonElement>(selector).forEach((b) => {
      b.classList.toggle('active', b === activeBtn);
    });
  }

  toggleLooperBar(): void {
    this.looperVisible = !this.looperVisible;
    this.looperBar.classList.toggle('hidden', !this.looperVisible);
    this.loopToggleBtn.classList.toggle('active', this.looperVisible);
  }

  showLooperBar(): void {
    this.looperVisible = true;
    this.looperBar.classList.remove('hidden');
    this.loopToggleBtn.classList.add('active');
  }

  toggleMidiPopover(): void {
    this.guideOpen = false;
    this.guidePopover.classList.add('hidden');
    this.midiOpen = !this.midiOpen;
    this.midiPopover.classList.toggle('hidden', !this.midiOpen);
    this.midiToggleBtn.classList.toggle('active', this.midiOpen);
    if (this.midiOpen) {
      void this.cb.onMidiConnect();
    }
  }

  toggleCollapse(): void {
    this.hudCollapsed = !this.hudCollapsed;
    this.root.classList.toggle('hud-collapsed', this.hudCollapsed);
  }

  hideStartOverlay(): void {
    this.overlayHidden = true;
    this.startOverlay.classList.add('hidden');
  }

  setStartStatus(msg: string): void {
    this.startStatusEl.textContent = msg;
  }

  setCameraActive(active: boolean): void {
    this.cameraActive = active;
    this.camBtn.classList.toggle('active', active);
    this.camBtn.textContent = this.tr(active ? 'btnCamOn' : 'btnCamOpen');
  }

  setCustomBgActive(active: boolean): void {
    this.hasCustomBg = active;
    this.bgUploadBtn.classList.toggle('active', active);
    this.bgClearBtn.classList.toggle('hidden', !active);
  }

  setActiveBgMode(mode: CameraFilterMode): void {
    this.settings.cameraFilter = mode;
    const btn = this.root.querySelector<HTMLButtonElement>(`[data-bg-btn="${mode}"]`);
    if (btn) this.setActiveGroup('[data-bg-btn]', btn);
  }

  setActiveTimbre(timbre: TimbreId): void {
    this.settings.timbre = timbre;
    const sel = this.root.querySelector<HTMLSelectElement>('#sel-timbre');
    if (sel) sel.value = timbre;
  }

  setRecordingState(recording: boolean, elapsedSec = 0): void {
    this.recording = recording;
    this.recElapsedSec = elapsedSec;
    this.recBtn.classList.toggle('recording', recording);
    if (recording) {
      const m = Math.floor(elapsedSec / 60)
        .toString()
        .padStart(2, '0');
      const s = Math.floor(elapsedSec % 60)
        .toString()
        .padStart(2, '0');
      this.recLabelEl.textContent = this.tr('btnRecStop', { time: `${m}:${s}` });
    } else {
      this.recLabelEl.textContent = this.tr('btnRec');
    }
  }

  updateLooperUi(snap: LoopRenderSnapshot, metronomeEnabled: boolean): void {
    this.lastLoopSnap = snap;
    this.lastMetroEnabled = metronomeEnabled;
    this.bpmValEl.textContent = `${snap.bpm} BPM`;
    this.metroBtn.classList.toggle('active', metronomeEnabled);

    this.loopMainBtn.classList.remove('state-rec', 'state-count');
    this.loopDotEl.className = 'status-dot';

    if (snap.state === 'idle') {
      this.loopMainBtn.textContent = this.tr(
        snap.eventCount > 0 ? 'loopMainResume' : 'loopMainStart'
      );
      this.loopStatEl.textContent =
        snap.eventCount > 0
          ? this.tr('loopStatPaused', { layers: snap.layerCount, notes: snap.eventCount })
          : this.tr('loopStatIdle');
      if (snap.eventCount > 0) this.loopDotEl.classList.add('on');
    } else if (snap.state === 'count_in') {
      this.loopMainBtn.textContent = this.tr('loopMainCountIn', { beat: snap.countInBeat });
      this.loopMainBtn.classList.add('state-count');
      this.loopDotEl.classList.add('warn');
      this.loopStatEl.textContent = this.tr('loopStatCountIn', { bars: snap.bars });
    } else if (snap.state === 'recording') {
      this.loopMainBtn.textContent = this.tr('loopMainLock');
      this.loopMainBtn.classList.add('state-rec');
      this.loopDotEl.classList.add('rec');
      const curBar = Math.min(snap.bars, Math.floor(snap.phase * snap.bars) + 1);
      this.loopStatEl.textContent = this.tr('loopStatRecording', {
        bar: curBar,
        bars: snap.bars,
        notes: snap.eventCount,
      });
    } else if (snap.state === 'playing') {
      this.loopMainBtn.textContent = this.tr('loopMainOverdub');
      this.loopDotEl.classList.add('on');
      const curBar = Math.min(snap.bars, Math.floor(snap.phase * snap.bars) + 1);
      this.loopStatEl.textContent = this.tr('loopStatPlaying', {
        bar: curBar,
        bars: snap.bars,
        layers: snap.layerCount,
        notes: snap.eventCount,
      });
    } else if (snap.state === 'overdub') {
      this.loopMainBtn.textContent = this.tr('loopMainEndOverdub');
      this.loopMainBtn.classList.add('state-rec');
      this.loopDotEl.classList.add('rec');
      const curBar = Math.min(snap.bars, Math.floor(snap.phase * snap.bars) + 1);
      this.loopStatEl.textContent = this.tr('loopStatOverdub', {
        bar: curBar,
        bars: snap.bars,
        layers: snap.layerCount,
        notes: snap.eventCount,
      });
    }
  }

  updateMidiUi(
    ports: MidiPortInfo[],
    selectedPortId: string,
    enabled: boolean,
    channel: number,
    lastMessage: string
  ): void {
    this.lastMidiState = { ports, selectedPortId, enabled, channel, lastMessage };
    this.midiDotEl.className = enabled ? 'status-dot on' : 'status-dot';
    this.midiEnableBtn.classList.toggle('active', enabled);
    this.midiEnableBtn.textContent = this.tr(enabled ? 'midiOutOn' : 'midiOutOff');
    this.midiChanSel.value = String(channel);
    this.midiLogEl.textContent = lastMessage;

    if (ports.length === 0) {
      this.midiPortSel.innerHTML = `<option value="">${this.tr('midiPortNone')}</option>`;
    } else {
      const options = ports
        .map(
          (p) =>
            `<option value="${p.id}" ${p.id === selectedPortId ? 'selected' : ''}>${p.name}</option>`
        )
        .join('');
      if (this.midiPortSel.innerHTML !== options) {
        this.midiPortSel.innerHTML = options;
      }
      this.midiPortSel.value = selectedPortId;
    }
    this.updateLocalMuteUi();
  }

  private updateLocalMuteUi(): void {
    this.midiLocalMuteBtn.classList.toggle('active', this.settings.localMute);
    this.midiLocalMuteBtn.textContent = this.tr(
      this.settings.localMute ? 'midiLocalMuted' : 'midiLocalOn'
    );
  }

  updateNote(noteName: string, freq: number): void {
    this.lastNoteText = `${noteName} · ${Math.round(freq)}Hz`;
    this.noteEl.textContent = this.lastNoteText;
    this.noteEl.classList.add('pulse');
    window.setTimeout(() => this.noteEl.classList.remove('pulse'), 110);
  }

  updateStats(stringCount: number, fps: number): void {
    this.lastStringCount = stringCount;
    this.lastFps = fps;
    this.countEl.textContent = this.tr('hudStringsCount', { n: stringCount });
    this.fpsEl.textContent = `${Math.round(fps)} FPS`;
  }

  showToast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.classList.remove('show');
    }, 2400);
  }

  getLocaleName(): string {
    return getLocaleNativeName(this.locale);
  }
}
