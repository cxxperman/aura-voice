// The AI voice, live. The module inside the microphone and this process share a file,
// %ProgramData%\Aura\live.bin, that the module maps into memory:
//
//   header (64 bytes): magic "AURL", capW, playW  — running counts of samples written
//   cap[131072]   float32, 48 kHz mono: the voice as the module's own chain made it  (module → here)
//   play[131072]  float32, 48 kHz mono: the converted voice                          (here → module)
//
// Every 0.24 s the last two seconds of voice are converted, and the newest 0.24 s of the result —
// taken a little short of the very end, where the network has no future to lean on — is handed
// back. Consecutive pieces come from separate runs of the network, so their waveforms do not line
// up; each new piece is slid by up to 16 ms to where it best matches the tail of the previous one
// and cross-faded over 30 ms (SOLA).
const fs = require('fs');

const MAGIC = 0x4c525541;
const N = 1 << 17;
const HEADER = 64;
const SIZE = HEADER + 2 * N * 4;
const HOP = 11520, FADE = 1440, SEARCH = 768; // 48 kHz samples: 0.24 s, 30 ms, 16 ms (longer than a period of the lowest voice)
const STEP = HOP / 480; // the same hop in 10 ms frames
const EDGE = 0.06; // seconds kept back from the end of each two-second window

// Makes sure the shared file exists with the right size and magic. The module only ever opens it.
function prepare(file) {
  let ok = false;
  try {
    ok = fs.statSync(file).size === SIZE;
  } catch {}
  if (!ok) fs.writeFileSync(file, Buffer.alloc(SIZE));
  const fd = fs.openSync(file, 'r+');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(MAGIC, 0);
  fs.writeSync(fd, head, 0, 4, 0);
  return fd;
}

class Live {
  constructor(ai, ctx, file, { st = 0, speaker = 0 } = {}, report = () => {}) {
    this.ai = ai;
    this.ctx = ctx;
    this.fd = prepare(file);
    this.st = st;
    this.speaker = speaker;
    this.report = report;
    this.mic = new Float32Array(ai.WINDOW16 * 3); // the last two seconds of the microphone, 48 kHz
    this.f0 = new Float32Array(ai.FRAMES);
    this.tail = null; // what followed the last piece handed back: the next one is matched to it
    // The network adds random detail. Fresh randomness on every run would make two runs disagree
    // about the same moment of sound; so the randomness belongs to the moment and moves with it.
    this.noise = ai.gauss(192 * ai.FRAMES);
    this.fresh = 0;
    this.busy = false;
    this.stats = { runs: 0, ms: 0, worst: 0, late: 0 };
    const head = Buffer.alloc(12);
    fs.readSync(this.fd, head, 0, 12, 0);
    this.capR = head.readUInt32LE(4); // start from now: what is already in the ring is old
    this.playW = head.readUInt32LE(8);
    this.timer = setInterval(() => this.tick(), 10);
  }

  stop() {
    clearInterval(this.timer);
    try { fs.closeSync(this.fd); } catch {}
  }

  ring(offset, from, count) { // reads `count` floats starting at ring position `from`
    const buf = Buffer.alloc(count * 4);
    const at = from & (N - 1), first = Math.min(count, N - at);
    fs.readSync(this.fd, buf, 0, first * 4, offset + at * 4);
    if (first < count) fs.readSync(this.fd, buf, first * 4, (count - first) * 4, offset);
    return new Float32Array(buf.buffer, buf.byteOffset, count);
  }

  tick() {
    const head = Buffer.alloc(8);
    fs.readSync(this.fd, head, 0, 8, 0);
    if (head.readUInt32LE(0) !== MAGIC) return;
    const capW = head.readUInt32LE(4);
    let n = (capW - this.capR) >>> 0;
    if (!n) return;
    if (n > this.mic.length) { this.capR = (capW - this.mic.length) >>> 0; n = this.mic.length; } // fell far behind: only the newest matters
    const got = this.ring(HEADER, this.capR, n);
    this.capR = capW;
    this.mic.copyWithin(0, n);
    this.mic.set(got, this.mic.length - n);
    this.fresh += n;
    if (this.busy || this.fresh < HOP) return;
    if (this.fresh >= 2 * HOP) { this.stats.late++; this.fresh = HOP; } // a run took longer than a hop: skip, do not queue up
    this.fresh -= HOP;
    this.busy = true;
    this.step().catch((e) => this.report({ error: String(e?.message || e).slice(0, 200) })).finally(() => (this.busy = false));
  }

