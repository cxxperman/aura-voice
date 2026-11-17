// AI voices run here, in a process of their own: loading and running neural networks must not
// freeze the window or the tray, and a crash inside the runtime must not take the app with it.
const ort = require('onnxruntime-node');
const ai = require('./ai-convert.js');

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
    } else if (cmd === 'convert') {
      const key = `${data.encoder}|${data.voice}`;
      if (key !== loaded) {
        ctx = await ai.load(ort, data.encoder, data.voice, true);
        loaded = key;
      }
      const out = await ai.convert(ctx, new Float32Array(data.pcm), Number(data.st) || 0, (p) => post({ id, progress: p }));
      post({ id, ok: true, pcm: out.buffer });
    } else {
      post({ id, ok: false, error: 'unknown command' });
    }
  } catch (e) {
    post({ id, ok: false, error: String(e?.message || e).slice(0, 240) });
  }
});
