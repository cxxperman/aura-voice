/* Aura — realtime voice chain.
 *
 * mic → input gain → high-pass → [worklet: auto-level, gate, de-esser]
 *     → EQ (mud cut, warmth, presence, air) → compressor → exciter
 *     → stereo doubler + room reverb → limiter → output
 */

// Runs on the audio thread. Kept as a string so it loads from a Blob URL on file://.
const WORKLET_SOURCE = `
class VoiceDynamics extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'gate',  defaultValue: -100, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'deess', defaultValue: 0,    minValue: 0,    maxValue: 1, automationRate: 'k-rate' },
      { name: 'auto',  defaultValue: 0,    minValue: 0,    maxValue: 1, automationRate: 'k-rate' },
      { name: 'pop',   defaultValue: 0,    minValue: 0,    maxValue: 1, automationRate: 'k-rate' },
      { name: 'pitch', defaultValue: 0,    minValue: -14,  maxValue: 14, automationRate: 'k-rate' },
      { name: 'timbre', defaultValue: 0,   minValue: -5,   maxValue: 5,  automationRate: 'k-rate' },
      ...['fxring', 'fxringmix', 'fxdrive', 'fxphone', 'fxtrem', 'fxtremdepth', 'fxecho', 'fxechofb', 'fxechomix', 'fxlp'].map((name) => ({ name, defaultValue: 0, automationRate: 'k-rate' })),
    ];
  }
  constructor() {
    super();
    this.env = 0; this.open = false; this.hold = 0; this.g = 1;   // gate
    this.rms = 0.01; this.ag = 1;                                  // auto-level
    this.lp = 0; this.envHi = 0; this.dg = 1;                      // de-esser
    this.lo = 0; this.envLo = 0; this.pg = 1;                      // de-plosive
    // Pitch shifter (pitch-synchronous overlap-add), the twin of NaturalShifter in native/aura_dsp.h.
    this.nMin = (sampleRate / 400) | 0; this.nMax = (sampleRate / 80) | 0; this.nLat = ((this.nMax * 2.9) | 0) + 8;
    this.nIn = new Float32Array(16384); this.nOut = new Float32Array(16384); this.nScore = new Float32Array(this.nMax);
    this.nN = 0; this.nP = sampleRate / 150; this.nSynth = 0; this.nSrc = 0;
    this.eb = new Float32Array(32768); this.ep = 0;                 // effects: echo line
    this.rp = 0; this.tp = 0; this.f1 = 0; this.f2 = 0; this.uw = 0; // effects: oscillators and filters
  }
  correlate(lag, window, step) {
    const b = this.nIn, n = this.nN;
    let c = 0, e0 = 1e-9, e1 = 1e-9;
    for (let i = 0; i < window; i += step) {
      const x = b[(n - i) & 16383], y = b[(n - i - lag) & 16383];
      c += x * y; e0 += x * x; e1 += y * y;
    }
    return c / Math.sqrt(e0 * e1);
  }
  // The pitch period: a coarse sweep finds the neighbourhood, a fine one the period.
  measure() {
    const window = this.nMax * 2, b = this.nIn, n = this.nN, s = this.nScore;
    let e0 = 0;
    for (let i = 0; i < window; i += 4) e0 += b[(n - i) & 16383] * b[(n - i) & 16383];
    if (e0 < 5e-8 * window) return;
    let best = 0, count = 0;
    for (let lag = this.nMin; lag <= this.nMax; lag += 4, count++) {
      s[count] = this.correlate(lag, window, 4);
      if (s[count] > best) best = s[count];
    }
    if (best < 0.4) return;
    for (let j = 1; j + 1 < count; j++) {
      if (s[j] >= 0.88 * best && s[j] >= s[j - 1] && s[j] >= s[j + 1]) {
        const around = this.nMin + 4 * j, fine = [];
        for (let d = 0; d < 9; d++) fine.push(this.correlate(around + d - 4, window, 2));
        let top = 1;
        for (let d = 2; d < 8; d++) if (fine[d] > fine[top]) top = d;
        const a = fine[top - 1], m = fine[top], c = fine[top + 1];
        const shift = Math.max(-0.5, Math.min(0.5, (a - c) / (2 * (a - 2 * m + c) - 1e-9)));
        this.nP += (around + top - 4 + shift - this.nP) * 0.6;
        return;
      }
    }
  }
  // One grain, two periods long: where it is laid sets the pitch, how fast it is read sets the timbre.
  grain(ratio, formant) {
    const P = this.nP, half = P | 0, gain = 1 / Math.max(ratio, 0.5), centre = Math.round(this.nSynth);
    this.nSrc += Math.max(0, Math.floor((this.nSynth - this.nSrc) / P + 0.5)) * P;
    for (let i = -half; i <= half; i++) {
      const at = centre + i;
      if (at <= this.nN - this.nLat) continue;
      const where = this.nSrc + i * formant;
      if (where < 0 || where > this.nN - 1) continue;
      const i0 = Math.floor(where), f = where - i0;
      const v = this.nIn[i0 & 16383] * (1 - f) + this.nIn[(i0 + 1) & 16383] * f;
      this.nOut[at & 16383] += v * (0.5 + 0.5 * Math.cos(Math.PI * i / half)) * gain;
    }
    this.nSynth += P / Math.max(ratio, 0.5);
  }
  shift(x, ratio, formant) {
    this.nIn[this.nN & 16383] = x;
    if ((this.nN & 255) === 255) this.measure();
    while (this.nSynth + this.nP * (0.5 + formant) + 2 <= this.nN) this.grain(ratio, formant);
    const m = this.nN - this.nLat;
    let y = 0;
    if (m >= 0) { y = this.nOut[m & 16383]; this.nOut[m & 16383] = 0; }
    this.nN++;
    return y;
  }
  process(inputs, outputs, p) {
    const input = inputs[0][0], out = outputs[0][0];
    if (!input) return true;
    const sr = sampleRate;
    const thr = Math.pow(10, p.gate[0] / 20), thrClose = thr * 0.63; // 4 dB of hysteresis
    const de = p.deess[0], auto = p.auto[0] > 0.5, pop = p.pop[0];
    const ratio = Math.abs(p.pitch[0]) < 0.01 ? 1 : Math.pow(2, p.pitch[0] / 12), formant = Math.pow(2, p.timbre[0] / 12);
    const shifting = ratio !== 1 || Math.abs(p.timbre[0]) > 0.01;
    // Ready voices, mirrored from the module so a recorded sample can be auditioned with them.
    const ringMix = p.fxring[0] > 0 ? p.fxringmix[0] : 0, ringStep = 2 * Math.PI * p.fxring[0] / sr;
    const drive = p.fxdrive[0], phone = p.fxphone[0] > 0.5;
    const tremDepth = p.fxtrem[0] > 0 ? p.fxtremdepth[0] : 0, tremStep = 2 * Math.PI * p.fxtrem[0] / sr;
    const echoMix = p.fxecho[0] > 0 ? p.fxechomix[0] : 0, echoFb = Math.min(p.fxechofb[0], 0.85);
    const echoLen = Math.max(1, Math.min(32000, Math.round(p.fxecho[0] * 0.001 * sr)));
    const muffle = p.fxlp[0] > 0 ? 1 - Math.exp(-2 * Math.PI * p.fxlp[0] / sr) : 0;
    const hpA = 1 - Math.exp(-2 * Math.PI * 420 / sr), lpA2 = 1 - Math.exp(-2 * Math.PI * 3200 / sr);
    const fxOn = ringMix > 0 || drive > 0 || phone || tremDepth > 0 || echoMix > 0 || muffle > 0;
    const loA = 1 - Math.exp(-2 * Math.PI * 100 / sr), loRel = Math.exp(-1 / (0.06 * sr)), popThr = 0.04;
    const envRel = Math.exp(-1 / (0.05 * sr));
    const gAtt = 1 - Math.exp(-1 / (0.002 * sr)), gRel = 1 - Math.exp(-1 / (0.12 * sr));
    const holdN = 0.18 * sr, floor = 0.03;
    const speech = Math.max(thr, 0.01);            // only level-ride on actual speech
    const rmsA = 1 - Math.exp(-1 / (0.4 * sr)), agA = 1 - Math.exp(-1 / (1.5 * sr));
    const lpA = 1 - Math.exp(-2 * Math.PI * 5200 / sr);
    const hiRel = Math.exp(-1 / (0.03 * sr)), deThr = 0.02;

    for (let n = 0; n < input.length; n++) {
      let x = input[n];
      if (shifting) x = this.shift(x, ratio, formant);
      const a = Math.abs(x);
      this.env = Math.max(a, this.env * envRel);

      // A downward expander, as in the module: just under the threshold is only a little quieter.
      let tg = 1;
      if (this.env >= thr) this.hold = holdN;
      else if (this.hold > 0) this.hold--;
      else { const r = this.env / thr; tg = Math.max(floor, r * r * r); }
      this.g += (tg - this.g) * (tg > this.g ? gAtt : gRel);

      // Auto-level: ride slowly towards -20 dBFS RMS so a quiet mic still sounds full.
      if (auto) {
        if (this.env > speech) {
          this.rms += (x * x - this.rms) * rmsA;
          let want = 0.1 / (Math.sqrt(this.rms) + 1e-6);
          want = want < 0.5 ? 0.5 : want > 6 ? 6 : want;
          this.ag += (want - this.ag) * agA;
        }
      } else {
        this.ag += (1 - this.ag) * agA;
      }
      x *= this.g * this.ag;

      // De-plosive: a burst below ~100 Hz is breath on the capsule, not speech — duck that band while it lasts.
      this.lo += (x - this.lo) * loA;
      this.envLo = Math.max(Math.abs(this.lo), this.envLo * loRel);
      const tp = pop > 0 && this.envLo > popThr ? Math.pow(popThr / this.envLo, pop * 0.9) : 1;
      this.pg += (tp - this.pg) * (tp < this.pg ? 0.05 : 0.004);
      x = x - this.lo + this.lo * this.pg;

      // De-esser: split at ~5 kHz and duck only the top band when sibilance spikes.
      this.lp += (x - this.lp) * lpA;
      const hi = x - this.lp;
      this.envHi = Math.max(Math.abs(hi), this.envHi * hiRel);
      const td = de > 0 && this.envHi > deThr ? Math.pow(deThr / this.envHi, de * 0.75) : 1;
      this.dg += (td - this.dg) * 0.02;
      let y = this.lp + hi * this.dg;
      if (fxOn) {
        if (drive > 0) y = Math.tanh(y * (1 + drive * 24)) / (1 + drive * 6);
        if (phone) {
          this.f1 += (y - this.f1) * hpA;            // what is below 420 Hz…
          this.f2 += (y - this.f1 - this.f2) * lpA2; // …removed, then everything above 3.2 kHz
          y = this.f2 * 1.6;
        }
        if (muffle > 0) y = this.uw += (y - this.uw) * muffle;
        if (ringMix > 0) y = y * (1 - ringMix) + y * Math.sin((this.rp += ringStep)) * ringMix * 1.4;
        if (tremDepth > 0) y *= 1 - tremDepth * (0.5 + 0.5 * Math.sin((this.tp += tremStep)));
        const delayed = this.eb[(this.ep - echoLen) & 32767];
        this.eb[this.ep] = y + delayed * echoFb;
        this.ep = (this.ep + 1) & 32767;
        y += delayed * echoMix;
      }
      out[n] = y;
    }
    return true;
  }
}
registerProcessor('voice-dynamics', VoiceDynamics);
`;

