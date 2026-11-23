import { t, type LocaleId, type TranslationKey } from '../i18n';
import { midiToNoteName } from '../music/scales';
import type { MidiPortInfo } from '../types';

export interface MidiOutputLike {
  id: string;
  name?: string | null;
  manufacturer?: string | null;
  send(data: number[] | Uint8Array, timestamp?: number): void;
}

export interface MidiAccessLike {
  outputs: Map<string, MidiOutputLike>;
  onstatechange: ((event: unknown) => void) | null;
}

interface ActiveMidiNote {
  midi: number;
  baseMidi: number;
  channel: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const PITCH_BEND_SEMITONES = 2;
const PITCH_BEND_CENTER = 8192;

export class MidiEngine {
  private access: MidiAccessLike | null = null;
  private selectedOutput: MidiOutputLike | null = null;
  private selectedPortId = '';
  private channel = 0; // 0..15 (displayed as Ch 1..16)
  private enabled = false;
  private locale: LocaleId = 'en';
  private lastStatusKey: TranslationKey | null = 'midiDefaultLog';
  private lastStatusVars: Record<string, string | number> | undefined = undefined;
  private lastRawMessage = '';
  private activeNotes = new Map<number, ActiveMidiNote>();
  private onChangeListeners: (() => void)[] = [];

  constructor(private readonly requestAccessFn?: () => Promise<MidiAccessLike>) {}

  setLocale(locale: LocaleId): void {
    this.locale = locale;
    this.notify();
  }

  private setStatus(key: TranslationKey, vars?: Record<string, string | number>): void {
    this.lastStatusKey = key;
    this.lastStatusVars = vars;
    this.lastRawMessage = '';
  }

  private setRawTelemetry(msg: string): void {
    this.lastStatusKey = null;
    this.lastStatusVars = undefined;
    this.lastRawMessage = msg;
  }

