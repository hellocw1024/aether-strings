/**
 * Polyphonic Multi-Engine Physical & Modal Synthesizer (AudioWorkletProcessor).
 * 5 genuinely distinct instrument engines (up to 24 simultaneous voices):
 * - harp:    Silky finger-plucked Karplus-Strong (true 1-pole IIR LP) + airy octave bloom
 * - guzheng: Crispy pick attack + authentic string-tension pitch snap + bright zither loop
 * - guitar:  Warm dark nylon string (heavy IIR damping) + wooden body bandpass resonator
 * - synth:   Detuned dual-saw + sub-octave virtual analog pluck through resonant sweeping SVF
 * - crystal: Pure quartz singing bowl modal synthesis (1.0, 1.0035 beating, 2.0, 2.756 glass mode)
 *
 * Guarantees: strictly passive decay (zero self-oscillation) + instant zero-buffer hardStop.
 */

const MAX_VOICES = 24;
const BUF_SIZE = 4096; // supports down to ~12 Hz at 48 kHz
const BUF_MASK = BUF_SIZE - 1;
const TWO_PI = Math.PI * 2;

class StringVoice {
  constructor() {
    this.active = false;
    this.stringId = -1;
    this.age = 0;
    this.timbreKey = 'harp';
    this.sr = 48000;

    // Karplus-Strong state (used by harp, guzheng, guitar)
    this.buffer = new Float32Array(BUF_SIZE);
    this.writeIdx = 0;
    this.currentDelay = 120;
    this.targetDelay = 120;
    this.iirState = 0; // true 1-pole IIR lowpass state (monotonic brightness control!)
    this.iirAlpha = 0.7;
    this.decayBase = 0.997;

    // Pitch snap (guzheng tension drop on attack)
    this.pitchSnap = 0;

    // Resonant 2-pole SVF state (used by guitar body resonator & synth resonant filter sweep!)
    this.svfLow = 0;
    this.svfBand = 0;
    this.svfCutoff = 1200;
    this.svfTargetCutoff = 400;
    this.svfQ = 1.0;

    // Oscillator / modal phases (used by harp octave, synth dual-saw+sub, crystal bowl modes)
    this.freq = 261.63;
    this.targetFreq = 261.63;
    this.p1 = 0;
    this.p2 = 0;
    this.p3 = 0;
    this.p4 = 0;

    // Envelopes
    this.env = 0;
    this.envAttack = 0;
    this.envDecay = 0.9999;
    this.overtoneEnv = 0;
    this.overtoneDecay = 0.9997;

    // Output conditioning & stereo pan
    this.dcPrevX = 0;
    this.dcPrevY = 0;
    this.panL = 0.707;
    this.panR = 0.707;
    this.energy = 0;
    this.muting = false;
    this.gain = 0.6;
  }

