/* Party, the sound between people. WebRTC does the work a voice link needs — Opus, encryption,
 * smoothing over lost packets — directly between the computers; party-net.js only carries the
 * few messages it takes to start.
 *
 *   host  → each guest : the sound of the party window (the person on the site)
 *   guest → host       : the guest's microphone
 *
 * The host adds up the guests' voices, holds them under a ceiling, and hands them out in 20 ms
 * pieces (`onMix`) for the module to add to the microphone. Friends hear each other elsewhere
 * (Discord, or the room): here they share one conversation with a third person.
 *
 * Some networks let the small messages through and stop WebRTC itself (its servers are blocked,
 * or its packets are recognised and dropped). Then the sound takes the pipe the messages already
 * use: 20 ms pieces of Opus, each way. Slower to recover from a lost packet, but it gets through
 * wherever the code did.
 */
const PARTY_STUN = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478', 'stun:stun.nextcloud.com:3478', 'stun:stun.sipnet.ru:3478']; // the same list as main.js
const PIPE_AFTER = 10000; // ms without a WebRTC connection before the sound goes by the pipe
const PARTY_TAP = `
class PartyTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(960); this.n = 0; }
  process(inputs) {
    const x = inputs[0][0];
    if (!x) return true;
    for (let i = 0; i < x.length; i++) {
      this.buf[this.n++] = x[i];
      if (this.n === 960) { this.port.postMessage(this.buf.buffer.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('party-tap', PartyTap);
// Sound that arrived by the pipe: plays what it has, waits for 60 ms before starting (pieces come
// unevenly), and skips ahead if it ever falls 0.3 s behind.
class PartyIn extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(48000); this.w = 0; this.r = 0; this.playing = false; this.port.onmessage = (e) => { const x = new Float32Array(e.data); for (let i = 0; i < x.length; i++) { this.buf[this.w] = x[i]; this.w = (this.w + 1) % 48000; } }; }
  process(_in, outputs) {
    const out = outputs[0][0];
    let waiting = (this.w - this.r + 48000) % 48000;
    if (!this.playing && waiting >= 2880) this.playing = true;
    if (waiting > 14400) { this.r = (this.w - 2880 + 48000) % 48000; waiting = 2880; }
    if (this.playing && waiting < out.length) this.playing = false; // ran dry: gather again
    if (!this.playing) return true;
    for (let i = 0; i < out.length; i++) { out[i] = this.buf[this.r]; this.r = (this.r + 1) % 48000; }
    return true;
  }
}
registerProcessor('party-in', PartyIn);
`;