const dbToGain = (db) => Math.pow(10, db / 20);
const gainToDb = (g) => 20 * Math.log10(Math.max(g, 1e-6));

class Engine {
  constructor() {
    this.ctx = null;
    this.n = null;
    this.stream = null;
    this.micSrc = null;
    this.sampleBuf = null;
    this.sampleSrc = null;
    this.monitor = false;
    this.audio = new Audio();
    this._time = new Float32Array(1024);
    this._freq = new Uint8Array(512);
  }

  get running() { return !!this.ctx; }
  get sampleMode() { return !!this.sampleSrc; }

  // `system`: the voice is already processed inside the microphone by the APO module,
  // so nothing is sent to a virtual cable — the graph only meters and monitors.
  async start(state, { test = false, system = false } = {}) {
    this.system = system;
    this._sink = undefined;
    const c = (this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 }));
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
    await c.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this._build();
    this.apply(state, true);

    if (test) {
      const osc = c.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 150;
      const g = c.createGain();
      g.gain.value = 0.2;
      osc.connect(g);
      osc.start();
      this.micSrc = g;
      g.connect(this.n.inGain);
    } else {
      await this.openMic(state);
    }
    // In system mode the context's own output is the monitor path (see _route): low latency, no <audio> element.
    if (system) this._route();
    else await this.setOutput(test ? null : state.outputId || null);
    this.audio.srcObject = this.n.msDest.stream;
    await this.setMonitorDevice(state.monitorId);
    this.audio.play().catch(() => {});
    if (c.state !== 'running') await c.resume();
  }

  async stop() {
    this.stopSample();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.micSrc = null;
    this.audio.pause();
    this.audio.srcObject = null;
    const c = this.ctx;
    this.ctx = null;
    this.n = null;
    if (c) await c.close();
  }

  _build() {
    const c = this.ctx;
    const n = (this.n = {});
    const biquad = (type, freq, q = 0.707) => {
      const b = c.createBiquadFilter();
      b.type = type;
      b.frequency.value = freq;
      b.Q.value = q;
      return b;
    };
    const gain = (v = 1) => {
      const g = c.createGain();
      g.gain.value = v;
      return g;
    };
    const analyser = (smooth) => {
      const a = c.createAnalyser();
      a.fftSize = 1024;
      a.smoothingTimeConstant = smooth;
      return a;
    };

    n.inGain = gain();
    n.anIn = analyser(0.5);
    n.hpf = biquad('highpass', 85);
    n.mic = Array.from({ length: 6 }, () => biquad('peaking', 1000, 1)); // microphone profile, flat until one is chosen
    n.dyn = new AudioWorkletNode(c, 'voice-dynamics', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
    });

    // Tone
    n.mud = biquad('peaking', 300, 1.1);
    n.low = biquad('lowshelf', 150);
    n.pres = biquad('peaking', 3600, 0.9);
    n.air = biquad('highshelf', 10500);

    n.comp = c.createDynamicsCompressor();
    n.comp.knee.value = 10;
    n.comp.attack.value = 0.004;
    n.comp.release.value = 0.18;
    n.makeup = gain();

    // Exciter: harmonics generated from the top of the voice, blended back in.
    n.exIn = biquad('highpass', 3000);
    n.exShape = c.createWaveShaper();
    n.exShape.curve = Float32Array.from({ length: 2048 }, (_, i) => Math.tanh(((i / 2047) * 2 - 1) * 6));
    n.exShape.oversample = '2x';
    n.exOut = biquad('highpass', 3000);
    n.exGain = gain(0);
    n.tone = gain();

    // Doubler: two slowly drifting short delays, panned apart. Adds width without an audible echo.
    n.dl1 = c.createDelay(0.05);
    n.dl2 = c.createDelay(0.05);
    n.dl1.delayTime.value = 0.013;
    n.dl2.delayTime.value = 0.021;
    const drift = (hz, depth, target) => {
      const osc = c.createOscillator();
      osc.frequency.value = hz;
      const g = gain(depth);
      osc.connect(g).connect(target);
      osc.start();
    };
    drift(0.31, 0.0012, n.dl1.delayTime);
    drift(0.43, 0.0016, n.dl2.delayTime);
    // Sides only (left plus, right minus): folded to mono by a voice chat, the taps cancel exactly.
    n.side = gain(0.75);
    n.dl2inv = gain(-1);
    n.sideInv = gain(-1);
    n.sides = c.createChannelMerger(2);
    n.widthGain = gain(0);

    // Room
    n.revIn = biquad('highpass', 280);
    n.revLp = biquad('lowpass', 6500);
    n.conv = c.createConvolver();
    n.conv.buffer = this._impulse(1.1);
    n.revGain = gain(0);

    n.master = gain();
    n.limiter = c.createDynamicsCompressor();
    n.limiter.threshold.value = -6;
    n.limiter.knee.value = 0;
    n.limiter.ratio.value = 20;
    n.limiter.attack.value = 0.001;
    n.limiter.release.value = 0.06;
    n.outGain = gain();
    n.wet = gain(1);
    n.dry = gain(0);
    n.post = gain();
    n.anOut = analyser(0.82);
    n.mainOut = gain(1);
    n.monOut = gain(0);
    n.msDest = c.createMediaStreamDestination();

    n.inGain.connect(n.anIn);
    let head = n.inGain.connect(n.hpf);
    for (const band of n.mic) head = head.connect(band);
    head.connect(n.dyn).connect(n.mud).connect(n.low).connect(n.pres)
      .connect(n.air).connect(n.comp).connect(n.makeup).connect(n.tone);
    n.makeup.connect(n.exIn).connect(n.exShape).connect(n.exOut).connect(n.exGain).connect(n.tone);

    n.tone.connect(n.master);
    n.tone.connect(n.dl1).connect(n.side);
    n.tone.connect(n.dl2).connect(n.dl2inv).connect(n.side);
    n.side.connect(n.sides, 0, 0);
    n.side.connect(n.sideInv).connect(n.sides, 0, 1);
    n.sides.connect(n.widthGain);
    n.widthGain.connect(n.master);
    n.tone.connect(n.revIn).connect(n.revLp).connect(n.conv).connect(n.revGain).connect(n.master);

    n.master.connect(n.limiter).connect(n.outGain).connect(n.wet).connect(n.post);
    n.inGain.connect(n.dry).connect(n.post);
    n.post.connect(n.anOut);
    n.post.connect(n.mainOut).connect(c.destination);
    n.post.connect(n.monOut).connect(n.msDest);
  }

  _impulse(seconds) {
    const c = this.ctx;
    const len = Math.floor(seconds * c.sampleRate);
    const buf = c.createBuffer(2, len, c.sampleRate);
    const pre = Math.floor(0.012 * c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = pre; i < len; i++) {
        lp += (Math.random() * 2 - 1 - lp) * 0.35;
        d[i] = lp * Math.exp((-(i - pre) / c.sampleRate) * 5.5);
      }
    }
    return buf;
  }

  /** Push every user-facing setting into the graph. */
  apply(state, instant = false, fx = null) {
    if (fx) this.fx = fx; // remembered: callers that only change a device do not have to know about voices
    if (!this.n) return;
    const voice = this.fx || {};
    const n = this.n;
    const t = this.ctx.currentTime;
    const set = (param, value) => (instant ? param.setValueAtTime(value, t) : param.setTargetAtTime(value, t, 0.03));
    const v = Object.fromEntries(Object.entries({ ...state.v, clean: state.g.clean }).map(([k, x]) => [k, x / 100]));

    set(n.inGain.gain, dbToGain(state.inGain));
    set(n.outGain.gain, dbToGain(state.outGain));

    const mic = globalThis.micEq?.() || { hp: 85, bands: [] }; // the chosen microphone profile, resolved in app.js
    set(n.hpf.frequency, Math.max(40, Math.min(200, mic.hp || 85)));
    n.mic.forEach((node, i) => {
      const [f, g, q] = mic.bands[i] || [1000, 0, 1];
      node.type = q > 0 ? 'peaking' : f < 1000 ? 'lowshelf' : 'highshelf';
      node.frequency.setValueAtTime(f, t);
      node.Q.setValueAtTime(q > 0 ? q : 0.707, t);
      set(node.gain, g);
    });
    set(n.low.gain, v.warmth * 7.5 - 1);
    set(n.mud.gain, -v.warmth * 3.5);
    set(n.pres.gain, v.clarity * 6);
    set(n.air.gain, v.air * 9);
    set(n.exGain.gain, v.clarity * 0.22 + v.air * 0.12);

    const thr = -12 - 26 * v.density;
    const ratio = 2 + 5 * v.density;
    set(n.comp.threshold, thr);
    set(n.comp.ratio, ratio);
    // The browser's compressor adds its own make-up gain (~0.6 × the full-scale reduction);
    // take half of it back so "density" thickens the voice instead of just making it louder.
    const autoMakeup = 0.6 * -thr * (1 - 1 / ratio);
    set(n.makeup.gain, dbToGain(-autoMakeup * 0.5));

    set(n.widthGain.gain, v.width * 0.55);
    set(n.revGain.gain, Math.min(v.space + (voice.fxspace || 0) / 100, 1.6) * 0.45);

    const p = n.dyn.parameters;
    p.get('gate').setValueAtTime(v.clean > 0.01 ? -65 + v.clean * 40 : -100, t);
    p.get('deess').setValueAtTime(v.deess, t);
    p.get('auto').setValueAtTime(state.auto ? 1 : 0, t);
    p.get('pop').setValueAtTime(state.g.pop / 100, t);
    const semitones = Math.max(-14, Math.min(14, (state.v.pitch || 0) + (voice.fxpitch || 0)));
    p.get('pitch').setValueAtTime(semitones, t);
    // As in the module: "another person" voices keep the timbre (plus their own shift), the rest move it about half as far as the pitch.
    p.get('timbre').setValueAtTime(Math.max(-5, Math.min(5, voice.fxnatural ? voice.fxformant || 0 : 0.55 * semitones)), t);
    for (const [name, scale] of [['fxring', 1], ['fxringmix', 0.01], ['fxdrive', 0.01], ['fxphone', 1], ['fxtrem', 1], ['fxtremdepth', 0.01], ['fxecho', 1], ['fxechofb', 0.01], ['fxechomix', 0.01], ['fxlp', 1]]) {
      p.get(name).setValueAtTime((voice[name] || 0) * scale, t);
    }

    this.monitor = state.monitor;
    this.monitorId = state.monitorId || '';
    this._route();
  }

  _route() {
    if (!this.n) return;
    const t = this.ctx.currentTime;
    const listen = this.sampleMode || this.monitor;
    if (this.system) {
      // Nothing goes to a cable here, so the context plays straight into the headphones — the
      // shortest path the browser has — and is pointed at no device at all when nobody listens.
      this.n.mainOut.gain.setTargetAtTime(listen ? 1 : 0, t, 0.02);
      this.n.monOut.gain.setTargetAtTime(0, t, 0.02);
      const want = listen ? this.monitorId || '' : null;
      if (want !== this._sink) {
        this._sink = want;
        this.setOutput(want);
      }
      return;
    }
    // While a recorded sample loops, keep it out of the virtual cable — it is for the user's ears only.
    this.n.mainOut.gain.setTargetAtTime(this.sampleMode ? 0 : 1, t, 0.02);
    this.n.monOut.gain.setTargetAtTime(listen ? 1 : 0, t, 0.02);
  }

  /** Hold-to-compare: crossfade to the untouched microphone. */
  setBypass(on) {
    if (!this.n) return;
    const t = this.ctx.currentTime;
    this.n.wet.gain.setTargetAtTime(on ? 0 : 1, t, 0.015);
    this.n.dry.gain.setTargetAtTime(on ? 1 : 0, t, 0.015);
  }

  async openMic(state) {
    const constraints = (id) => ({
      audio: {
        deviceId: id ? { exact: id } : undefined,
        echoCancellation: false,
        autoGainControl: false,
        // In system mode the module's own neural denoiser does this for every program.
        noiseSuppression: state.g.ns > 0 && !this.system,
        channelCount: 1,
      },
    });
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints(state.inputId));
    } catch (err) {
      if (!state.inputId) throw err;
      stream = await navigator.mediaDevices.getUserMedia(constraints(null)); // saved mic is gone
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.micSrc?.disconnect();
    this.stream = stream;
    this.micSrc = this.ctx.createMediaStreamSource(stream);
    if (!this.sampleMode) this.micSrc.connect(this.n.inGain);
  }

  /** Where the processed voice goes (the virtual cable). No device → silent sink, never the speakers. */
  async setOutput(deviceId) {
    if (!this.ctx) return;
    try {
      await this.ctx.setSinkId(deviceId == null ? { type: 'none' } : deviceId); // '' is the system default
    } catch {
      await this.ctx.setSinkId({ type: 'none' });
    }
  }

  async setMonitorDevice(deviceId) {
    try {
      await this.audio.setSinkId(deviceId || '');
    } catch {
      await this.audio.setSinkId('');
    }
  }

  async recordSample(seconds, onTick) {
    const rec = new MediaRecorder(this.stream);
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((r) => (rec.onstop = r));
    rec.start();
    for (let s = seconds; s > 0; s--) {
      onTick?.(s);
      await new Promise((r) => setTimeout(r, 1000));
    }
    rec.stop();
    await done;
    const data = await new Blob(chunks, { type: rec.mimeType }).arrayBuffer();
    this.sampleBuf = await this.ctx.decodeAudioData(data);
  }

  playSample() {
    if (!this.sampleBuf || !this.n) return;
    this.micSrc?.disconnect();
    const s = this.ctx.createBufferSource();
    s.buffer = this.sampleBuf;
    s.loop = true;
    s.connect(this.n.inGain);
    s.start();
    this.sampleSrc = s;
    this._route();
  }

  stopSample() {
    if (!this.sampleSrc) return;
    this.sampleSrc.stop();
    this.sampleSrc.disconnect();
    this.sampleSrc = null;
    if (this.n) {
      this.micSrc?.connect(this.n.inGain);
      this._route();
    }
  }

  _level(an) {
    an.getFloatTimeDomainData(this._time);
    let sum = 0;
    for (let i = 0; i < this._time.length; i++) sum += this._time[i] * this._time[i];
    return gainToDb(Math.sqrt(sum / this._time.length));
  }

  meters() {
    if (!this.n) return null;
    this.n.anOut.getByteFrequencyData(this._freq);
    return {
      in: this._level(this.n.anIn),
      out: this._level(this.n.anOut),
      reduction: this.n.comp.reduction,
      spectrum: this._freq,
    };
  }
}