  async step() {
    const { ai } = this, t0 = Date.now();
    const x16 = ai.resample(this.mic, 48000, 16000);
    // Pitch: the window moved STEP frames on; those and four more are (re)measured — the four newest cannot be
    // yet (their analysis window reaches past "now") and repeat the last one that can.
    this.f0.copyWithin(0, STEP);
    let top = 1e-9;
    for (let i = 0; i < x16.length; i += 37) top = Math.max(top, Math.abs(x16[i]));
    const voiced = Array.from(this.f0.subarray(0, ai.FRAMES - STEP - 4)).filter((v) => v > 0).sort((a, b) => a - b);
    const mid = voiced.length > 10 ? voiced[voiced.length >> 1] : 0;
    let last = 0;
    for (let t = ai.FRAMES - STEP - 4; t < ai.FRAMES; t++) {
      let f = ai.pitchAt(x16, t, top);
      if (f < 0) f = last; // not measurable yet
      if (f > 0 && mid) { while (f > mid * 1.9) f /= 2; while (f < mid / 1.9) f *= 2; } // octave slips against the last two seconds
      this.f0[t] = last = f;
    }
    const k = Math.pow(2, this.st / 12);
    const T = ai.FRAMES, fresh = ai.gauss(192 * STEP);
    for (let c = 0; c < 192; c++) {
      this.noise.copyWithin(c * T, c * T + STEP, (c + 1) * T);
      this.noise.set(fresh.subarray(c * STEP, (c + 1) * STEP), c * T + T - STEP);
    }
    const { audio, rate } = await ai.convertWindow(this.ctx, x16, this.f0.map((f) => f * k), this.speaker, this.noise.slice());
    const end = Math.round((ai.FRAMES / 100 - EDGE) * rate);
    const need = HOP + FADE + SEARCH;
    const piece = ai.resample(audio.subarray(end - Math.round((need / 48000) * rate), end), rate, 48000);
    const y = new Float32Array(need);
    y.set(piece.subarray(0, need));
    // SOLA: where does the new piece continue the old one best?
    let shift = 0;
    if (this.tail) {
      let best = -Infinity;
      const match = (s) => {
        let c = 0, e = 1e-9;
        for (let i = 0; i < FADE; i += 3) { c += this.tail[i] * y[s + i]; e += y[s + i] * y[s + i]; }
        return c / Math.sqrt(e);
      };
      for (let s = 0; s <= SEARCH; s += 4) { const score = match(s); if (score > best) { best = score; shift = s; } } // coarse
      for (let s = Math.max(0, shift - 3), to = Math.min(SEARCH, shift + 3); s <= to; s++) { const score = match(s); if (score > best) { best = score; shift = s; } } // to the sample
    }
    const out = new Float32Array(HOP);
    for (let i = 0; i < HOP; i++) {
      const v = y[shift + i];
      out[i] = this.tail && i < FADE ? this.tail[i] * (1 - i / FADE) + v * (i / FADE) : v;
    }
    this.tail = y.slice(shift + HOP, shift + HOP + FADE);
    // Hand it back: data first, then the count the module watches.
    const bytes = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
    const at = this.playW & (N - 1), first = Math.min(HOP, N - at);
    fs.writeSync(this.fd, bytes, 0, first * 4, HEADER + N * 4 + at * 4);
    if (first < HOP) fs.writeSync(this.fd, bytes, first * 4, (HOP - first) * 4, HEADER + N * 4);
    this.playW = (this.playW + HOP) >>> 0;
    const head = Buffer.alloc(4);
    head.writeUInt32LE(this.playW, 0);
    fs.writeSync(this.fd, head, 0, 4, 8);
    const ms = Date.now() - t0;
    const s = this.stats;
    s.runs++; s.ms += ms; s.worst = Math.max(s.worst, ms);
    if (s.runs % 5 === 0) { this.report({ live: { ms: Math.round(s.ms / s.runs), worst: s.worst, late: s.late } }); s.ms = s.runs = s.worst = 0; }
  }
}

module.exports = { Live, prepare, MAGIC, N, HEADER, SIZE, HOP };