class PartyRtc {
  // signal(id, msg): send to that peer · onMix(ArrayBuffer): 960 mono float32 samples of guests' voices
  // onVoice(stream): guest side, the host's sound to play · onPeer(id, state): 'connected' | 'failed' | 'closed'
  // sendAudio(id, base64): a piece of sound for that peer by the pipe · forcePipe: tests only
  constructor({ signal, sendAudio = () => {}, onMix = () => {}, onVoice = () => {}, onPeer = () => {}, forcePipe = false }) {
    this.signal = signal;
    this.sendAudio = sendAudio;
    this.forcePipe = forcePipe;
    this.sent = 0;
    this.onVoice = onVoice;
    this.onPeer = onPeer;
    this.peers = new Map();
    this.ctx = new AudioContext({ sampleRate: 48000 });
    this.out = this.ctx.createMediaStreamDestination(); // what guests receive
    this.bus = this.ctx.createGain(); // guests' voices, summed
    // Nobody deafens the person on the other end: a soft ceiling at about -4 dB. (A browser's
    // compressor node would add make-up gain of its own and make the guests louder instead.)
    this.ceiling = this.ctx.createWaveShaper();
    this.ceiling.curve = Float32Array.from({ length: 4097 }, (_, i) => { const x = (i / 2048 - 1) * 2; return 0.63 * Math.tanh(x / 0.63); });
    this.ceiling.oversample = '2x';
    this.pre = this.ctx.createGain(); // the shaper's input range is -1…1: halve going in, its curve is drawn for ×2
    this.pre.gain.value = 0.5;
    this.bus.connect(this.pre).connect(this.ceiling);
    this.source = null;
    this.sendBus = this.ctx.createGain(); // what this side sends, for the pipe's encoder
    this.sinks = new Map(); // keep-alive <audio> elements for remote streams
    const url = URL.createObjectURL(new Blob([PARTY_TAP], { type: 'application/javascript' }));
    this.ready = this.ctx.audioWorklet.addModule(url).then(() => {
      URL.revokeObjectURL(url);
      const tap = new AudioWorkletNode(this.ctx, 'party-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
      this.ceiling.connect(tap);
      tap.port.onmessage = (e) => this.connected() && onMix(e.data); // silence is not worth sending when nobody is here
      const sendTap = new AudioWorkletNode(this.ctx, 'party-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
      this.sendBus.connect(sendTap);
      sendTap.port.onmessage = (e) => this.encode(e.data);
    });
  }

  connected() {
    for (const p of this.peers.values()) if (p.piped || p.pc.connectionState === 'connected') return true;
    return false;
  }

  // Host: the sound to pass on to guests (the party window). null = nothing.
  setSource(stream) {
    this.source?.disconnect();
    this.source = stream ? this.ctx.createMediaStreamSource(stream) : null;
    this.source?.connect(this.out);
    this.source?.connect(this.sendBus);
  }

  peer(id) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: PARTY_STUN }] });
    const entry = { pc, queue: [], described: false, piped: false };
    entry.timer = setTimeout(() => (this.forcePipe || pc.connectionState !== 'connected') && this.pipe(id), this.forcePipe ? 1500 : PIPE_AFTER);
    this.peers.set(id, entry);
    pc.onicecandidate = (e) => e.candidate && this.signal(id, { t: 'ice', c: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected' && !this.forcePipe) { clearTimeout(entry.timer); this.onPeer(id, 'connected', false); }
      if (pc.connectionState === 'failed') this.pipe(id);
    };
    return entry;
  }

  // Remote audio reaches Web Audio only while something is also "playing" it: a muted element does that.
  hold(id, stream) {
    const el = new Audio();
    el.srcObject = stream;
    el.muted = true;
    el.play().catch(() => {});
    this.sinks.set(id, el);
  }

  // The sound with this peer goes by the pipe from now on.
  pipe(id) {
    const entry = this.peers.get(id);
    if (!entry || entry.piped) return;
    entry.piped = true;
    clearTimeout(entry.timer);
    entry.voice?.disconnect();
    entry.pc.close();
    const el = this.sinks.get(id);
    if (el) { el.srcObject = null; this.sinks.delete(id); }
    if (this.ctx.state !== 'running') this.ctx.resume();
    entry.feed = new AudioWorkletNode(this.ctx, 'party-in', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    entry.count = 0;
    entry.decoder = new AudioDecoder({
      output: (data) => {
        const x = new Float32Array(data.numberOfFrames);
        data.copyTo(x, { planeIndex: 0, format: 'f32-planar' });
        data.close();
        entry.feed.port.postMessage(x.buffer, [x.buffer]);
      },
      error: () => {},
    });
    entry.decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
    if (this.isGuest) {
      if (this.mic && !this.micNode) { this.micNode = this.ctx.createMediaStreamSource(this.mic); this.micNode.connect(this.sendBus); }
      const dest = this.ctx.createMediaStreamDestination();
      entry.feed.connect(dest);
      this.onVoice(dest.stream);
    } else {
      entry.voice = entry.feed;
      entry.feed.connect(this.bus);
    }
    this.onPeer(id, 'connected', true);
  }

  // 20 ms of what this side sends → Opus → every peer on the pipe.
  encode(buffer) {
    let any = false;
    for (const p of this.peers.values()) if (p.piped) { any = true; break; }
    if (!any) return;
    if (!this.encoder) {
      this.encoder = new AudioEncoder({
        output: (chunk) => {
          const bytes = new Uint8Array(chunk.byteLength);
          chunk.copyTo(bytes);
          const d = btoa(String.fromCharCode.apply(null, bytes));
          for (const [id, p] of this.peers) if (p.piped) this.sendAudio(id, d);
        },
        error: () => { this.encoder = null; },
      });
      this.encoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 40000 });
    }
    const data = new AudioData({ format: 'f32', sampleRate: 48000, numberOfFrames: 960, numberOfChannels: 1, timestamp: this.sent++ * 20000, data: new Float32Array(buffer) });
    this.encoder.encode(data);
    data.close();
  }

  // A piece of sound arrived by the pipe: the other side has given up on WebRTC, so this side does too.
  onAudio(id, d) {
    const entry = this.peers.get(id);
    if (!entry || typeof d !== 'string') return;
    if (!entry.piped) this.pipe(id);
    try {
      const raw = atob(d), bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      entry.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: entry.count++ * 20000, data: bytes }));
    } catch {}
  }

  // Host: a guest was let in.
  async addGuest(id) {
    await this.ready;
    if (this.ctx.state !== 'running') await this.ctx.resume();
    const { pc } = this.peer(id);
    for (const track of this.out.stream.getAudioTracks()) pc.addTrack(track, this.out.stream);
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      this.hold(id, stream);
      const entry = this.peers.get(id);
      entry.voice = this.ctx.createMediaStreamSource(stream);
      entry.voice.connect(this.bus);
    };
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    this.signal(id, { t: 'offer', sdp: offer.sdp });
  }

  // Guest: `mic` is the stream to send (may be null: listen only).
  async asGuest(mic) {
    await this.ready;
    this.mic = mic;
    this.isGuest = true;
  }

  async onSignal(id, msg) {
    let entry = this.peers.get(id);
    if (msg.t === 'offer') { // guest side
      if (entry) this.close(id);
      entry = this.peer(id);
      const { pc } = entry;
      if (this.mic) for (const track of this.mic.getAudioTracks()) pc.addTrack(track, this.mic);
      pc.ontrack = (e) => this.onVoice(e.streams[0] || new MediaStream([e.track]));
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signal(id, { t: 'answer', sdp: answer.sdp });
    } else if (msg.t === 'answer' && entry) {
      await entry.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    } else if (msg.t === 'ice' && entry) {
      if (!entry.pc.remoteDescription) return void entry.queue.push(msg.c); // candidates may outrun the description
      await entry.pc.addIceCandidate(msg.c).catch(() => {});
      return;
    } else {
      return;
    }
    for (const c of entry.queue.splice(0)) await entry.pc.addIceCandidate(c).catch(() => {});
  }

  close(id) {
    const entry = this.peers.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.voice?.disconnect();
    entry.feed?.disconnect();
    try { entry.decoder?.close(); } catch {}
    entry.pc.close();
    this.peers.delete(id);
    const el = this.sinks.get(id);
    if (el) { el.srcObject = null; this.sinks.delete(id); }
    this.onPeer(id, 'closed');
  }

  async destroy() {
    for (const id of [...this.peers.keys()]) this.close(id);
    this.setSource(null);
    try { this.encoder?.close(); } catch {}
    await this.ctx.close().catch(() => {});
  }
}
window.PartyRtc = PartyRtc;
