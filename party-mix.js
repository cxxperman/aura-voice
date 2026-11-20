// Party: the stream the module adds to the microphone. %ProgramData%\Aura\mix.bin has the same
// layout as the live AI voice's file (see ai-live.js) with its own magic, and is used one way:
// this side writes mono 48 kHz floats into `play` and advances playW; the module adds them to
// what leaves the microphone.
const fs = require('fs');

const MAGIC = 0x4d525541; // "AURM"
const N = 1 << 17;
const HEADER = 64;
const SIZE = HEADER + 2 * N * 4;

class Mix {
  constructor(file) {
    let ok = false;
    try {
      ok = fs.statSync(file).size === SIZE;
    } catch {}
    if (!ok) fs.writeFileSync(file, Buffer.alloc(SIZE));
    this.fd = fs.openSync(file, 'r+');
    const head = Buffer.alloc(12);
    fs.readSync(this.fd, head, 0, 12, 0);
    if (head.readUInt32LE(0) !== MAGIC) {
      head.writeUInt32LE(MAGIC, 0);
      fs.writeSync(this.fd, head, 0, 4, 0);
    }
    this.playW = head.readUInt32LE(8);
  }

  // Appends samples (Float32Array, mono, 48 kHz): data first, then the count the module watches.
  write(samples) {
    const bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    const count = samples.length, at = this.playW & (N - 1), first = Math.min(count, N - at);
    fs.writeSync(this.fd, bytes, 0, first * 4, HEADER + N * 4 + at * 4);
    if (first < count) fs.writeSync(this.fd, bytes, first * 4, (count - first) * 4, HEADER + N * 4);
    this.playW = (this.playW + count) >>> 0;
    const head = Buffer.alloc(4);
    head.writeUInt32LE(this.playW, 0);
    fs.writeSync(this.fd, head, 0, 4, 8);
  }

  close() {
    try {
      fs.closeSync(this.fd);
    } catch {}
  }
}

module.exports = { Mix, MAGIC, N, HEADER, SIZE };
