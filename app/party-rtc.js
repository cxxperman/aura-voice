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
 */
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
`;

class PartyRtc {
  // signal(id, msg): send to that peer · onMix(ArrayBuffer): 960 mono float32 samples of guests' voices
  // onVoice(stream): guest side, the host's sound to play · onPeer(id, state): 'connected' | 'failed' | 'closed'
  constructor({ signal, onMix = () => {}, onVoice = () => {}, onPeer = () => {} }) {
    this.signal = signal;
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
    this.sinks = new Map(); // keep-alive <audio> elements for remote streams
    const url = URL.createObjectURL(new Blob([PARTY_TAP], { type: 'application/javascript' }));
    this.ready = this.ctx.audioWorklet.addModule(url).then(() => {
      URL.revokeObjectURL(url);
      const tap = new AudioWorkletNode(this.ctx, 'party-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
      this.ceiling.connect(tap);
      tap.port.onmessage = (e) => this.connected() && onMix(e.data); // silence is not worth sending when nobody is here
    });
  }

  connected() {
    for (const p of this.peers.values()) if (p.pc.connectionState === 'connected') return true;
    return false;
  }

  // Host: the sound to pass on to guests (the party window). null = nothing.
  setSource(stream) {
    this.source?.disconnect();
    this.source = stream ? this.ctx.createMediaStreamSource(stream) : null;
    this.source?.connect(this.out);
  }

  peer(id) {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const entry = { pc, queue: [], described: false };
    this.peers.set(id, entry);
    pc.onicecandidate = (e) => e.candidate && this.signal(id, { t: 'ice', c: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') this.onPeer(id, 'connected');
      if (pc.connectionState === 'failed') this.onPeer(id, 'failed');
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
    entry.voice?.disconnect();
    entry.pc.close();
    this.peers.delete(id);
    const el = this.sinks.get(id);
    if (el) { el.srcObject = null; this.sinks.delete(id); }
    this.onPeer(id, 'closed');
  }

  async destroy() {
    for (const id of [...this.peers.keys()]) this.close(id);
    this.setSource(null);
    await this.ctx.close().catch(() => {});
  }
}
window.PartyRtc = PartyRtc;