  trigger(stringId, freq, velocity, pluckPos, pan, timbreKey, sr) {
    const safeFreq = Math.max(45, Math.min(2400, freq));
    const safeVel = Math.max(0.12, Math.min(1, velocity));
    const delay = Math.max(8, Math.min(BUF_SIZE - 4, sr / safeFreq - 0.5));

    this.active = true;
    this.stringId = stringId;
    this.age = 0;
    this.timbreKey = timbreKey || 'harp';
    this.sr = sr;
    this.freq = safeFreq;
    this.targetFreq = safeFreq;
    this.currentDelay = delay;
    this.targetDelay = delay;
    this.iirState = 0;
    this.svfLow = 0;
    this.svfBand = 0;
    this.dcPrevX = 0;
    this.dcPrevY = 0;
    this.muting = false;
    this.p1 = 0;
    this.p2 = 0;
    this.p3 = 0;
    this.p4 = 0;
    this.pitchSnap = 0;

    // Equal-power stereo pan
    const p = (Math.max(-1, Math.min(1, pan)) + 1) * 0.25 * Math.PI;
    this.panL = Math.cos(p);
    this.panR = Math.sin(p);

    const velGain = 0.3 + 0.7 * safeVel;

    if (this.timbreKey === 'synth') {
      // --- CYBER ELECTRIC SYNTH: Detuned Dual-Saw + Sub-Octave + Sweeping Resonant Low-Pass ---
      this.gain = 0.44 * velGain;
      this.env = 1.0;
      this.envAttack = 0;
      // Clean ~1.6s exponential decay (per-sample multiplier)
      this.envDecay = Math.exp(-3.0 / sr);
      this.overtoneEnv = 1.0;
      this.overtoneDecay = Math.exp(-9.5 / sr);
      this.svfCutoff = Math.min(sr * 0.36, safeFreq * (7.0 + safeVel * 9.0));
      this.svfTargetCutoff = Math.max(140, safeFreq * 1.25);
      this.svfQ = 3.2; // juicy cyber resonance
      this.energy = this.gain;
      return;
    }

    if (this.timbreKey === 'crystal') {
      // --- CRYSTAL SINGING BOWL: Pure Glassy Modal Synthesis with Slow Beating ---
      this.gain = 0.42 * velGain;
      this.env = 1.0;
      this.envAttack = 0; // gentle 18ms glassy bloom attack (zero harsh click!)
      this.envDecay = Math.exp(-1.15 / sr); // ~3.5-4s ethereal singing sustain
      this.overtoneEnv = 0.42 * safeVel;
      this.overtoneDecay = Math.exp(-3.2 / sr); // glassy 2.756x overtone fades faster
      this.energy = this.gain;
      return;
    }

    // --- ACOUSTIC PLUCKED STRING ENGINES (harp / guzheng / guitar) ---
    let excBrightness = 0.65;
    let noiseMix = 0.75;
    let combDepth = 0.52;

    if (this.timbreKey === 'harp') {
      // Silky airy concert harp: warm finger exciter + smooth IIR + octave bloom
      this.gain = 0.62 * velGain;
      this.iirAlpha = 0.62;
      this.decayBase = 0.9972;
      excBrightness = 0.55;
      noiseMix = 0.48; // smoother, rounder finger pluck
      combDepth = 0.45;
      this.overtoneEnv = 0.16 * safeVel;
      this.overtoneDecay = Math.exp(-2.8 / sr);
    } else if (this.timbreKey === 'guzheng') {
      // Bright crispy Chinese guzheng: fingernail/pick transient + tension pitch-snap + bright zither loop
      this.gain = 0.68 * velGain;
      this.iirAlpha = 0.92; // preserves shimmering metallic upper harmonics!
      this.decayBase = 0.9968;
      excBrightness = 0.96; // super crisp pick attack
      noiseMix = 0.92;
      combDepth = 0.65;
      this.pitchSnap = 0.032 * safeVel; // ~+55 cents initial tension snap settling down!
      this.svfCutoff = 1650; // zither bridge brightness formant
      this.svfQ = 1.8;
      this.overtoneEnv = 0.22 * safeVel;
      this.overtoneDecay = Math.exp(-6.5 / sr);
    } else {
      // guitar: Warm woody classical nylon guitar: dark low-pass loop + wooden body resonance + punchy decay
      this.gain = 0.76 * velGain;
      this.iirAlpha = 0.38; // strongly damped highs -> rich warm dark nylon tone while keeping treble clear!
      this.decayBase = 0.9946; // tighter acoustic guitar decay
      excBrightness = 0.28; // mellow thumb/flesh pluck
      noiseMix = 0.35;
      combDepth = 0.38;
      this.svfCutoff = 230; // warm acoustic guitar wooden body resonance!
      this.svfQ = 2.4;
      this.overtoneEnv = 0;
    }

    // Compensate for 1-pole IIR lowpass phase delay: tau = (1 - alpha) / alpha
    const iirLag = (1 - this.iirAlpha) / Math.max(0.1, this.iirAlpha);
    const tunedDelay = Math.max(6, Math.min(BUF_SIZE - 4, sr / safeFreq - iirLag));
    this.currentDelay = tunedDelay;
    this.targetDelay = tunedDelay;

    // Build excitation burst
    const period = Math.min(BUF_SIZE - 4, Math.ceil(tunedDelay) + 2);
    const effPluck =
      this.timbreKey === 'guzheng'
        ? Math.min(0.24, Math.max(0.08, pluckPos * 0.45)) // plucked closer to bridge -> twangy!
        : this.timbreKey === 'guitar'
          ? 0.44 // plucked near sound hole -> warm fundamental!
          : Math.max(0.12, Math.min(0.88, pluckPos));
    const combOffset = Math.max(1, Math.round(effPluck * period));
    const lpAlpha = Math.max(0.08, Math.min(0.98, excBrightness * (0.55 + 0.45 * safeVel)));

    const burst = new Float32Array(period);
    let lp = 0;
    let sum = 0;
    for (let i = 0; i < period; i++) {
      const white = Math.random() * 2 - 1;
      const u = i / period;
      // Guzheng adds sharp pick impulse at start; guitar/harp lean into smooth triangular/sine body
      let shaped;
      if (this.timbreKey === 'guzheng') {
        const pickClick = i < 14 ? Math.sin((i / 14) * Math.PI) * 1.35 : 0;
        shaped = white * noiseMix + (u * 2 - 1) * (1 - noiseMix) + pickClick;
      } else {
        const tri =
          u < effPluck
            ? u / Math.max(0.05, effPluck)
            : (1 - u) / Math.max(0.05, 1 - effPluck);
        const sineBody = Math.sin(u * TWO_PI);
        shaped = white * noiseMix + ((tri * 2 - 1) * 0.55 + sineBody * 0.45) * (1 - noiseMix);
      }
      lp = lp + lpAlpha * (shaped - lp);
      burst[i] = lp;
      sum += lp;
    }

    const mean = sum / period;
    this.buffer.fill(0);
    for (let i = 0; i < period; i++) {
      const a = burst[i] - mean;
      const b = i >= combOffset ? burst[i - combOffset] - mean : 0;
      const sample = (a - combDepth * b) * this.gain;
      const idx = (BUF_SIZE - period + i) & BUF_MASK;
      this.buffer[idx] = sample;
    }

    this.writeIdx = 0;
    this.energy = this.gain;
  }

