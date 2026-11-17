// Neural voice conversion (RVC-style), off line: a recording in one voice comes out in another.
//
//   speech 48 kHz ─→ 16 kHz ─→ content encoder ─→ what is being said (50 frames a second, doubled to 100)
//                          └─→ pitch track (100 a second), moved by the chosen number of semitones
//   both ─→ the voice model ─→ the same words and melody in the model's voice ─→ 48 kHz
//
// The voice model is the user's own file. Two ONNX layouts are understood: the one RVC's own
// exporter writes (inputs phone / phone_lengths / pitch / pitchf / ds / rnd) and the one
// w-okada's voice changer writes (feats / p_len / pitch / pitchf / sid).
//
// No Electron here: `ort` is passed in, so the same code runs in the app's worker and in tests.

// Windowed-sinc resampler; cut-off just under the lower of the two Nyquist frequencies.
function resample(x, from, to) {
  if (from === to) return x;
  const ratio = to / from, n = Math.floor(x.length * ratio), y = new Float32Array(n);
  const cut = Math.min(1, ratio) * 0.94, half = Math.ceil(12 / cut);
  for (let i = 0; i < n; i++) {
    const at = i / ratio, i0 = Math.floor(at);
    let sum = 0, norm = 0;
    for (let k = i0 - half + 1; k <= i0 + half; k++) {
      if (k < 0 || k >= x.length) continue;
      const d = (at - k) * cut;
      const w = Math.abs(d) < 1e-9 ? 1 : (Math.sin(Math.PI * d) / (Math.PI * d)) * (0.5 + 0.5 * Math.cos((Math.PI * (at - k)) / half));
      sum += x[k] * w;
      norm += w;
    }
    y[i] = norm ? sum / norm : 0;
  }
  return y;
}

// Pitch at 100 frames a second from 16 kHz audio: normalised autocorrelation, then the two things
// a generator that follows the pitch exactly cannot forgive — single-frame jumps and octave slips
// — are cleaned up. 0 = unvoiced.
// One frame: Hz, 0 = unvoiced, -1 = its analysis window does not fit inside the audio.
function pitchAt(x16, t, top) {
  const W = 1024, at = t * 160 - W / 2;
  if (at < 0 || at + W + 330 >= x16.length) return -1;
  let e0 = 1e-12;
  for (let i = 0; i < W; i += 2) e0 += x16[at + i] * x16[at + i];
  if (Math.sqrt(e0 / (W / 2)) < top * 0.02) return 0;
  let best = 0, lag0 = 0;
  for (let lag = 32; lag <= 320; lag++) { // 500 … 50 Hz
    let c = 0, e1 = 1e-12;
    for (let i = 0; i < W; i += 2) { c += x16[at + i] * x16[at + i + lag]; e1 += x16[at + i + lag] * x16[at + i + lag]; }
    const s = c / Math.sqrt(e0 * e1);
    if (s > best * 1.04) { best = s; lag0 = lag; } // of near-equal peaks the shortest lag: the true period, not its double
  }
  return best > 0.5 && lag0 ? 16000 / lag0 : 0;
}
function pitchTrack(x16, frames) {
  const f0 = new Float32Array(frames);
  let top = 1e-9;
  for (let i = 0; i < x16.length; i += 37) top = Math.max(top, Math.abs(x16[i]));
  for (let t = 0; t < frames; t++) f0[t] = Math.max(0, pitchAt(x16, t, top));
  // Octave slips against the local median, then a 5-frame median.
  const voiced = Array.from(f0).filter((v) => v > 0).sort((a, b) => a - b);
  const mid = voiced.length ? voiced[voiced.length >> 1] : 0;
  for (let t = 0; t < frames; t++) {
    if (!f0[t] || !mid) continue;
    while (f0[t] > mid * 1.9) f0[t] /= 2;
    while (f0[t] < mid / 1.9) f0[t] *= 2;
  }
  const out = new Float32Array(frames);
  for (let t = 0; t < frames; t++) {
    const w = [];
    for (let k = -2; k <= 2; k++) if (f0[t + k] > 0) w.push(f0[t + k]);
    out[t] = f0[t] > 0 && w.length >= 3 ? w.sort((a, b) => a - b)[w.length >> 1] : w.length >= 4 ? w.sort((a, b) => a - b)[w.length >> 1] : 0; // also bridges one-frame holes
  }
  return out;
}

