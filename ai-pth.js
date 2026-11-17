// Turns an RVC voice model as people share it (.pth) into the ONNX file Aura runs — without
// Python, and without ever executing anything from the file.
//
// A .pth is a zip: a pickle that describes the contents, and the raw numbers of every weight.
// Python's pickle can run code when loaded, which is why such files are dangerous in Python
// tools. Here the pickle is only *read*: the few instructions needed to describe tensors are
// interpreted, everything else becomes an inert label. Nothing in the file can be run.
//
// All v2 models of one sample rate have the same network; only the weights differ. So the
// weights are poured into a template — that network exported once by RVC's own exporter, with
// the numbers taken out (see scripts/ai-export.py) — where every weight has the same name.
const fs = require('fs');
const path = require('path');

/* ── zip (stored entries only, as torch writes them) ── */
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('damaged archive');
    const method = buf.readUInt16LE(at + 10), size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    if (method !== 0 || size === 0xffffffff || local === 0xffffffff) throw new Error('unsupported archive layout');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.set(name, buf.subarray(start, start + size));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* ── pickle, read-only ── */
function unpickle(buf) {
  const stack = [], memo = new Map(), marks = [];
  let at = 0;
  const u8 = () => buf[at++];
  const line = () => { const end = buf.indexOf(10, at); const s = buf.toString('utf8', at, end); at = end + 1; return s; };
  const popMark = () => { const m = marks.pop(); return stack.splice(m); };
  for (;;) {
    const op = u8();
    switch (op) {
      case 0x80: at += 1; break; // PROTO
      case 0x95: at += 8; break; // FRAME
      case 0x63: stack.push({ global: `${line()}.${line()}` }); break; // GLOBAL: a label, never called
      case 0x71: memo.set(u8(), stack[stack.length - 1]); break; // BINPUT
      case 0x72: memo.set(buf.readUInt32LE(at), stack[stack.length - 1]); at += 4; break; // LONG_BINPUT
      case 0x94: memo.set(memo.size, stack[stack.length - 1]); break; // MEMOIZE
      case 0x68: stack.push(memo.get(u8())); break; // BINGET
      case 0x6a: stack.push(memo.get(buf.readUInt32LE(at))); at += 4; break; // LONG_BINGET
      case 0x7d: stack.push(Object.create(null)); break; // EMPTY_DICT
      case 0x5d: stack.push([]); break; // EMPTY_LIST
      case 0x29: stack.push([]); break; // EMPTY_TUPLE
      case 0x28: marks.push(stack.length); break; // MARK
      case 0x58: { const n = buf.readUInt32LE(at); at += 4; stack.push(buf.toString('utf8', at, at + n)); at += n; break; } // BINUNICODE
      case 0x8c: { const n = u8(); stack.push(buf.toString('utf8', at, at + n)); at += n; break; } // SHORT_BINUNICODE
      case 0x4b: stack.push(u8()); break; // BININT1
      case 0x4d: stack.push(buf.readUInt16LE(at)); at += 2; break; // BININT2
      case 0x4a: stack.push(buf.readInt32LE(at)); at += 4; break; // BININT
      case 0x8a: { const n = u8(); let v = 0; for (let i = n - 1; i >= 0; i--) v = v * 256 + buf[at + i]; at += n; stack.push(v); break; } // LONG1 (sizes are small and positive)
      case 0x47: stack.push(buf.readDoubleBE(at)); at += 8; break; // BINFLOAT
      case 0x4e: stack.push(null); break; // NONE
      case 0x88: stack.push(true); break;
      case 0x89: stack.push(false); break;
      case 0x74: stack.push(popMark()); break; // TUPLE
      case 0x85: stack.push(stack.splice(-1)); break; // TUPLE1
      case 0x86: stack.push(stack.splice(-2)); break; // TUPLE2
      case 0x87: stack.push(stack.splice(-3)); break; // TUPLE3
      case 0x6c: stack.push(popMark()); break; // LIST
      case 0x61: { const v = stack.pop(); stack[stack.length - 1].push(v); break; } // APPEND
      case 0x65: { const items = popMark(); stack[stack.length - 1].push(...items); break; } // APPENDS
      case 0x73: { const v = stack.pop(), k = stack.pop(); stack[stack.length - 1][k] = v; break; } // SETITEM
      case 0x75: { const items = popMark(); const d = stack[stack.length - 1]; for (let i = 0; i < items.length; i += 2) d[items[i]] = items[i + 1]; break; } // SETITEMS
      case 0x51: { const pid = stack.pop(); stack.push({ storage: { type: pid[1]?.global || '', key: String(pid[2]), numel: Number(pid[4]) } }); break; } // BINPERSID: where a tensor's numbers are
      case 0x52: { // REDUCE: only the constructors needed to describe tensors are understood
        const args = stack.pop(), fn = stack.pop();
        const name = fn && fn.global;
        if (name === 'collections.OrderedDict') stack.push(Object.create(null));
        else if (name === 'torch._utils._rebuild_tensor_v2') stack.push({ tensor: args[0].storage, offset: Number(args[1]), shape: args[2].map(Number) });
        else if (name === 'torch._utils._rebuild_parameter') stack.push(args[0]);
        else stack.push({ opaque: name || 'unknown' });
        break;
      }
      case 0x62: { // BUILD: state for an object we treat as inert — only dicts of dicts matter
        const state = stack.pop(), obj = stack[stack.length - 1];
        if (obj && state && typeof obj === 'object' && typeof state === 'object' && !Array.isArray(state) && !obj.tensor) Object.assign(obj, state);
        break;
      }
      case 0x2e: return stack.pop(); // STOP
      default: throw new Error(`unsupported pickle instruction 0x${op.toString(16)}`);
    }
  }
}

