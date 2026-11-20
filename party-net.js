// Party, the network side: people who know a code find each other and exchange what their
// WebRTC connections need to start. No server of ours — discovery and the encrypted pipe are
// Hyperswarm's (a public DHT, as torrents use); the audio itself then goes peer to peer in the
// window (app/party-rtc.js).
//
// What travels on this pipe is a handful of small JSON messages and nothing else: there is no
// file transfer, no command, nothing a peer can make this side *do* beyond what is listed in
// `onMessage`. Anything unexpected closes the connection.
//
//   guest → host   hello { name }                      (once, first)
//   host → guest   welcome | denied                    (after the host's own decision)
//   both ways      offer / answer { sdp }, ice { c }   (only once welcomed)
const crypto = require('crypto');
const { EventEmitter } = require('events');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L: codes are read aloud
const MAX_LINE = 96 * 1024;
const MAX_GUESTS = 8;

function newCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}
// What the user typed → the canonical code, or '' if it cannot be one.
function normalizeCode(text) {
  const s = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 8 && [...s].every((ch) => ALPHABET.includes(ch)) ? `${s.slice(0, 4)}-${s.slice(4)}` : '';
}
const topicOf = (code) => crypto.createHash('sha256').update('aura-party-v1:' + code).digest();
const cleanName = (name) => String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24) || 'Гость';

class PartyNet extends EventEmitter {
  constructor(Hyperswarm) {
    super();
    this.Hyperswarm = Hyperswarm;
    this.swarm = null;
    this.role = null;
    this.code = '';
    this.peers = new Map();
  }

  async host() {
    await this.leave();
    this.role = 'host';
    this.code = newCode();
    this.swarm = new this.Hyperswarm();
    this.swarm.on('connection', (socket, info) => this.accept(socket, info));
    await this.swarm.join(topicOf(this.code), { server: true, client: false }).flushed();
    return this.code;
  }

  async join(code, name) {
    const canonical = normalizeCode(code);
    if (!canonical) throw new Error('bad code');
    await this.leave();
    this.role = 'guest';
    this.code = canonical;
    this.name = cleanName(name);
    this.swarm = new this.Hyperswarm();
    this.swarm.on('connection', (socket, info) => this.accept(socket, info));
    this.swarm.join(topicOf(canonical), { server: false, client: true });
    await this.swarm.flush();
  }

  accept(socket, info) {
    const id = info.publicKey.toString('hex').slice(0, 16);
    if (this.peers.has(id) || (this.role === 'guest' && this.peers.size) || (this.role === 'host' && this.peers.size >= MAX_GUESTS + 4)) return socket.destroy();
    const peer = { id, socket, name: '', state: 'new', buffer: '' };
    this.peers.set(id, peer);
    const drop = () => {
      if (this.peers.get(id) !== peer) return;
      this.peers.delete(id);
      clearTimeout(peer.timer);
      if (peer.state === 'in' || peer.state === 'asking') this.emit('left', { id, name: peer.name });
      if (this.role === 'guest') this.emit('ended', {});
    };
    socket.on('error', () => {});
    socket.on('close', drop);
    socket.on('data', (chunk) => {
      peer.buffer += chunk.toString('utf8');
      if (peer.buffer.length > MAX_LINE) return socket.destroy(); // nobody honest sends this much
      let at;
      while ((at = peer.buffer.indexOf('\n')) >= 0) {
        const line = peer.buffer.slice(0, at);
        peer.buffer = peer.buffer.slice(at + 1);
        let msg = null;
        try {
          msg = JSON.parse(line);
        } catch {}
        if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string' || !this.onMessage(peer, msg)) return socket.destroy();
      }
    });
    if (this.role === 'guest') {
      peer.state = 'waiting';
      this.send(peer, { t: 'hello', name: this.name });
      this.emit('waiting', {});
    } else {
      peer.timer = setTimeout(() => peer.state === 'new' && socket.destroy(), 8000); // say who you are, or go
    }
  }

  // Returns false for anything this side does not expect from that peer in its current state.
  onMessage(peer, msg) {
    const signal = () => {
      if (peer.state !== 'in') return false;
      if (msg.t === 'ice') {
        const c = msg.c;
        if (!c || typeof c !== 'object' || typeof c.candidate !== 'string' || c.candidate.length > 1024) return false;
        this.emit('signal', { id: peer.id, msg: { t: 'ice', c: { candidate: c.candidate, sdpMid: c.sdpMid == null ? null : String(c.sdpMid).slice(0, 16), sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) ? c.sdpMLineIndex : null } } });
        return true;
      }
      if (typeof msg.sdp !== 'string' || msg.sdp.length > 64 * 1024) return false;
      this.emit('signal', { id: peer.id, msg: { t: msg.t, sdp: msg.sdp } });
      return true;
    };
    if (this.role === 'host') {
      if (msg.t === 'hello' && peer.state === 'new') {
        peer.name = cleanName(msg.name);
        peer.state = 'asking';
        clearTimeout(peer.timer);
        this.emit('request', { id: peer.id, name: peer.name });
        return true;
      }
      return (msg.t === 'answer' || msg.t === 'ice') && signal();
    }
    if (msg.t === 'welcome' && peer.state === 'waiting') {
      peer.state = 'in';
      this.emit('joined', { id: peer.id });
      return true;
    }
    if (msg.t === 'denied' && peer.state === 'waiting') {
      this.emit('denied', {});
      return true;
    }
    return (msg.t === 'offer' || msg.t === 'ice') && signal();
  }

  send(peer, msg) {
    try {
      peer.socket.write(JSON.stringify(msg) + '\n');
    } catch {}
  }

  // Host: let the one who asked in, or not.
  answer(id, ok) {
    const peer = this.peers.get(id);
    if (!peer || this.role !== 'host' || peer.state !== 'asking') return false;
    const members = [...this.peers.values()].filter((p) => p.state === 'in').length;
    if (ok && members < MAX_GUESTS) {
      peer.state = 'in';
      this.send(peer, { t: 'welcome' });
      this.emit('member', { id, name: peer.name });
    } else {
      peer.state = 'out';
      this.send(peer, { t: 'denied' });
      setTimeout(() => peer.socket.destroy(), 300);
    }
    return true;
  }

  signal(id, msg) {
    const peer = this.peers.get(id);
    if (!peer || peer.state !== 'in' || !msg || !['offer', 'answer', 'ice'].includes(msg.t)) return false;
    this.send(peer, msg.t === 'ice' ? { t: 'ice', c: msg.c } : { t: msg.t, sdp: String(msg.sdp || '') });
    return true;
  }

  kick(id) {
    this.peers.get(id)?.socket.destroy();
  }

  async leave() {
    const swarm = this.swarm;
    this.swarm = null;
    this.role = null;
    this.code = '';
    for (const peer of this.peers.values()) peer.socket.destroy();
    this.peers.clear();
    if (swarm) await swarm.destroy().catch(() => {});
  }
}

module.exports = { PartyNet, newCode, normalizeCode };
