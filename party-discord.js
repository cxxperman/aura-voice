// «Пати через Discord», сторона main.js: какой процесс Discord слушать и кому из страниц окна пати отдавать его звук.
// Сам захват — AuraCapture.exe (native/capture.cpp), смешивание — в странице (party-preload.js).
'use strict';

// Discord и его тестовые сборки. У каждой — дерево процессов Electron: корень и его дочерние (окна, GPU, звук).
const DISCORD_NAMES = ['Discord.exe', 'DiscordPTB.exe', 'DiscordCanary.exe'];
const isDiscord = (name) => DISCORD_NAMES.some((n) => n.toLowerCase() === String(name || '').toLowerCase());

// tasklist /FO CSV /NH: "Discord.exe","1234","Console","1","123 456 K" — имя и номер процесса
function parseTasklist(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m) out.push({ name: m[1], pid: Number(m[2]) });
  }
  return out;
}

// Get-CimInstance Win32_Process … | ConvertTo-Json: один объект или массив { ProcessId, ParentProcessId, Name }
function parseCim(text) {
  try {
    const list = JSON.parse(String(text || '').trim() || '[]');
    return (Array.isArray(list) ? list : [list])
      .filter((p) => p && Number.isInteger(p.ProcessId))
      .map((p) => ({ name: String(p.Name || ''), pid: p.ProcessId, parent: Number(p.ParentProcessId) || 0 }));
  } catch {
    return [];
  }
}

// AuraCapture слушает процесс вместе со всеми, кого он запустил, поэтому нужен корень дерева: тот процесс Discord,
// чей родитель — не Discord (обычно его Update.exe). Звонок играет кто-то внутри дерева — корень покрывает всех.
// Запущено несколько сборок — берётся первая по списку (обычный Discord раньше PTB и Canary).
function pickDiscordRoot(procs) {
  for (const name of DISCORD_NAMES) {
    const same = procs.filter((p) => p.name.toLowerCase() === name.toLowerCase());
    const ids = new Set(same.map((p) => p.pid));
    const roots = same.filter((p) => !ids.has(p.parent)).sort((a, b) => a.pid - b.pid);
    if (roots.length) return roots[0].pid;
  }
  return 0;
}

// Страницы (и фреймы в них), которые попросили звук: только им он и уходит, по IPC прямо во фрейм.
class FrameFeed {
  constructor(channel) {
    this.channel = channel;
    this.frames = new Map(); // "процесс:фрейм" → WebFrameMain
  }
  static key(frame) {
    return `${frame.processId}:${frame.routingId}`;
  }
  want(frame) {
    if (frame) this.frames.set(FrameFeed.key(frame), frame);
  }
  unwant(frame) {
    if (frame) this.frames.delete(FrameFeed.key(frame));
  }
  get size() {
    return this.frames.size;
  }
  send(pcm) {
    for (const [key, frame] of this.frames) {
      try {
        if (frame.isDestroyed?.() || frame.detached) this.frames.delete(key);
        else frame.send(this.channel, pcm);
      } catch {
        this.frames.delete(key); // фрейм ушёл вместе со страницей
      }
    }
  }
  clear() {
    this.frames.clear();
  }
}

module.exports = { DISCORD_NAMES, isDiscord, parseTasklist, parseCim, pickDiscordRoot, FrameFeed };