  retune(freq, stepChanged, sr) {
    if (!this.active) return;
    const safeFreq = Math.max(45, Math.min(2400, freq));
    this.targetFreq = safeFreq;
    const iirLag = (1 - this.iirAlpha) / Math.max(0.1, this.iirAlpha);
    this.targetDelay = Math.max(6, Math.min(BUF_SIZE - 4, sr / safeFreq - iirLag));

    if (stepChanged && this.energy > 0.015 && !this.muting) {
      if (this.timbreKey === 'synth') {
        this.svfCutoff = Math.min(sr * 0.34, Math.max(this.svfCutoff, safeFreq * 6.5));
        this.env = Math.min(1.0, this.env + 0.18);
      } else if (this.timbreKey === 'crystal') {
        this.overtoneEnv = Math.min(0.4, this.overtoneEnv + 0.14);
      } else {
        // Gentle hammer-on re-excitation on acoustic string fret slide
        const boost = Math.min(0.16, this.energy * 0.6);
        const len = Math.min(128, Math.floor(this.targetDelay));
        for (let i = 0; i < len; i++) {
          const idx = (this.writeIdx - 1 - i) & BUF_MASK;
          const win = Math.sin((i / len) * Math.PI);
          this.buffer[idx] += (Math.random() * 2 - 1) * boost * win * 0.32;
        }
      }
    }
  }

  mute() {
    if (this.active) {
      this.muting = true;
    }
  }

  hardKill() {
    this.active = false;
    this.muting = false;
    this.buffer.fill(0);
    this.iirState = 0;
    this.svfLow = 0;
    this.svfBand = 0;
    this.dcPrevX = 0;
    this.dcPrevY = 0;
    this.env = 0;
    this.overtoneEnv = 0;
    this.energy = 0;
  }

  processSample() {
    if (!this.active) return 0;

    let out = 0;

    if (this.timbreKey === 'synth') {
      out = this.processSynthSample();
    } else if (this.timbreKey === 'crystal') {
      out = this.processCrystalSample();
    } else {
      out = this.processStringSample();
    }

    // DC blocker
    const dcOut = out - this.dcPrevX + 0.995 * this.dcPrevY;
    this.dcPrevX = out;
    this.dcPrevY = dcOut;

    // Envelope tracking for clean voice reaping
    this.energy = this.energy * 0.9992 + Math.abs(dcOut) * 0.0008;
    this.age++;
    if (this.age > 2400 && this.energy < 0.0002 && this.env < 0.0008 && this.overtoneEnv < 0.0005) {
      this.active = false;
    }

    return dcOut;
  }

