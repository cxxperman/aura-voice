// «Пати через Discord»: preload окна пати — есть у окна только в этом режиме (main.js, makePartyWin).
// Собеседник на сайте должен слышать звонок Discord, а сам Discord — только голос человека. Поэтому звук Discord
// не идёт в системный микрофон (его услышали бы все программы, и друзья — себя же, эхом), а смешивается здесь,
// внутри страницы: getUserMedia сайта получает дорожку «настоящий микрофон + звук Discord». Больше на странице
// ничего не меняется. Работает и во фреймах: main.js включает для окна nodeIntegrationInSubFrames.
'use strict';
const { contextBridge, ipcRenderer, webFrame } = require('electron');

let listener = null;
ipcRenderer.on('party:discord-pcm', (_e, pcm) => {
  if (!listener) return;
  // mono float32, 48 кГц, от AuraCapture.exe; в главный мир — массивом чисел, его мост копирует везде одинаково
  const view = pcm instanceof ArrayBuffer ? new Float32Array(pcm) : ArrayBuffer.isView(pcm) ? new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 2) : null;
  if (view && view.length) listener(view);
});
// Что видит код в главном мире — одну функцию: подписаться на звук Discord (fn) или отписаться (null).
const bridge = {
  listen(fn) {
    listener = typeof fn === 'function' ? fn : null;
    ipcRenderer.send(listener ? 'party:discord-want' : 'party:discord-unwant');
  },
};

