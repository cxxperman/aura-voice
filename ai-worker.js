// AI voices run here, in a process of their own: loading and running neural networks must not
// freeze the window or the tray, and a crash inside the runtime must not take the app with it.
const ort = require('onnxruntime-node');
const ai = require('./ai-convert.js');
const pth = require('./ai-pth.js');
const { Live } = require('./ai-live.js');

let live = null;

let ctx = null;
let loaded = '';
const post = (msg) => process.parentPort.postMessage(msg);

process.parentPort.on('message', async ({ data }) => {
  const { id, cmd } = data;
  try {
    if (cmd === 'inspect') {
      // Only the model's inputs are read; nothing is run.
      const session = await ort.InferenceSession.create(data.voice, { executionProviders: ['cpu'], logSeverityLevel: 3 });
      const info = ai.describeVoice(session);
      await session.release?.();
      post({ id, ok: true, info });
    } else if (cmd === 'pth') {
      // A shared .pth model → ONNX. The file is only read, never executed (see ai-pth.js).
      post({ id, ok: true, info: pth.convertPth(data.file, data.templates, data.out) });
    } else if (cmd === 'live-start') {
      live?.stop();
      live = null;
      const key = `${data.encoder}|${data.voice}`;
      if (key !== loaded) {
        ctx = await ai.load(ort, data.encoder, data.voice, true);
        loaded = key;
      }
      await ai.convertWindow(ctx, new Float32Array(ai.WINDOW16), new Float32Array(ai.FRAMES), 0); // the first run is slow: do it before going on air
      live = new Live(ai, ctx, data.file, { st: Number(data.st) || 0, speaker: Number(data.speaker) || 0 }, (m) => post({ id: 0, ...m }));
      post({ id, ok: true });
    } else if (cmd === 'live-set') {
      if (live) { live.st = Number(data.st) || 0; live.speaker = Number(data.speaker) || 0; }
      post({ id, ok: true });
    } else if (cmd === 'live-stop') {
      live?.stop();
      live = null;
      post({ id, ok: true });
    } else if (cmd === 'convert') {
      const key = `${data.encoder}|${data.voice}`;
      if (key !== loaded) {
        ctx = await ai.load(ort, data.encoder, data.voice, true);
        loaded = key;
      }
      const out = await ai.convert(ctx, new Float32Array(data.pcm), Number(data.st) || 0, (p) => post({ id, progress: p }), Number(data.speaker) || 0);
      post({ id, ok: true, pcm: out.buffer });
    } else {
      post({ id, ok: false, error: 'unknown command' });
    }
  } catch (e) {
    post({ id, ok: false, error: String(e?.message || e).slice(0, 240) });
  }
});