  processSynthSample() {
    // Smooth frequency glide
    this.freq += (this.targetFreq - this.freq) * 0.006;

    // Fast 3ms punchy attack ramp + strict exponential decay
    this.envAttack = Math.min(1, this.envAttack + 1 / (this.sr * 0.003));
    this.env *= this.muting ? 0.965 : this.envDecay;
    this.overtoneEnv *= this.muting ? 0.95 : this.overtoneDecay;

    // Detuned dual sawtooth (+/- 11 cents) + sub-octave square/triangle weight
    const inc1 = (this.freq * 0.9935) / this.sr;
    const inc2 = (this.freq * 1.0065) / this.sr;
    const incSub = (this.freq * 0.5) / this.sr;
    this.p1 = (this.p1 + inc1) % 1;
    this.p2 = (this.p2 + inc2) % 1;
    this.p3 = (this.p3 + incSub) % 1;

    const saw1 = this.p1 * 2 - 1;
    const saw2 = this.p2 * 2 - 1;
    const sub = 1 - 4 * Math.abs(this.p3 - 0.5); // sub triangle
    const raw = saw1 * 0.44 + saw2 * 0.44 + sub * 0.36;

    // Sweeping resonant 2-pole Chamberlin State-Variable Low-Pass Filter
    const curCut =
      this.svfTargetCutoff + (this.svfCutoff - this.svfTargetCutoff) * this.overtoneEnv;
    const f = Math.min(0.72, 2 * Math.sin((Math.PI * Math.min(this.sr * 0.24, curCut)) / this.sr));
    const qInv = 1 / this.svfQ;
    const high = raw - this.svfLow - qInv * this.svfBand;
    this.svfBand += f * high;
    this.svfLow += f * this.svfBand;
    // Soft clamp SVF states for numerical stability at high Q
    this.svfBand = Math.tanh(this.svfBand * 0.7) * 1.42;

    const amp = this.env * this.envAttack * this.gain;
    return Math.tanh(this.svfLow * 1.85) * amp;
  }

  processCrystalSample() {
    this.freq += (this.targetFreq - this.freq) * 0.004;

    // Smooth 18ms velvet mallet swell + long pure singing decay
    this.envAttack = Math.min(1, this.envAttack + 1 / (this.sr * 0.018));
    this.env *= this.muting ? 0.96 : this.envDecay;
    this.overtoneEnv *= this.muting ? 0.95 : this.overtoneDecay;

    // 4 pure quartz singing-bowl modes:
    // f (fundamental), 1.0038*f (hypnotic slow acoustic beating!), 2.0*f (octave), 2.756*f (glass bell mode)
    this.p1 += (TWO_PI * this.freq) / this.sr;
    this.p2 += (TWO_PI * this.freq * 1.0038) / this.sr;
    this.p3 += (TWO_PI * this.freq * 2.0) / this.sr;
    this.p4 += (TWO_PI * this.freq * 2.756) / this.sr;
    if (this.p1 > TWO_PI) this.p1 -= TWO_PI;
    if (this.p2 > TWO_PI) this.p2 -= TWO_PI;
    if (this.p3 > TWO_PI) this.p3 -= TWO_PI;
    if (this.p4 > TWO_PI) this.p4 -= TWO_PI;

    const fund = (Math.sin(this.p1) * 0.62 + Math.sin(this.p2) * 0.48) * this.env;
    const glass = (Math.sin(this.p3) * 0.35 + Math.sin(this.p4) * 0.55) * this.overtoneEnv;

    return (fund + glass) * this.envAttack * this.gain;
  }

