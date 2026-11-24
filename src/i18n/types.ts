export type LocaleId = 'zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'it' | 'es' | 'ru' | 'ar';

export interface TranslationDict {
  // Page & Brand
  pageTitle: string;
  hudStringsCount: string; // e.g. "{n} 弦" / "{n} STR"

  // Top bar buttons
  btnCam: string;
  btnCamOn: string;
  btnCamOpen: string;
  btnCamTitle: string;
  btnLooper: string;
  btnLooperTitle: string;
  btnMidi: string;
  btnMidiTitle: string;
  btnRec: string;
  btnRecStop: string; // "停止 {time}"
  btnRecTitle: string;
  btnUndo: string;
  btnUndoTitle: string;
  btnClear: string;
  btnClearTitle: string;
  btnGuideTitle: string;
  btnPanel: string;
  btnPanelTitle: string;
  langAuto: string; // "AUTO ({code})"
  langTitle: string;

  // Dock section labels
  lblScale: string;
  lblTimbre: string;
  lblPreset: string;
  lblSpaceFx: string;
  lblTheme: string;
  lblBg: string;
  lblHand: string;
  hintStrip: string;

  // Scales
  scale_pentatonic_cn: string;
  scale_minor_pentatonic: string;
  scale_blues: string;
  scale_harmonic_minor: string;
  scale_melodic_minor: string;
  scale_major: string;
  scale_minor: string;
  scale_fretless: string;

  // Timbres
  timbre_harp: string;
  timbre_guzheng: string;
  timbre_guitar: string;
  timbre_synth: string;
  timbre_crystal: string;

  // Presets
  preset_web: string;
  preset_harp: string;
  preset_guzheng: string;
  preset_star: string;

  // Themes (label & subtitle)
  theme_plasma: string;
  theme_plasma_sub: string;
  theme_ink: string;
  theme_ink_sub: string;
  theme_abyss: string;
  theme_abyss_sub: string;
  theme_celestial: string;
  theme_celestial_sub: string;
  theme_synthwave: string;
  theme_synthwave_sub: string;

  // Background filters & custom image
  bg_cinema: string;
  bg_portrait: string;
  bg_cyber: string;
  bg_xray: string;
  bg_clean: string;
  btnBgUpload: string;
  btnBgUploadTitle: string;
  btnBgClear: string;
  btnBgClearTitle: string;

  // Hand visual modes
  hand_hologram: string;
  hand_classic: string;
  hand_minimal: string;

  // Air Looper UI
  loopBarsUnit: string; // "{n} 小节" / "{n} BARS"
  loopStop: string;
  loopStopTitle: string;
  loopTap: string;
  loopTapTitle: string;
  loopMetro: string;
  loopMetroTitle: string;
  loopUndo: string;
  loopUndoTitle: string;
  loopClear: string;
  loopClearTitle: string;
  loopMainStart: string;
  loopMainResume: string;
  loopMainCountIn: string; // "{beat}/4"
  loopMainLock: string;
  loopMainOverdub: string;
  loopMainEndOverdub: string;
  loopStatIdle: string;
  loopStatPaused: string; // "{layers} / {notes}"
  loopStatCountIn: string; // "{bars}"
  loopStatRecording: string; // "{bar}/{bars} / {notes}"
  loopStatPlaying: string; // "{bar}/{bars} / {layers} / {notes}"
  loopStatOverdub: string; // "{bar}/{bars} / {layers} / {notes}"

  // MIDI Popover
  midiTitle: string;
  midiScan: string;
  midiPortLabel: string;
  midiPortPrompt: string;
  midiPortNone: string;
  midiChanLabel: string;
  midiOutOn: string;
  midiOutOff: string;
  midiLocalOn: string;
  midiLocalMuted: string;
  midiPanic: string;
  midiDefaultLog: string;
  midiNotConnected: string;
  midiUnsupported: string;
  midiConnected: string; // "{name}"
  midiNoPorts: string;
  midiAuthFailed: string; // "{error}"
  midiOutputTo: string; // "{name}"
  midiSelectPrompt: string;
  midiPaused: string;

  // Guide Popover
  guideTitle: string;
  guidePinchTitle: string;
  guidePinchDesc: string;
  guidePluckTitle: string;
  guidePluckDesc: string;
  guideBendTitle: string;
  guideBendDesc: string;
  guideDeleteTitle: string;
  guideDeleteDesc: string;
  guideMuteTitle: string;
  guideMuteDesc: string;
  guideWheelTitle: string;
  guideWheelDesc: string;
  guideBgSwipeTitle: string;
  guideBgSwipeDesc: string;
  guideLoopTitle: string;
  guideLoopDesc: string;
  guideMidiTitle: string;
  guideMidiDesc: string;
  guideMouseTitle: string;
  guideMouseDesc: string;

  // Start Overlay
  startHeading: string;
  startSub: string;
  startCard1Title: string;
  startCard1Desc: string;
  startCard2Title: string;
  startCard2Desc: string;
  startCard3Title: string;
  startCard3Desc: string;
  startCard4Title: string;
  startCard4Desc: string;
  startCard5Title: string;
  startCard5Desc: string;
  startCard6Title: string;
  startCard6Desc: string;
  startCamCta: string;
  startDemoCta: string;

  // Runtime statuses & toasts
  statusInitAudio: string;
  statusReqCam: string;
  statusLoadingVision: string;
  statusLoadingHand: string;
  statusLoadingSeg: string;
  statusCamFail: string; // "{error}"
  errCamUnsupported: string;

  toastCamReady: string;
  toastCamFallback: string;
  toastDemoReady: string;
  toastCamOff: string;
  toastCamStarting: string;
  toastCamOn: string;
  toastCamErr: string; // "{error}"
  toastRecDone: string;
  toastRecStart: string;
  toastRecUnsupported: string;
  toastScale: string; // "{name}"
  toastTimbre: string; // "{name}"
  toastSpaceOn: string;
  toastSpaceOff: string;
  toastTheme: string; // "{name}" "{sub}"
  toastBg: string; // "{name}"
  toastPreset: string; // "{name}"
  toastPortraitLoading: string;
  toastLocalMuted: string;
  toastLocalUnmuted: string;
  toastLoopCountIn: string; // "{bars}"
  toastLoopOverdub: string; // "{layer}"
  toastLoopPlaying: string; // "{layers}"
  toastLoopStopped: string;
  toastLoopUndo: string; // "{count}"
  toastLoopCleared: string;
  toastLoopBars: string; // "{bars}"
  toastLoopBpm: string; // "{bpm}"
  toastMetroOn: string;
  toastMetroOff: string;
  toastMidiPanic: string;
  toastLangChanged: string; // "{name}"
  toastCustomBgLoaded: string; // "{name}"
  toastCustomBgCleared: string;
  toastCustomBgErr: string;
}

export type TranslationKey = keyof TranslationDict;
