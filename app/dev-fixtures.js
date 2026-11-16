// DEV ONLY — never packaged (see "files" in package.json) and never loaded unless the window
// was started with --data=<state>. Replaces everything the window gets from outside (sounds,
// catalogue, devices, module messages) with the realistic worst case, to see what breaks.
//
// States: demo (no fixture) · worst · empty · one · many
(() => {
  const state = new URLSearchParams(location.search).get('data');

  // Sound names as people really upload and rename them. Pad names are capped at 40 characters
  // by the app, catalogue titles at 80.
  const TITLES = [
    'Мужик орёт на кассира в Пятёрочке потому что закончились пакеты (полная версия)', // 79, the cap
    'discord-notification-sound-but-its-earrape-bass-boosted-10-hours-version.mp3', // unbreakable
    'я', // one letter
    'Bruh',
    '🔥🔥🔥 СИГМА 🔥🔥🔥 МЬЮИНГ 🔥🔥🔥',
    '<b>жирный</b> &amp; звук **не жирный**', // must stay literal
    'Đặng Thị Ngọc Hân nói gì đó', // stacked diacritics
    '王秀英的声音很大声音很大声音很大声音很大声音很大', // CJK, no spaces
    'صوت مضحك جدا من تيك توك', // RTL
    'IMG_20250914_183022_HDR_portrait_edited_edited.HEIC',
    'Bruh', // identical names
    '   ', // blank title
  ];
  const catalogItem = (title, i) => ({
    id: 1000 + i,
    file: 1000 + i,
    ext: 'mp3',
    title,
    duration: [0, 1, 20, 3599, 7][i % 5],
    likes: [1340327, 0, 1, 778, 99999][i % 5],
    explicit: i % 3 === 0,
    loud: i % 2 === 0,
  });
  const pad = (name, i, key) => ({ id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}.mp3`, name: name.slice(0, 40), ...(key ? { key } : {}) });

  const worst = {
    pads: [
      pad(TITLES[0], 0, 'Ctrl+Alt+Shift+PageDown'), // the longest combination there is — and "taken"
      pad(TITLES[1], 1),
      pad('я', 2),
      pad(TITLES[4], 3, 'Ctrl+Alt+Shift+num7'),
      pad(TITLES[5], 4),
      pad(TITLES[6], 5),
      pad(TITLES[7], 6),
      pad(TITLES[8], 7),
      pad(TITLES[9], 8),
      pad('Bruh', 9),
      pad('Bruh', 10),
      pad('Очень длинное название которое обрезано', 11, 'F13'),
    ],
    failedHotkeys: ['Ctrl+Alt+Shift+PageDown', 'Ctrl+Alt+2'],
    hotkeys: { power: 'Ctrl+Alt+Shift+PageDown', mute: '' },
    catalog: () => ({ total: 19252, items: TITLES.map(catalogItem) }),
    mediaDevices: [
      ['audioinput', 'Набор микрофонов (Технология Intel® Smart Sound для цифровых микрофонов)'],
      ['audioinput', 'Микрофон (2- Realtek(R) Audio High Definition Audio Device Front Panel USB Audio CODEC) (0bda:4c07)'],
      ['audioinput', 'AUX'],
      ['audiooutput', 'Динамики (NVIDIA High Definition Audio — LG ULTRAGEAR 27GP850-B DisplayPort 1.4)'],
      ['audiooutput', 'CABLE Input (VB-Audio Virtual Cable)'],
      ['audiooutput', 'Наушники (AirPods Pro пользователя Александра Вишневская-Ковальчик Stereo)'],
    ],
    captureDevices: [
      { guid: '{11111111-1111-1111-1111-111111111111}', name: 'Набор микрофонов — Технология Intel® Smart Sound для цифровых микрофонов', current: true },
      { guid: '{22222222-2222-2222-2222-222222222222}', name: 'Микрофон — 2- Realtek(R) Audio High Definition Audio Device Front Panel USB Audio', current: false },
      { guid: '{33333333-3333-3333-3333-333333333333}', name: 'AUX — X', current: false },
    ],
    status: 'Не удалось запустить звук: NotReadableError: Could not start audio source because the device is in use by another application (0x8889000A)',
    sysMessage: 'Не удалось скопировать модуль в C:\\Program Files\\Aura (ошибка 5). Не все записи реестра удалось сделать. Запустите удаление и попробуйте снова.',
    levels: { in: -120, out: 3.2, gr: -24.53, lufs: -70, voice: 1, deep: -1, engine: 0 },
  };

  const fixtures = {
    worst,
    empty: { pads: [], catalog: () => ({ total: 0, items: [] }), mediaDevices: [], captureDevices: [], hotkeys: { power: '', mute: '' }, failedHotkeys: [] },
    one: {
      pads: [pad('Bruh', 0)],
      catalog: () => ({ total: 1, items: [catalogItem('Bruh', 2)] }),
      mediaDevices: [['audioinput', 'Микрофон'], ['audiooutput', 'Динамики']],
      captureDevices: [{ guid: '{11111111-1111-1111-1111-111111111111}', name: 'Микрофон — USB', current: true }],
      failedHotkeys: [],
    },
    many: {
      pads: Array.from({ length: 150 }, (_, i) => pad(TITLES[i % TITLES.length].trim() || `Звук ${i + 1}`, i)),
      catalog: (c) => ({ total: 19252, items: Array.from({ length: 24 }, (_, i) => catalogItem(TITLES[(c.items.length + i) % TITLES.length], c.items.length + i)) }),
      mediaDevices: Array.from({ length: 14 }, (_, i) => [i % 2 ? 'audiooutput' : 'audioinput', `Устройство ${i + 1} (USB Audio Device)`]),
      captureDevices: Array.from({ length: 9 }, (_, i) => ({ guid: `{${String(i).repeat(8)}-1111-1111-1111-111111111111}`, name: `Микрофон ${i + 1} — USB Audio Device`, current: i === 0 })),
      failedHotkeys: [],
    },
  };

  const f = fixtures[state];
  window.devFixture = f
    ? { ...f, devices: () => f.mediaDevices.map(([kind, label], i) => ({ kind, label, deviceId: `fixture-${i}` })) }
    : null;

  // The switch: plain chrome at the bottom, obviously not part of the design under test.
  const bar = document.createElement('div');
  bar.style.cssText =
    'position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:99;display:flex;gap:2px;padding:3px;border-radius:9px;background:#3a3a3c;font:12px system-ui;';
  for (const [id, label] of [['', 'Demo data'], ['worst', 'Worst case'], ['empty', 'Empty'], ['one', 'One'], ['many', '150 pads']]) {
    const b = document.createElement('button');
    b.textContent = label;
    const active = (state || '') === id || (!fixtures[state] && id === '');
    b.style.cssText = `border:0;border-radius:7px;padding:4px 10px;cursor:pointer;font:inherit;color:${active ? '#000' : '#ddd'};background:${active ? '#fff' : 'transparent'};`;
    b.addEventListener('click', () => {
      const q = new URLSearchParams(location.search);
      q.set('data', id || 'demo');
      location.search = q.toString(); // survives a reload
    });
    bar.append(b);
  }
  document.body.append(bar);
})();
