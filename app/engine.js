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
      { name: 'pitch', defaultValue: 0,    minValue: -12,  maxValue: 12, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.env = 0; this.open = false; this.hold = 0; this.g = 1;   // gate
    this.rms = 0.01; this.ag = 1;                                  // auto-level
    this.lp = 0; this.envHi = 0; this.dg = 1;                      // de-esser
    this.lo = 0; this.envLo = 0; this.pg = 1;                      // de-plosive
    this.pb = new Float32Array(4096); this.pp = 0; this.ph = 0;    // pitch shifter
  }
  tap(delay) {
    let at = this.pp - delay;
    if (at < 0) at += 4096;
    const i = at | 0, f = at - i;
    return this.pb[i & 4095] * (1 - f) + this.pb[(i + 1) & 4095] * f;
  }
  process(inputs, outputs, p) {
    const input = inputs[0][0], out = outputs[0][0];
    if (!input) return true;
    const sr = sampleRate;
    const thr = Math.pow(10, p.gate[0] / 20), thrClose = thr * 0.63; // 4 dB of hysteresis
    const de = p.deess[0], auto = p.auto[0] > 0.5, pop = p.pop[0];
    const ratio = Math.abs(p.pitch[0]) < 0.01 ? 1 : Math.pow(2, p.pitch[0] / 12), win = 0.045 * sr;
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
      if (ratio !== 1) {
        // Two taps sweep a short delay line and cross-fade where one has to jump back.
        this.pb[this.pp] = x;
        this.ph += (1 - ratio) / win;
        if (this.ph >= 1) this.ph -= 1;
        if (this.ph < 0) this.ph += 1;
        const other = this.ph >= 0.5 ? this.ph - 0.5 : this.ph + 0.5;
        const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * this.ph);
        x = this.tap(2 + this.ph * win) * w + this.tap(2 + other * win) * (1 - w);
        this.pp = (this.pp + 1) & 4095;
      }
      const a = Math.abs(x);
      this.env = Math.max(a, this.env * envRel);

      // Gate: open fast, hold through pauses between words, close softly to a floor.
      if (this.env > thr) { this.open = true; this.hold = holdN; }
      else if (this.env < thrClose) { if (this.hold > 0) this.hold--; else this.open = false; }
      const tg = this.open ? 1 : floor;
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
      out[n] = this.lp + hi * this.dg;
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
    n.panL = c.createStereoPanner();
    n.panR = c.createStereoPanner();
    n.panL.pan.value = -0.9;
    n.panR.pan.value = 0.9;
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
    n.inGain.connect(n.hpf).connect(n.dyn).connect(n.mud).connect(n.low).connect(n.pres)
      .connect(n.air).connect(n.comp).connect(n.makeup).connect(n.tone);
    n.makeup.connect(n.exIn).connect(n.exShape).connect(n.exOut).connect(n.exGain).connect(n.tone);

    n.tone.connect(n.master);
    n.tone.connect(n.dl1).connect(n.panL).connect(n.widthGain);
    n.tone.connect(n.dl2).connect(n.panR).connect(n.widthGain);
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
  apply(state, instant = false) {
    if (!this.n) return;
    const n = this.n;
    const t = this.ctx.currentTime;
    const set = (param, value) => (instant ? param.setValueAtTime(value, t) : param.setTargetAtTime(value, t, 0.03));
    const v = Object.fromEntries(Object.entries({ ...state.v, clean: state.g.clean }).map(([k, x]) => [k, x / 100]));

    set(n.inGain.gain, dbToGain(state.inGain));
    set(n.outGain.gain, dbToGain(state.outGain));

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
    set(n.revGain.gain, v.space * 0.45);

    const p = n.dyn.parameters;
    p.get('gate').setValueAtTime(v.clean > 0.01 ? -65 + v.clean * 40 : -100, t);
    p.get('deess').setValueAtTime(v.deess, t);
    p.get('auto').setValueAtTime(state.auto ? 1 : 0, t);
    p.get('pop').setValueAtTime(state.g.pop / 100, t);
    p.get('pitch').setValueAtTime(state.v.pitch || 0, t);

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
