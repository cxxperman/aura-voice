/* «Пати через Discord», вариант «В моём браузере»: сайт открыт в браузере человека, где подменить микрофон нельзя.
 * Поэтому главное окно Aura само играет «голос + звук Discord» в устройство воспроизведения виртуального кабеля
 * (у VB-Cable — «CABLE Input»), а браузер берёт микрофоном его вторую сторону («CABLE Output»). Discord остаётся
 * на настоящем микрофоне — звонок в него не возвращается, эха нет. Откуда брать голос, решает app.js.
 * Звук Discord приходит из main.js кусками (mono float32, 48 кГц, канал party:cable-pcm). */

// Буфер против рывков — тот же, что в party-preload.js (там он живёт внутри страницы сайта и общий файл не подключить):
// запас 40 мс; отстали больше чем на 250 мс — перескок к свежему (задержка не копится); кончились куски — короткое
// затухание вместо щелчка, потом плавный вход.
const CABLE_WORKLET = `
class AuraCableFeed extends AudioWorkletProcessor {
  constructor() {
    super();
    this.N = 48000; this.buf = new Float32Array(this.N); this.w = 0; this.r = 0; this.n = 0;
    this.play = false; this.g = 0; this.last = 0;
    this.port.onmessage = (e) => {
      const x = e.data, N = this.N;
      for (let i = 0; i < x.length; i++) { this.buf[this.w] = x[i]; this.w = (this.w + 1) % N; }
      this.n = Math.min(N, this.n + x.length);
      if (this.n > 12000) { this.r = (this.w - 2880 + N) % N; this.n = 2880; }
    };
  }
  process(_in, outputs) {
    const out = outputs[0][0], N = this.N;
    if (!this.play && this.n >= 1920) this.play = true;
    for (let i = 0; i < out.length; i++) {
      if (this.play && this.n > 0) {
        if (this.g < 1) this.g = Math.min(1, this.g + 1 / 128);
        this.last = this.buf[this.r] * this.g;
        this.r = (this.r + 1) % N; this.n--;
      } else {
        this.play = false; this.g = 0;
        this.last *= 0.97;
      }
      out[i] = this.last;
    }
    return true;
  }
}
registerProcessor('aura-cable-feed', AuraCableFeed);
`;
const cableWorkletLoaded = new WeakSet();

// Кусок от main.js — в свой Float32Array (его буфер можно передать ворклету без копии).
function cablePcm(pcm) {
  if (pcm instanceof ArrayBuffer) return new Float32Array(pcm, 0, pcm.byteLength >> 2);
  if (ArrayBuffer.isView(pcm)) return new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + (pcm.byteLength & ~3)));
  return null;
}

/* Сам граф: голос (MediaStream или ничего) и звук Discord складываются в моно и идут в `out` — в destination
 * контекста или, в проверке, в MediaStreamDestination. Возвращает push(pcm) для кусков Discord и stop(). */
async function buildCableGraph(ctx, { voice = null, out }) {
  if (!cableWorkletLoaded.has(ctx)) {
    const url = URL.createObjectURL(new Blob([CABLE_WORKLET], { type: 'application/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    cableWorkletLoaded.add(ctx);
  }
  const sum = ctx.createGain(); // стерео голоса движка сводится в моно: «ширина» (только боковые) при этом уходит, как в любом голосовом чате
  sum.channelCount = 1;
  sum.channelCountMode = 'explicit';
  sum.channelInterpretation = 'speakers';
  const feed = new AudioWorkletNode(ctx, 'aura-cable-feed', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
  feed.connect(sum);
  const src = voice ? ctx.createMediaStreamSource(voice) : null;
  src?.connect(sum);
  sum.connect(out);
  let stopped = false;
  return {
    push(pcm) {
      const x = stopped ? null : cablePcm(pcm);
      if (x && x.length) feed.port.postMessage(x, [x.buffer]);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const node of [src, feed, sum]) {
        try { node?.disconnect(); } catch {}
      }
      feed.port.close();
    },
  };
}

/* Смесь, играющая в кабель. Сначала — устройство, потом граф: пока setSinkId не прошёл, ничего не подключено,
 * и голос со звонком не попадёт в колонки. Устройство не открылось — start бросает, всё уже освобождено.
 * own: голос — свой микрофон этой смеси, его дорожки останавливаются вместе с ней. */
class CableMix {
  constructor() {
    this.ctx = null;
    this.graph = null;
    this.voice = null;
    this.own = false;
    this.onchange = null; // контекст заработал, приостановлен или закрыт
  }

  get playing() {
    return !!this.graph && this.ctx?.state === 'running';
  }

  async start({ voice = null, own = false, sinkId }) {
    this.voice = voice;
    this.own = own;
    const ctx = (this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive', sinkId: { type: 'none' } }));
    ctx.onstatechange = () => this.onchange?.();
    try {
      await ctx.setSinkId(sinkId);
      this.graph = await buildCableGraph(ctx, { voice, out: ctx.destination });
      if (ctx.state !== 'running') await ctx.resume();
    } catch (e) {
      await this.stop();
      throw e;
    }
    this.onchange?.();
  }

  push(pcm) {
    if (this.playing) this.graph.push(pcm);
  }

  async stop() {
    const ctx = this.ctx;
    this.ctx = null;
    this.graph?.stop();
    this.graph = null;
    if (this.own) this.voice?.getTracks().forEach((t) => t.stop());
    this.voice = null;
    if (ctx) {
      ctx.onstatechange = null;
      await ctx.close().catch(() => {});
    }
  }
}
