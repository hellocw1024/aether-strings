import type { TimbreId } from '../types';

export interface AudioReactiveMetrics {
  rms: number; // 0..1 overall loudness
  bass: number; // 0..1 low-band energy
  treble: number; // 0..1 high-band energy
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private inputBus: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private hallImpulseBuffer: AudioBuffer | null = null;
  private delayL: DelayNode | null = null;
  private delayR: DelayNode | null = null;
  private fbL: GainNode | null = null;
  private fbR: GainNode | null = null;
  private delayLP: BiquadFilterNode | null = null;
  private delayMerger: ChannelMergerNode | null = null;
  private reverbWet: GainNode | null = null;
  private delayWet: GainNode | null = null;
  private killGate: GainNode | null = null;
  private masterGain: GainNode | null = null;
  private recordDest: MediaStreamAudioDestinationNode | null = null;
  private hardStopTimer: ReturnType<typeof setTimeout> | null = null;

  private freqBins: Uint8Array<ArrayBuffer> = new Uint8Array(64);
  private timeBins: Uint8Array<ArrayBuffer> = new Uint8Array(64);

  private timbre: TimbreId = 'harp';
  private spaceFx = true;
  private reverbAmount = 0.42;
  private localMute = false;
  private initialized = false;
  private useFallbackSynth = false;