  isSupported(): boolean {
    return Boolean(
      this.requestAccessFn ||
        (typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function')
    );
  }

  isEnabled(): boolean {
    return this.enabled && this.selectedOutput !== null;
  }

  getChannel(): number {
    return this.channel + 1;
  }

  getSelectedPortId(): string {
    return this.selectedPortId;
  }

  getLastMessage(): string {
    if (this.lastStatusKey) {
      return t(this.locale, this.lastStatusKey, this.lastStatusVars);
    }
    return this.lastRawMessage || t(this.locale, 'midiNotConnected');
  }

  onChange(listener: () => void): void {
    this.onChangeListeners.push(listener);
  }

  private notify(): void {
    for (const fn of this.onChangeListeners) fn();
  }

  async connect(): Promise<{ ok: boolean; message: string; ports: MidiPortInfo[] }> {
    if (!this.isSupported()) {
      this.setStatus('midiUnsupported');
      this.notify();
      return { ok: false, message: this.getLastMessage(), ports: [] };
    }

    try {
      const access = this.requestAccessFn
        ? await this.requestAccessFn()
        : ((await navigator.requestMIDIAccess({ sysex: false })) as unknown as MidiAccessLike);

      this.access = access;
      this.access.onstatechange = () => {
        this.syncSelectedOutput();
        this.notify();
      };

      const ports = this.getOutputs();
      if (ports.length > 0) {
        if (!this.selectedPortId || !ports.some((p) => p.id === this.selectedPortId)) {
          this.selectOutput(ports[0].id);
        } else {
          this.syncSelectedOutput();
        }
        this.enabled = true;
        this.setStatus('midiConnected', {
          name: this.selectedOutput?.name || ports[0].name,
        });
      } else {
        this.enabled = false;
        this.selectedOutput = null;
        this.setStatus('midiNoPorts');
      }

      this.notify();
      return { ok: true, message: this.getLastMessage(), ports };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setStatus('midiAuthFailed', { error: msg });
      this.enabled = false;
      this.notify();
      return { ok: false, message: this.getLastMessage(), ports: [] };
    }
  }

  getOutputs(): MidiPortInfo[] {
    if (!this.access) return [];
    const list: MidiPortInfo[] = [];
    for (const out of this.access.outputs.values()) {
      list.push({
        id: out.id,
        name: out.name || `MIDI Output ${out.id}`,
        manufacturer: out.manufacturer || '',
      });
    }
    return list;
  }

  selectOutput(portId: string): void {
    this.allNotesOff();
    this.selectedPortId = portId;
    this.syncSelectedOutput();
    if (this.selectedOutput) {
      this.enabled = true;
      this.setStatus('midiOutputTo', { name: this.selectedOutput.name || portId });
    }
    this.notify();
  }

  setEnabled(enabled: boolean): void {
    if (!enabled) {
      this.allNotesOff();
    }
    this.enabled = enabled;
    if (enabled) {
      if (this.selectedOutput) {
        this.setStatus('midiOutputTo', {
          name: this.selectedOutput.name || this.selectedPortId,
        });
      } else {
        this.setStatus('midiSelectPrompt');
      }
    } else {
      this.setStatus('midiPaused');
    }
    this.notify();
  }

  setChannel(ch1To16: number): void {
    this.allNotesOff();
    this.channel = Math.max(0, Math.min(15, Math.round(ch1To16) - 1));
    this.notify();
  }

  noteOn(stringId: number, midiFloat: number, velocity01: number): void {
    if (!this.isEnabled() || !this.selectedOutput) return;

    this.noteOff(stringId);

    const midiNote = Math.max(0, Math.min(127, Math.round(midiFloat)));
    const vel = Math.max(1, Math.min(127, Math.round(velocity01 * 127)));
    const ch = this.channel;

    const fracSemi = midiFloat - midiNote;
    if (Math.abs(fracSemi) > 0.02) {
      this.sendPitchBend(ch, fracSemi);
    } else {
      this.sendPitchBend(ch, 0);
    }

    this.selectedOutput.send([0x90 | ch, midiNote, vel]);

    const decayMs = Math.round(2400 - Math.max(0, Math.min(1, (midiNote - 48) / 36)) * 1100);
    const timer = setTimeout(() => {
      this.noteOff(stringId);
    }, decayMs);

    this.activeNotes.set(stringId, {
      midi: midiNote,
      baseMidi: midiNote,
      channel: ch,
      timer,
    });

    this.setRawTelemetry(`NoteOn ${midiToNoteName(midiNote)} vel=${vel} ch=${ch + 1}`);
  }

  retune(stringId: number, midiFloat: number, stepChanged: boolean): void {
    if (!this.isEnabled() || !this.selectedOutput) return;
    const active = this.activeNotes.get(stringId);
    if (!active) return;

    const semiDiff = midiFloat - active.baseMidi;
    if (!stepChanged && Math.abs(semiDiff) <= PITCH_BEND_SEMITONES) {
      this.sendPitchBend(active.channel, semiDiff);
      this.setRawTelemetry(
        `Bend ${semiDiff >= 0 ? '+' : ''}${semiDiff.toFixed(2)}st ch=${active.channel + 1}`
      );
      return;
    }

    const nextMidi = Math.max(0, Math.min(127, Math.round(midiFloat)));
    if (nextMidi !== active.midi) {
      this.selectedOutput.send([0x80 | active.channel, active.midi, 0]);
      this.sendPitchBend(active.channel, 0);
      this.selectedOutput.send([0x90 | active.channel, nextMidi, 86]);
      active.midi = nextMidi;
      active.baseMidi = nextMidi;
      this.setRawTelemetry(`Legato ${midiToNoteName(nextMidi)} ch=${active.channel + 1}`);
    }
  }

  noteOff(stringId: number): void {
    const active = this.activeNotes.get(stringId);
    if (!active) return;
    if (active.timer !== null) {
      clearTimeout(active.timer);
    }
    this.activeNotes.delete(stringId);
    if (this.selectedOutput) {
      this.selectedOutput.send([0x80 | active.channel, active.midi, 0]);
      if (this.activeNotes.size === 0) {
        this.sendPitchBend(active.channel, 0);
      }
    }
  }

  allNotesOff(): void {
    for (const id of [...this.activeNotes.keys()]) {
      this.noteOff(id);
    }
    if (this.selectedOutput) {
      this.sendPitchBend(this.channel, 0);
      this.selectedOutput.send([0xb0 | this.channel, 123, 0]);
      this.selectedOutput.send([0xb0 | this.channel, 120, 0]);
      this.setRawTelemetry(`All Notes Off (ch=${this.channel + 1})`);
    }
  }

  private sendPitchBend(channel: number, semitones: number): void {
    if (!this.selectedOutput) return;
    const norm = Math.max(-1, Math.min(1, semitones / PITCH_BEND_SEMITONES));
    const val = Math.max(0, Math.min(16383, Math.round(PITCH_BEND_CENTER + norm * 8191)));
    const lsb = val & 0x7f;
    const msb = (val >> 7) & 0x7f;
    this.selectedOutput.send([0xe0 | channel, lsb, msb]);
  }

  private syncSelectedOutput(): void {
    if (!this.access) {
      this.selectedOutput = null;
      return;
    }
    this.selectedOutput = this.access.outputs.get(this.selectedPortId) ?? null;
  }
}