// RVC's coarse pitch: the mel scale between 50 and 1100 Hz cut into bins 1…255; 1 = unvoiced.
function coarsePitch(f0) {
  const lo = 1127 * Math.log(1 + 50 / 700), hi = 1127 * Math.log(1 + 1100 / 700);
  const out = new BigInt64Array(f0.length);
  for (let i = 0; i < f0.length; i++) {
    let mel = 1127 * Math.log(1 + f0[i] / 700);
    if (mel > 0) mel = ((mel - lo) * 254) / (hi - lo) + 1;
    out[i] = BigInt(Math.round(Math.min(255, Math.max(1, mel))));
  }
  return out;
}

const toHalf = (() => { // float32 → IEEE half, for voice models exported in half precision
  const f = new Float32Array(1), u = new Uint32Array(f.buffer);
  return (v) => {
    f[0] = v;
    const x = u[0], sign = (x >> 16) & 0x8000, exp = ((x >> 23) & 0xff) - 112, frac = x & 0x7fffff;
    if (exp <= 0) return sign;
    if (exp >= 31) return sign | 0x7c00;
    return sign | (exp << 10) | (frac >> 13);
  };
})();
const fromHalf = (h) => {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
  return e === 0 ? s * f * Math.pow(2, -24) : e === 31 ? 0 : s * (1 + f / 1024) * Math.pow(2, e - 15);
};
function gauss(n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const a = Math.sqrt(-2 * Math.log(1 - Math.random())), b = 2 * Math.PI * Math.random();
    out[i] = a * Math.cos(b);
    if (i + 1 < n) out[i + 1] = a * Math.sin(b);
  }
  return out;
}

// What the two parts need to run, in one place: loaded once, reused.
async function load(ort, encoderPath, voicePath, gpu = true) {
  const providers = gpu ? [{ name: 'dml', deviceId: 0 }, 'cpu'] : ['cpu'];
  const open = async (file) => {
    try {
      return await ort.InferenceSession.create(file, { executionProviders: providers, graphOptimizationLevel: 'all', logSeverityLevel: 3 });
    } catch (e) {
      if (!gpu) throw e;
      return ort.InferenceSession.create(file, { executionProviders: ['cpu'], graphOptimizationLevel: 'all', logSeverityLevel: 3 }); // the graphics card refused it
    }
  };
  const encoder = await open(encoderPath);
  const voice = voicePath ? await open(voicePath) : null;
  return { ort, encoder, voice };
}

// Looks at a voice model without running it: which layout, and whether this code can drive it.
function describeVoice(session) {
  const names = session.inputNames;
  const official = names.includes('phone'), okada = names.includes('feats');
  const meta = (name) => { try { return (session.inputMetadata || []).find((m) => m.name === name); } catch { return null; } };
  const feats = meta(official ? 'phone' : 'feats');
  const dim = feats && Array.isArray(feats.shape) ? Number(feats.shape[feats.shape.length - 1]) : 0;
  return {
    ok: official || okada,
    layout: official ? 'rvc' : okada ? 'w-okada' : 'unknown',
    pitched: names.includes('pitchf'),
    half: !!feats && feats.type === 'float16',
    dim: dim === 256 || dim === 768 ? dim : 0,
    inputs: names,
  };
}

// The voice model is always run on stretches of exactly two seconds (200 frames). Models written
// by RVC's own exporter accept no other length — the length they were traced with is fixed in
// them — and for the others it costs nothing; a live mode works in such stretches anyway.
const FRAMES = 200;
const WINDOW16 = 400 + (FRAMES / 2 - 1) * 320; // 16 kHz samples that give the encoder exactly FRAMES / 2 frames