  async init(): Promise<void> {
    if (this.initialized) {
      if (this.ctx && this.ctx.state === 'suspended') {
        await this.ctx.resume();
      }
      return;
    }

    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx({ latencyHint: 'interactive' });
    this.ctx = ctx;

    // Master output chain: Source -> Dry + Ping-Pong Delay + Hall Reverb -> Compressor -> Master -> Speakers + Analyser + Recorder
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -10;
    compressor.knee.value = 18;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.16;

    const killGate = ctx.createGain();
    killGate.gain.value = 1.0;
    this.killGate = killGate;

    const masterGain = ctx.createGain();
    masterGain.gain.value = this.localMute ? 0.0 : 0.92;
    this.masterGain = masterGain;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.78;
    this.analyser = analyser;
    this.freqBins = new Uint8Array(analyser.frequencyBinCount);
    this.timeBins = new Uint8Array(analyser.fftSize);

    const recordDest = ctx.createMediaStreamDestination();
    this.recordDest = recordDest;

    // Dry bus
    const dryGain = ctx.createGain();
    dryGain.gain.value = 0.88;

    // Wet output gain buses (kept persistent while convolver/delay internals can be flushed cleanly)
    const reverbWet = ctx.createGain();
    reverbWet.gain.value = this.spaceFx ? this.reverbAmount : 0.06;
    this.reverbWet = reverbWet;

    const delayWet = ctx.createGain();
    delayWet.gain.value = this.spaceFx ? 0.22 : 0;
    this.delayWet = delayWet;

    // Input bus node
    const inputBus = ctx.createGain();
    this.inputBus = inputBus;
    inputBus.connect(dryGain);

    // Build reusable Hall Reverb impulse & flushable Reverb + Ping-Pong Delay branches
    this.hallImpulseBuffer = this.createHallImpulse(ctx, 2.35, 2.6);
    this.rebuildWetEffects();

    dryGain.connect(compressor);
    reverbWet.connect(compressor);
    delayWet.connect(compressor);

    compressor.connect(killGate);
    killGate.connect(masterGain);
    masterGain.connect(analyser);
    masterGain.connect(ctx.destination);
    masterGain.connect(recordDest);

    // Load Karplus-Strong AudioWorklet
    try {
      if (!ctx.audioWorklet) throw new Error('AudioWorklet not supported');
      await ctx.audioWorklet.addModule('/audio/karplus-processor.js?v=5');
      const worklet = new AudioWorkletNode(ctx, 'karplus-strong-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      worklet.connect(inputBus);
      this.workletNode = worklet;
    } catch (err) {
      console.warn('[AudioEngine] Falling back to oscillator pluck synth:', err);
      this.useFallbackSynth = true;
      (this as unknown as { fallbackBus: GainNode }).fallbackBus = inputBus;
    }

    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    this.initialized = true;
  }

  async resume(): Promise<void> {
    if (!this.initialized) {
      await this.init();
      return;
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  setTimbre(timbre: TimbreId): void {
    this.timbre = timbre;
  }

  setSpaceFx(enabled: boolean): void {
    this.spaceFx = enabled;
    this.applyFxGains();
  }

  setReverbAmount(amount: number): void {
    this.reverbAmount = Math.max(0, Math.min(1, amount));
    this.applyFxGains();
  }

  setLocalMute(muted: boolean): void {
    this.localMute = muted;
    if (!this.ctx || !this.masterGain) return;
    this.masterGain.gain.setTargetAtTime(muted ? 0.0 : 0.92, this.ctx.currentTime, 0.02);
  }

  private applyFxGains(): void {
    if (!this.ctx || !this.reverbWet || !this.delayWet) return;
    const now = this.ctx.currentTime;
    this.reverbWet.gain.setTargetAtTime(this.spaceFx ? this.reverbAmount : 0.05, now, 0.04);
    this.delayWet.gain.setTargetAtTime(this.spaceFx ? this.reverbAmount * 0.48 : 0, now, 0.04);
  }

  pluck(
    stringId: number,
    freq: number,
    velocity: number,
    pluckPos: number,
    pan: number,
    timbreOverride?: TimbreId
  ): void {
    if (!this.initialized || !this.ctx) return;
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }

    const activeTimbre = timbreOverride ?? this.timbre;

    if (this.workletNode) {
      this.workletNode.port.postMessage({
        type: 'pluck',
        stringId,
        freq,
        velocity,
        pluckPos,
        pan,
        timbre: activeTimbre,
      });
    } else if (this.useFallbackSynth) {
      this.triggerFallbackPluck(freq, velocity, pan, activeTimbre);
    }
  }

  /**
   * Crisp woodblock/harmonic metronome click routed ONLY to speakers
   * (bypasses recordDest so exported performance videos stay click-free).
   */
  playMetronomeClick(isDownbeat: boolean, isCountIn: boolean): void {
    if (!this.initialized || !this.ctx) return;
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    const freq = isDownbeat ? (isCountIn ? 1320 : 1080) : isCountIn ? 880 : 740;
    const peak = isCountIn ? (isDownbeat ? 0.16 : 0.11) : isDownbeat ? 0.1 : 0.06;
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.65, now + 0.032);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.045);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.05);
  }

  retune(stringId: number, freq: number, stepChanged: boolean): void {
    if (!this.initialized || !this.workletNode) return;
    this.workletNode.port.postMessage({
      type: 'retune',
      stringId,
      freq,
      stepChanged,
    });
  }

  mute(stringId: number): void {
    if (!this.initialized || !this.workletNode) return;
    this.workletNode.port.postMessage({
      type: 'mute',
      stringId,
    });
  }

  clearAllVoices(): void {
    if (!this.initialized || !this.workletNode) return;
    this.workletNode.port.postMessage({ type: 'clear' });
  }

  /**
   * Immediate, click-free total silence: fades killGate to 0 in 12ms,
   * flushes all Karplus-Strong voice buffers, AND replaces Convolver + Ping-Pong
   * Delay nodes with clean zero-state instances so zero reverb/delay tail remains.
   */
  hardStopAll(): void {
    if (!this.initialized || !this.ctx || !this.killGate) return;
    const ctx = this.ctx;
    const gate = this.killGate.gain;
    const now = ctx.currentTime;

    if (this.hardStopTimer !== null) {
      clearTimeout(this.hardStopTimer);
      this.hardStopTimer = null;
    }

    // 1. Click-free 12ms fade to absolute 0.0, and immediately start damping worklet voices
    gate.cancelScheduledValues(now);
    gate.setValueAtTime(gate.value, now);
    gate.linearRampToValueAtTime(0.0, now + 0.012);
    this.workletNode?.port.postMessage({ type: 'clear' });

    // 2. At 15ms (gate is at exact 0.0): wipe all dry voice buffers & replace Convolver/Delay with fresh zero-state nodes
    this.hardStopTimer = setTimeout(() => {
      this.workletNode?.port.postMessage({ type: 'hardStop' });
      this.rebuildWetEffects();
      // 3. Re-open gate 16ms later (after >=5 AudioWorklet quanta have flushed) into complete silence
      this.hardStopTimer = setTimeout(() => {
        this.hardStopTimer = null;
        if (this.ctx && this.killGate) {
          const t = this.ctx.currentTime;
          this.killGate.gain.cancelScheduledValues(t);
          this.killGate.gain.setValueAtTime(0.0, t);
          this.killGate.gain.linearRampToValueAtTime(1.0, t + 0.01);
        }
      }, 16);
    }, 15);
  }

  private rebuildWetEffects(): void {
    if (!this.ctx || !this.inputBus || !this.reverbWet || !this.delayWet) return;
    const ctx = this.ctx;

    // Disconnect old wet nodes cleanly so their internal reverb/delay tails vanish immediately
    try {
      if (this.convolver) {
        this.inputBus.disconnect(this.convolver);
        this.convolver.disconnect();
      }
      if (this.delayL) {
        this.inputBus.disconnect(this.delayL);
        this.delayL.disconnect();
      }
      this.delayR?.disconnect();
      this.fbL?.disconnect();
      this.fbR?.disconnect();
      this.delayLP?.disconnect();
      this.delayMerger?.disconnect();
    } catch {
      // ignore if already disconnected
    }

    // Fresh zero-state Hall Reverb reusing cached impulse buffer
    const convolver = ctx.createConvolver();
    if (this.hallImpulseBuffer) {
      convolver.buffer = this.hallImpulseBuffer;
    }
    this.inputBus.connect(convolver);
    convolver.connect(this.reverbWet);
    this.convolver = convolver;

    // Fresh zero-state Stereo Ping-Pong Delay
    const delayL = ctx.createDelay(1.0);
    const delayR = ctx.createDelay(1.0);
    delayL.delayTime.value = 0.24;
    delayR.delayTime.value = 0.36;
    const fbL = ctx.createGain();
    const fbR = ctx.createGain();
    fbL.gain.value = 0.28;
    fbR.gain.value = 0.26;
    const delayLP = ctx.createBiquadFilter();
    delayLP.type = 'lowpass';
    delayLP.frequency.value = 2600;
    const delayMerger = ctx.createChannelMerger(2);

    delayL.connect(fbL);
    fbL.connect(delayR);
    delayR.connect(delayLP);
    delayLP.connect(fbR);
    fbR.connect(delayL);
    delayL.connect(delayMerger, 0, 0);
    delayR.connect(delayMerger, 0, 1);
    delayMerger.connect(this.delayWet);
    this.inputBus.connect(delayL);

    this.delayL = delayL;
    this.delayR = delayR;
    this.fbL = fbL;
    this.fbR = fbR;
    this.delayLP = delayLP;
    this.delayMerger = delayMerger;
  }

  /**
   * Subtle crystalline lock-in chime when committing a new string.
   */
  playLockChime(freq: number): void {
    if (!this.initialized || !this.ctx || !this.masterGain) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 2, now);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.055, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 0.25);
  }

  getReactiveMetrics(): AudioReactiveMetrics {
    if (!this.analyser) {
      return { rms: 0, bass: 0, treble: 0 };
    }
    this.analyser.getByteTimeDomainData(this.timeBins);
    this.analyser.getByteFrequencyData(this.freqBins);

    let sqSum = 0;
    for (let i = 0; i < this.timeBins.length; i++) {
      const v = (this.timeBins[i] - 128) / 128;
      sqSum += v * v;
    }
    const rms = Math.min(1, Math.sqrt(sqSum / this.timeBins.length) * 3.5);

    let bassSum = 0;
    for (let i = 1; i < 10; i++) bassSum += this.freqBins[i] / 255;
    const bass = Math.min(1, (bassSum / 9) * 1.4);

    let trebleSum = 0;
    for (let i = 18; i < 64; i++) trebleSum += this.freqBins[i] / 255;
    const treble = Math.min(1, (trebleSum / 46) * 2.0);

    return { rms, bass, treble };
  }

  getRecordingStream(): MediaStream | null {
    return this.recordDest?.stream ?? null;
  }

  isReady(): boolean {
    return this.initialized;
  }

  private triggerFallbackPluck(
    freq: number,
    velocity: number,
    pan: number,
    timbre: TimbreId = this.timbre
  ): void {
    if (!this.ctx) return;
    const bus = (this as unknown as { fallbackBus?: GainNode }).fallbackBus;
    if (!bus) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    const panner = this.ctx.createStereoPanner();

    const waveMap: Record<TimbreId, OscillatorType> = {
      harp: 'triangle',
      guzheng: 'sawtooth',
      guitar: 'sine',
      synth: 'sawtooth',
      crystal: 'sine',
    };
    osc.type = waveMap[timbre];
    osc.frequency.setValueAtTime(timbre === 'guzheng' ? freq * 1.03 : freq, now);
    if (timbre === 'guzheng') {
      osc.frequency.exponentialRampToValueAtTime(freq, now + 0.06);
    }

    filter.type = 'lowpass';
    filter.Q.value = timbre === 'synth' ? 5.0 : 1.0;
    const startCut =
      timbre === 'guitar'
        ? freq * 2.2
        : timbre === 'crystal'
          ? freq * 5.0
          : Math.min(8000, freq * (5 + velocity * 6));
    filter.frequency.setValueAtTime(startCut, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(220, freq * 1.25), now + 0.65);

    const decayTime = timbre === 'crystal' ? 2.6 : timbre === 'guitar' ? 0.95 : 1.45;
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.28 * velocity, now + (timbre === 'crystal' ? 0.025 : 0.005));
    gain.gain.exponentialRampToValueAtTime(0.0008, now + decayTime);

    panner.pan.value = pan;

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(panner);
    panner.connect(bus);

    osc.start(now);
    osc.stop(now + decayTime + 0.05);
  }

  private createHallImpulse(ctx: AudioContext, duration: number, decay: number): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * duration);
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < length; i++) {
        const t = i / length;
        const env = Math.pow(1 - t, decay);
        // Gentle early fade-in to avoid pre-ringing clicks
        const attack = Math.min(1, i / (ctx.sampleRate * 0.018));
        const noise = Math.random() * 2 - 1;
        lp = lp + 0.25 * (noise - lp);
        data[i] = lp * env * attack;
      }
    }
    return impulse;
  }
}