const halfToFloat = (h) => {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
  return e === 0 ? s * f * Math.pow(2, -24) : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * Math.pow(2, e - 15);
};
function tensorData(entries, prefix, t) {
  const count = t.shape.reduce((a, b) => a * b, 1);
  const raw = entries.get(`${prefix}data/${t.tensor.key}`);
  if (!raw) throw new Error('a weight is missing from the file');
  const out = new Float32Array(count);
  const type = t.tensor.type;
  if (/HalfStorage/.test(type)) for (let i = 0; i < count; i++) out[i] = halfToFloat(raw.readUInt16LE((t.offset + i) * 2));
  else if (/FloatStorage/.test(type)) for (let i = 0; i < count; i++) out[i] = raw.readFloatLE((t.offset + i) * 4);
  else if (/DoubleStorage/.test(type)) for (let i = 0; i < count; i++) out[i] = raw.readDoubleLE((t.offset + i) * 8);
  else throw new Error(`unsupported weight type ${type}`);
  return out;
}

// Reads a .pth: { weights: Map(name → { shape, data }), rate, version, pitched }.
function readPth(file) {
  const entries = zipEntries(fs.readFileSync(file));
  const pkl = [...entries.keys()].find((n) => n.endsWith('/data.pkl') || n === 'data.pkl');
  if (!pkl) throw new Error('this is not a PyTorch model file');
  const prefix = pkl.slice(0, pkl.length - 'data.pkl'.length);
  const top = unpickle(entries.get(pkl));
  const state = top && (top.weight || top.model);
  if (!state || typeof state !== 'object') throw new Error('no weights found: this is not an RVC voice model');
  const weights = new Map();
  for (const name of Object.keys(state)) {
    const t = state[name];
    if (!t || !t.tensor || name.includes('enc_q')) continue; // the posterior encoder is for training only
    weights.set(name, { shape: t.shape, data: tensorData(entries, prefix, t) });
  }
  const config = Array.isArray(top.config) ? top.config : [];
  const rate = Number(config[config.length - 1]) || { '32k': 32000, '40k': 40000, '48k': 48000 }[top.sr] || 0;
  return { weights, rate, version: top.version || 'v1', pitched: top.f0 == null ? true : Number(top.f0) === 1 };
}