  processStringSample() {
    // Smooth fractional delay glide (+ guzheng initial tension pitch snap settling down)
    this.currentDelay += (this.targetDelay - this.currentDelay) * 0.0045;
    let effDelay = this.currentDelay;
    if (this.pitchSnap > 0.0002) {
      effDelay = Math.max(8, this.currentDelay / (1 + this.pitchSnap));
      this.pitchSnap *= 0.99935; // settles over ~65ms like real plucked guzheng string!
    }

    const readPos = this.writeIdx - effDelay;
    const i0 = Math.floor(readPos);
    const frac = readPos - i0;
    const s0 = this.buffer[i0 & BUF_MASK];
    const s1 = this.buffer[(i0 + 1) & BUF_MASK];
    const delayed = s0 + (s1 - s0) * frac;

    // True 1-pole IIR lowpass filter inside loop:
    // iirAlpha=0.28 (guitar) is genuinely DARK & WARM; iirAlpha=0.92 (guzheng) is genuinely BRIGHT & CRISPY!
    this.iirState = this.iirState + this.iirAlpha * (delayed - this.iirState);

    // Strictly passive frequency-compensated damping (< 1.0 guaranteed)
    const decay = this.muting
      ? 0.935
      : Math.min(0.9985, this.decayBase - (1 / (this.currentDelay + 55)) * 0.042);

    const feedback = this.iirState * decay;
    this.buffer[this.writeIdx] = feedback;
    this.writeIdx = (this.writeIdx + 1) & BUF_MASK;

    let out = feedback;

    if (this.timbreKey === 'guitar') {
      // Add warm acoustic wooden body bandpass resonance around ~230 Hz
      const f = 2 * Math.sin((Math.PI * this.svfCutoff) / this.sr);
      const high = feedback - this.svfLow - (1 / this.svfQ) * this.svfBand;
      this.svfBand += f * high;
      this.svfLow += f * this.svfBand;
      out = feedback * 0.78 + this.svfBand * 0.42;
    } else if (this.timbreKey === 'guzheng') {
      // Bright zither bridge nasal resonance (~1.65 kHz) + crisp second-harmonic shimmer
      const f = 2 * Math.sin((Math.PI * this.svfCutoff) / this.sr);
      const high = feedback - this.svfLow - (1 / this.svfQ) * this.svfBand;
      this.svfBand += f * high;
      this.svfLow += f * this.svfBand;
      out = feedback * 0.85 + this.svfBand * 0.36;
      if (this.overtoneEnv > 0.0005) {
        this.p1 += (TWO_PI * this.freq * 3.0) / this.sr;
        if (this.p1 > TWO_PI) this.p1 -= TWO_PI;
        out += Math.sin(this.p1) * this.overtoneEnv * 0.25;
        this.overtoneEnv *= this.muting ? 0.94 : this.overtoneDecay;
      }
    } else if (this.timbreKey === 'harp') {
      // Airy concert harp octave sparkle
      if (this.overtoneEnv > 0.0005) {
        this.p1 += (TWO_PI * this.freq * 2.0) / this.sr;
        if (this.p1 > TWO_PI) this.p1 -= TWO_PI;
        out += Math.sin(this.p1) * this.overtoneEnv * 0.32;
        this.overtoneEnv *= this.muting ? 0.94 : this.overtoneDecay;
      }
    }

    return out;
  }
}

class KarplusStrongProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = Array.from({ length: MAX_VOICES }, () => new StringVoice());
    this.port.onmessage = (e) => this.handleMessage(e.data);
  }

  handleMessage(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'pluck') {
      const voice = this.allocateVoice(msg.stringId);
      voice.trigger(
        msg.stringId,
        msg.freq,
        msg.velocity,
        msg.pluckPos,
        msg.pan,
        msg.timbre,
        sampleRate
      );
    } else if (msg.type === 'retune') {
      for (const v of this.voices) {
        if (v.active && v.stringId === msg.stringId) {
          v.retune(msg.freq, msg.stepChanged, sampleRate);
        }
      }
    } else if (msg.type === 'mute') {
      for (const v of this.voices) {
        if (v.active && v.stringId === msg.stringId) {
          v.mute();
        }
      }
    } else if (msg.type === 'clear') {
      for (const v of this.voices) {
        v.mute();
      }
    } else if (msg.type === 'hardStop') {
      for (const v of this.voices) {
        v.hardKill();
      }
    }
  }

  allocateVoice(stringId) {
    for (const v of this.voices) {
      if (!v.active) return v;
    }
    let sameStr = null;
    let quietest = this.voices[0];
    for (const v of this.voices) {
      if (v.stringId === stringId && (!sameStr || v.age > sameStr.age)) {
        sameStr = v;
      }
      if (v.energy < quietest.energy) {
        quietest = v;
      }
    }
    return sameStr || quietest;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const outL = output[0];
    const outR = output[1] || output[0];
    const len = outL.length;

    outL.fill(0);
    if (outR !== outL) outR.fill(0);

    for (let vIdx = 0; vIdx < MAX_VOICES; vIdx++) {
      const voice = this.voices[vIdx];
      if (!voice.active) continue;
      const pL = voice.panL;
      const pR = voice.panR;
      for (let i = 0; i < len; i++) {
        const s = voice.processSample();
        outL[i] += s * pL;
        if (outR !== outL) outR[i] += s * pR;
      }
    }

    // Soft master headroom limiting
    for (let i = 0; i < len; i++) {
      outL[i] = Math.tanh(outL[i] * 0.92);
      if (outR !== outL) outR[i] = Math.tanh(outR[i] * 0.92);
    }

    return true;
  }
}

registerProcessor('karplus-strong-processor', KarplusStrongProcessor);