// One two-second stretch → { audio, rate }. `f0` is its pitch track (FRAMES values, already shifted).
async function convertWindow(ctx, x16, f0, speaker, noise = null) {
  const { ort, encoder, voice } = ctx;
  const enc = await encoder.run({ [encoder.inputNames[0]]: new ort.Tensor('float32', x16, [1, 1, x16.length]) });
  const emb = enc[encoder.outputNames[0]]; // [1, T0, C] at 50 a second
  const T0 = emb.dims[1], C = emb.dims[2], T = FRAMES;
  const info = ctx.info || (ctx.info = describeVoice(voice));
  if (!info.ok) throw new Error('unsupported voice model');
  if (info.dim && info.dim !== C) throw new Error(`voice model wants ${info.dim}-dimensional features, the encoder gives ${C}`);
  const feats = new Float32Array(T * C); // every frame twice: the voice model runs at 100 a second
  for (let t = 0; t < T; t++) {
    const from = Math.min(T0 - 1, t >> 1);
    feats.set(emb.data.subarray(from * C, (from + 1) * C), t * C);
  }
  const len = new ort.Tensor('int64', BigInt64Array.from([BigInt(T)]), [1]);
  const who = new ort.Tensor('int64', BigInt64Array.from([BigInt(speaker)]), [1]);
  const featTensor = info.half ? new ort.Tensor('float16', Uint16Array.from(feats, toHalf), [1, T, C]) : new ort.Tensor('float32', feats, [1, T, C]);
  const feed = info.layout === 'rvc'
    ? { phone: featTensor, phone_lengths: len, ds: who, rnd: new ort.Tensor('float32', noise || gauss(192 * T), [1, 192, T]) }
    : { feats: featTensor, p_len: len, sid: who };
  if (info.pitched) {
    feed.pitch = new ort.Tensor('int64', coarsePitch(f0), [1, T]);
    feed.pitchf = new ort.Tensor('float32', f0, [1, T]);
  }
  for (const name of Object.keys(feed)) if (!voice.inputNames.includes(name)) delete feed[name];
  const out = (await voice.run(feed))[voice.outputNames[0]];
  const audio = out.type === 'float16' ? Float32Array.from(out.data, fromHalf) : Float32Array.from(out.data);
  // The model's sample rate shows in how much audio it made for T frames of 10 ms.
  const per = audio.length / T;
  const rate = [32000, 40000, 44100, 48000].reduce((p, q) => (Math.abs(q / 100 - per) < Math.abs(p / 100 - per) ? q : p));
  return { audio, rate };
}

// A whole recording (mono, 48 kHz). Two-second stretches, each starting 1.6 s after the last,
// cross-faded over the 0.4 s they share. The pitch is tracked once over the whole recording, so
// its octave correction sees all of the voice, not two seconds of it.
async function convert(ctx, mono48, st = 0, onProgress = () => {}, speaker = 0) {
  const x16 = resample(mono48, 48000, 16000);
  const total = Math.ceil(x16.length / 160);
  const f0 = pitchTrack(x16, total);
  const k = Math.pow(2, st / 12);
  for (let i = 0; i < total; i++) f0[i] *= k;
  const hop = 160, overlap = (FRAMES - hop) * 480; // frames; 48 kHz samples
  const out = new Float32Array(mono48.length);
  for (let frame = 0, first = true; frame < total; frame += hop, first = false) {
    const seg = new Float32Array(WINDOW16);
    seg.set(x16.subarray(frame * 160, frame * 160 + WINDOW16));
    const pitch = new Float32Array(FRAMES);
    pitch.set(f0.subarray(frame, frame + FRAMES));
    const { audio, rate } = await convertWindow(ctx, seg, pitch, speaker);
    const y = resample(audio, rate, 48000);
    const dst = frame * 480, last = frame + hop >= total;
    for (let i = 0; i < y.length && dst + i < out.length; i++) {
      let w = 1;
      if (!first && i < overlap) w = i / overlap;
      if (!last && i >= y.length - overlap) w = (y.length - i) / overlap;
      out[dst + i] += y[i] * w;
    }
    onProgress(Math.min(1, (frame + hop) / total));
  }
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0.98) for (let i = 0; i < out.length; i++) out[i] *= 0.98 / peak;
  return out;
}

module.exports = { gauss, resample, pitchAt, pitchTrack, coarsePitch, load, describeVoice, convertWindow, convert, FRAMES, WINDOW16 };