/* ── ONNX (protobuf), just enough to replace the weights ── */
function varint(buf, at) {
  let v = 0, shift = 0, b;
  do { b = buf[at++]; v += (b & 0x7f) * Math.pow(2, shift); shift += 7; } while (b & 0x80);
  return [v, at];
}
const encodeVarint = (v) => { const out = []; while (v >= 0x80) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); } out.push(v); return Buffer.from(out); };
function fields(buf) {
  const out = [];
  let at = 0;
  while (at < buf.length) {
    const start = at;
    let tag; [tag, at] = varint(buf, at);
    const field = Math.floor(tag / 8), wire = tag % 8;
    let from = at, to;
    if (wire === 0) { [, at] = varint(buf, at); to = at; }
    else if (wire === 2) { let len; [len, at] = varint(buf, at); from = at; at += len; to = at; }
    else if (wire === 5) { at += 4; to = at; }
    else if (wire === 1) { at += 8; to = at; }
    else throw new Error('unexpected ONNX structure');
    out.push({ field, wire, start, end: at, from, to });
  }
  return out;
}
const lengthDelimited = (field, body) => Buffer.concat([encodeVarint(field * 8 + 2), encodeVarint(body.length), body]);

// Pours the weights into the template; returns the finished ONNX file as a Buffer.
function fill(template, weights) {
  const model = fields(template);
  const graphField = model.find((f) => f.field === 7 && f.wire === 2);
  if (!graphField) throw new Error('bad template');
  const graph = template.subarray(graphField.from, graphField.to);
  const parts = [];
  let used = 0;
  for (const f of fields(graph)) {
    if (f.field !== 5) { parts.push(graph.subarray(f.start, f.end)); continue; } // not a weight: keep byte for byte
    const tensor = graph.subarray(f.from, f.to);
    let name = '', dims = [];
    for (const t of fields(tensor)) {
      if (t.field === 8) name = tensor.toString('utf8', t.from, t.to);
      else if (t.field === 1 && t.wire === 0) dims.push(varint(tensor, t.from)[0]);
      else if (t.field === 1 && t.wire === 2) for (let at = t.from; at < t.to;) { let v; [v, at] = varint(tensor, at); dims.push(v); }
    }
    const w = weights.get(name);
    if (!w) throw new Error(`the model has no weight "${name}" — it is built differently from the template`);
    const same = w.shape.length === dims.length && w.shape.every((d, i) => d === dims[i] || (name === 'emb_g.weight' && i === 0)); // the number of speakers may differ
    if (!same) throw new Error(`weight "${name}" is ${w.shape.join('×')}, the template expects ${dims.join('×')}`);
    const body = Buffer.concat([
      ...w.shape.map((d) => Buffer.concat([encodeVarint(1 * 8 + 0), encodeVarint(d)])), // dims
      Buffer.concat([encodeVarint(2 * 8 + 0), encodeVarint(1)]), // data_type = FLOAT
      lengthDelimited(8, Buffer.from(name, 'utf8')),
      lengthDelimited(9, Buffer.from(w.data.buffer, w.data.byteOffset, w.data.byteLength)), // raw_data, little-endian float32
    ]);
    parts.push(lengthDelimited(5, body));
    used++;
  }
  const newGraph = Buffer.concat(parts);
  const out = model.map((f) => (f === graphField ? lengthDelimited(7, newGraph) : template.subarray(f.start, f.end)));
  return { onnx: Buffer.concat(out), used };
}

// .pth → .onnx file. Throws with a reason a person can act on.
function convertPth(pthFile, templatesDir, outFile) {
  const model = readPth(pthFile);
  if (model.version !== 'v2') throw new Error('Это модель первого поколения (v1). Поддерживаются модели v2.');
  if (!model.pitched) throw new Error('Это модель без высоты тона (no-f0). Поддерживаются модели с высотой.');
  const template = path.join(templatesDir, `rvc-v2-${model.rate / 1000}k.template.onnx`);
  if (![32000, 40000, 48000].includes(model.rate) || !fs.existsSync(template)) throw new Error(`Неизвестная частота модели: ${model.rate || '?'} Гц.`);
  const { onnx, used } = fill(fs.readFileSync(template), model.weights);
  fs.writeFileSync(outFile, onnx);
  return { rate: model.rate, weights: used, speakers: model.weights.get('emb_g.weight')?.shape[0] || 1 };
}

module.exports = { readPth, fill, convertPth, fields };