// Выполняется в главном мире страницы, до её собственных скриптов. Ничего из внешнего контекста не видит — только bridge.
function inPage(bridge) {
  const MD = window.MediaDevices;
  if (!MD || typeof MD.prototype.getUserMedia !== 'function' || !window.AudioContext) return; // не https: микрофона и так нет
  const RATE = 48000;
  const realGetUserMedia = MD.prototype.getUserMedia;
  const T = MediaStreamTrack.prototype;
  const nativeStop = T.stop;
  const nativeClone = T.clone;

  // Буфер против рывков: звук приходит кусками по ~10 мс. Держится запас 40 мс; отстали больше чем на 250 мс —
  // перескок к свежему (задержка не копится); кончились куски — короткое затухание вместо щелчка, потом плавный вход.
  const WORKLET = `
class AuraDiscordFeed extends AudioWorkletProcessor {
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
registerProcessor('aura-discord-feed', AuraDiscordFeed);
`;

  let feed = null; // { ctx, out, push, users }
  function makeFeed() {
    const ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
    const out = ctx.createGain();
    const f = { ctx, out, users: 0, push: null };
    // Запасной путь, пока модуль AudioWorklet грузится или если строгий CSP сайта его не пускает: цепочка коротких буферов.
    let next = 0;
    f.push = (x) => {
      const now = ctx.currentTime;
      const ahead = next - now;
      if (ahead > 0.25) return; // куски пришли пачкой: этот пропускаем, чтобы задержка не росла
      if (ahead < 0.005) { // начало после паузы: запас 60 мс и мягкий вход
        next = now + 0.06;
        for (let i = 0, k = Math.min(128, x.length); i < k; i++) x[i] *= i / k;
      }
      const b = ctx.createBuffer(1, x.length, RATE);
      b.copyToChannel(x, 0);
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(out);
      s.start(next);
      next += x.length / RATE;
    };
    (async () => {
      if (!ctx.audioWorklet) return;
      const blob = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(blob);
      } catch {
        return; // CSP сайта не пускает blob: — остаётся цепочка буферов (data: такой CSP почти всегда тоже не пускает)
      } finally {
        URL.revokeObjectURL(blob);
      }
      const node = new AudioWorkletNode(ctx, 'aura-discord-feed', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
      node.connect(out);
      f.push = (x) => node.port.postMessage(x, [x.buffer]);
    })();
    return f;
  }
  const take = () => {
    if (!feed) feed = makeFeed();
    if (feed.users++ === 0) {
      feed.ctx.resume().catch(() => {});
      bridge.listen((pcm) => {
        if (feed && feed.ctx.state === 'running') feed.push(Float32Array.from(pcm));
      });
    }
    return feed;
  };
  const release = () => {
    if (!feed || --feed.users > 0) return;
    feed.users = 0;
    bridge.listen(null);
    feed.ctx.suspend().catch(() => {});
  };
  const own = (obj, name, value) => Object.defineProperty(obj, name, { value, configurable: true, writable: true });

  // Дорожка, которую получает сайт, выдаёт себя за микрофон: его имя, настройки и ограничения. Остановили её (и все
  // её копии) — останавливается и настоящий микрофон; пропал микрофон — заканчивается и она.
  function dress(track, mic, mics, holder) {
    holder.count++;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (--holder.count === 0) holder.end();
    };
    own(track, 'stop', function stop() {
      nativeStop.call(track);
      finish();
    });
    own(track, 'clone', function clone() {
      const copy = nativeClone.call(track);
      if (!done) dress(copy, mic, mics, holder);
      return copy;
    });
    Object.defineProperty(track, 'label', { get: () => mic.label, configurable: true });
    own(track, 'getSettings', function getSettings() { return mic.getSettings(); });
    own(track, 'getCapabilities', function getCapabilities() { return typeof mic.getCapabilities === 'function' ? mic.getCapabilities() : {}; });
    own(track, 'getConstraints', function getConstraints() { return mic.getConstraints(); });
    own(track, 'applyConstraints', function applyConstraints(c) { return mic.applyConstraints(c); });
    holder.tracks.push([track, finish]);
  }

  function mix(real, mics) {
    const f = take();
    const ctx = f.ctx;
    let src, dest;
    try {
      src = ctx.createMediaStreamSource(new MediaStream(mics));
      dest = ctx.createMediaStreamDestination();
      dest.channelCount = 1;
      src.connect(dest);
      f.out.connect(dest);
    } catch (e) {
      release();
      throw e;
    }
    const track = dest.stream.getAudioTracks()[0];
    const holder = {
      count: 0,
      tracks: [],
      end() {
        try { src.disconnect(); } catch {}
        try { f.out.disconnect(dest); } catch {}
        for (const m of mics) m.stop();
        release();
      },
    };
    dress(track, mics[0], mics, holder);
    mics[0].addEventListener('ended', () => {
      for (const [t, finish] of holder.tracks) {
        if (t.readyState === 'ended') continue;
        nativeStop.call(t);
        finish();
        t.dispatchEvent(new Event('ended'));
      }
    });
    return new MediaStream([track, ...real.getVideoTracks()]);
  }

  const wantsAudio = (c) => !!c && typeof c === 'object' && !!c.audio;
  const getUserMedia = {
    async getUserMedia(constraints) {
      const real = await realGetUserMedia.call(this, constraints); // настоящий запрос: разрешение, deviceId, ошибки — как есть
      const mics = wantsAudio(constraints) ? real.getAudioTracks() : [];
      if (!mics.length) return real;
      try {
        return mix(real, mics);
      } catch {
        return real; // смешать не вышло — пусть сайт слышит хотя бы голос
      }
    },
  }.getUserMedia;
  own(MD.prototype, 'getUserMedia', getUserMedia);
  // Старый вид с колбэками
  for (const name of ['getUserMedia', 'webkitGetUserMedia']) {
    if (typeof Navigator.prototype[name] !== 'function') continue;
    own(Navigator.prototype, name, {
      [name](constraints, ok, fail) {
        getUserMedia.call(navigator.mediaDevices, constraints).then(ok, fail);
      },
    }[name]);
  }
}

if (typeof contextBridge.executeInMainWorld === 'function') {
  contextBridge.executeInMainWorld({ func: inPage, args: [bridge] });
} else {
  // Старый Electron: мост под случайным именем, которое код в странице сразу убирает
  const name = '__aura' + Math.random().toString(36).slice(2);
  contextBridge.exposeInMainWorld(name, bridge);
  webFrame.executeJavaScript(`(${inPage})((() => { const b = window[${JSON.stringify(name)}]; delete window[${JSON.stringify(name)}]; return b; })())`);
}
