// KOZEL: сервер для игры по сети. Без внешних зависимостей, нужен только Node.js 18+.
// Правила берутся из rules.js, сервер решает всё сам: тасует, раздаёт, считает, проверяет.
// Связь: события сервер → игрок по Server-Sent Events (/api/events), действия игрок → сервер по POST (/api/action).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const K = require('./rules.js');
const KL = require('./lines.js');
const A = require('./accounts.js');
const KC = require('./campaign.js');
const KB = require('./billiard.js');

const PORT = process.env.PORT || 8080;
const TURN_MS = 60000;          // минута на ход
const AWAY_TURN_MS = 12000;     // если игрок отключился, ждём меньше
const BOT_DELAY = 900;
const AFTER_TRICK = 2100;       // пауза, чтобы все увидели взятку
const AFTER_VERDICT = 5500;     // пауза на окно проверки
const CLOSE_MS = 20000;         // окно «последней предъявы» после 9-й взятки
const ROOM_TTL = 3 * 3600 * 1000;
const CHARS = Object.fromEntries(Object.entries(KL.CHAR).map(([id, c]) => [id, c.name]));
const charPick = (c) => (CHARS[c] && !KL.CHAR[c].boss ? c : 'oleg');
// Свои пацаны только для своих аккаунтов (KL.canUse), чужому даём свободного нейтрального
const charOk = (c, acct, room) => {
  c = charPick(c);
  if (KL.canUse(c, acct)) return c;
  const n = KL.neutralIds(), free = n.filter((x) => !(room && room.seats.some((s) => s && s.char === x)));
  return free[0] || n[0] || c;
};
const xpOk = (x) => Math.max(0, Math.min(1e7, Math.floor(Number(x) || 0)));
const EMOTES = ['😂', '😎', '🤡', '🐐', '👏', '🤬', '🍺', '💀', 'Красава!', 'Ходи уже!', 'Ну ты и крыса', 'Ахаха, лошара', 'Чётко!', 'Гг, пацаны', '🔥', 'Учись, салага', '🎰', 'Фарт есть фарт', '👑', 'Учитесь, пацаны'];

const rooms = new Map();
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const LINES = {
  bigWin: ['Опа, моё!', 'Забираю, не плачь', 'Как с куста', 'Учись, пока я живой', '<i>*смачно сгребает карты*</i>', 'Фарт пошёл'],
  hval: ['Хвал у меня, не дёргайтесь', 'Хвалюсь, пацаны', '<i>*стучит хвалом по столу*</i>', 'Ну чё, поехали'],
  caught: ['Да я случайно...', 'Попутал, бывает', 'Ну полез на трояк, с кем не бывает', '<i>*делает вид, что ни при чём*</i>'],
  clean: ['Чё ты гонишь?', 'Я чистый, как стёклышко', 'За базар ответишь', '<i>*крутит пальцем у виска*</i>'],
};

// ---------- Комнаты ----------
function newCode() {
  const abc = '0123456789'.split(''); // цифры: удобно вводить с любой клавиатуры
  let c;
  do { c = Array.from({ length: 4 }, () => pick(abc)).join(''); } while (rooms.has(c));
  return c;
}
const token = () => crypto.randomBytes(16).toString('hex');
const humans = (room) => room.seats.filter((s) => s && !s.bot);
const seatOf = (room, tok) => room.seats.findIndex((s) => s && s.token === tok);

function createRoom(name, mode, ch, xp, acct, loc, honest, noEmo, stake) {
  const code = newCode();
  const room = { code, loc: KL.LOC_IDS.includes(loc) ? loc : 'baza', mode: ['lite', 'turbo'].includes(mode) ? mode : 'hard', phase: 'lobby', honest: !!honest, noEmo: !!noEmo, stake: KC.STAKES[stake] ? Number(stake) : 0, seats: [null, null, null, null], host: 0,
    match: null, round: null, voids: [], timer: null, deadline: 0, touched: Date.now() };
  rooms.set(code, room);
  const tok = token();
  const cc = charOk(ch, acct, room);
  room.seats[0] = { token: tok, name: clean(name) || CHARS[cc], char: cc, xp: xpOk(xp), bot: false, conns: new Set(), acct: acct || null };
  return { room, tok, seat: 0 };
}
const clean = (s) => String(s || '').replace(/[<>&"]/g, '').trim().slice(0, 14);

// хватает ли у игрока на ставку (браузер сам сообщает баланс action 'bal')
function canPay(room, s) { const st = KC.STAKES[room.stake]; return !st || !st.r || (s.bal && (s.bal[st.r] || 0) >= st.n); }
// ---------- Что видит конкретный игрок ----------
// Места поворачиваются так, что сам игрок всегда на месте 0, напарник на 2.
function viewFor(room, my) {
  if (room.game === 'bil') return bilView(room, my);
  const R = (a) => (a - my + 4) % 4;
  const rot = (arr) => [0, 1, 2, 3].map((r) => arr[(r + my) % 4]);
  const t = my % 2;
  const v = {
    code: room.code, phase: room.phase, mode: room.mode, honest: !!room.honest, noEmo: !!room.noEmo, paused: room.paused ? { by: R(room.paused.by) } : null, weather: room.weather || null, canUndo: canUndo(room, my), undo: room.undo ? { seat: R(room.undo.seat), votes: [...room.undo.votes].map(R), mine: room.undo.votes.has(my) } : null, loc: room.loc, host: R(room.host), now: Date.now(),
    stake: room.stake ? Object.assign({ i: room.stake }, KC.STAKES[room.stake]) : null,
    seats: rot(room.seats).map((s) => (s ? { name: s.name, bot: s.bot, char: s.char, xp: s.xp || 0, online: s.bot || s.conns.size > 0, poor: !!(room.stake && !s.bot && !canPay(room, s)), admin: !s.bot && s.acct === KL.ADMIN } : null)),
  };
  if (room.match) {
    const m = room.match;
    v.match = { penalties: [m.penalties[t], m.penalties[1 - t]], eggs: [m.eggs[t], m.eggs[1 - t]], praise: rot(m.praise), limit: m.limit || 12,
      loser: K.matchLoser(m) === null ? null : (K.matchLoser(m) - t + 2) % 2 };
  }
  if (room.round) {
    const r = room.round;
    v.round = {
      hands: rot(r.hands).map((h, i) => (i === 0 ? h : { length: h.length })),
      trick: r.trick.map((e) => ({ seat: R(e.seat), card: e.card, trickNo: e.trickNo })),
      log: r.log.map((e) => ({ seat: R(e.seat), card: e.card, trickNo: e.trickNo, checked: e.checked })),
      hvalSeat: R(r.hvalSeat), trump: r.trump, turn: r.turn < 0 ? -1 : R(r.turn), over: r.over, closing: !!r.closing,
      ready: r.closing ? rot(room.seats.map((x, i) => !!(room.ready && room.ready.has(i)))) : null,
      taken: room.mode !== 'hard' || r.over ? [r.taken[t], r.taken[1 - t]] : [0, 0],
      end: r.end ? Object.assign({}, r.end, r.end.team !== undefined ? { team: (r.end.team - t + 2) % 2 } : {}, r.end.accused !== undefined ? { accused: R(r.end.accused) } : {}) : null,
      deadline: room.deadline,
    };
  }
  return v;
}
function convEvent(ev, my, n) {
  n = n || 4;
  const e = Object.assign({}, ev);
  for (const k of ['seat', 'winner', 'accuser', 'accused', 'mate', 'by']) if (e[k] !== undefined) e[k] = (e[k] - my + n) % n;
  if (e.team !== undefined) e.team = (e.team - (my % 2) + 2) % 2;
  return e;
}
function broadcast(room, events) {
  room.touched = Date.now();
  room.seats.forEach((s, i) => {
    if (!s || s.bot || !s.conns.size) return;
    const msg = 'data: ' + JSON.stringify({ events: (events || []).map((e) => convEvent(e, i, room.seats.length)), view: viewFor(room, i) }) + '\n\n';
    for (const res of s.conns) res.write(msg);
  });
}

// Лёгкие события без вида стола (рот по микрофону, общие сценки): клиент показывает сразу
function blast(room, events) {
  room.seats.forEach((s, i) => {
    if (!s || s.bot || !s.conns.size) return;
    const msg = 'data: ' + JSON.stringify({ fx: events.map((e) => convEvent(e, i, room.seats.length)) }) + '\n\n';
    for (const res of s.conns) res.write(msg);
  });
}
// Приколы (гости, бабка, соседи) по сети: сервер выбирает момент и зерно, у всех на экране одно и то же
function sceneLoop(room) {
  clearTimeout(room.sceneT);
  room.sceneT = setTimeout(() => {
    if (!rooms.has(room.code)) return;
    if (room.phase === 'playing' && !room.paused && room.seats.some((x) => x && !x.bot && x.conns.size)) {
      const r = Math.random();
      const kind = (KL.LOCMETA[room.loc] || {}).balc ? (r < .4 ? 'guest' : r < .75 ? 'babka' : 'neigh') : 'guest';
      blast(room, [{ type: 'scene', kind, seed: Math.floor(Math.random() * 2 ** 31), seat: Math.floor(Math.random() * 4) }]);
    }
    sceneLoop(room);
  }, 40000 + Math.random() * 35000);
}

// Находки на всех локациях: кто первый тыкнул, тот забрал. Боты тоже иногда подбирают.
// Обычные находки раз в 35-70 с (лежат 45 с), монеты 1 грн на стол раз в 20-40 с (лежат 14 с)
let findSeq = 1;
const liveTable = (room) => room.phase === 'playing' && !room.paused && room.seats.some((x) => x && !x.bot && x.conns.size);
function dropFind(room, f, ms, force) {
  room.finds = room.finds || {};
  if (!force && Object.keys(room.finds).length >= 4) return;
  room.finds[f.id] = f;
  blast(room, [Object.assign({ type: 'find' }, f)]);
  const bots = room.seats.map((x, i) => (x && x.bot ? i : -1)).filter((i) => i >= 0);
  if (bots.length && Math.random() < (f.coin ? .3 : .35)) setTimeout(() => grabFind(room, f.id, pick(bots)), f.coin ? 3500 + Math.random() * 6000 : 9000 + Math.random() * 13000);
  setTimeout(() => { if (room.finds && room.finds[f.id]) { delete room.finds[f.id]; blast(room, [{ type: 'findGone', id: f.id }]); } }, ms);
}
function findLoop(room) {
  clearTimeout(room.findT);
  room.findT = setTimeout(() => {
    if (!rooms.has(room.code)) return;
    if (liveTable(room)) dropFind(room, Object.assign({ id: findSeq++, seed: Math.floor(Math.random() * 2 ** 31) }, KL.rollFind(null, KL.bgOf(room.loc, room.code))), 45000);
    findLoop(room);
  }, Number(process.env.FIND_MS) || 35000 + Math.random() * 35000); // FIND_MS только для проверок
}
function coinLoop(room) {
  clearTimeout(room.coinT);
  room.coinT = setTimeout(() => {
    if (!rooms.has(room.code)) return;
    if (liveTable(room)) dropFind(room, Object.assign({ id: findSeq++, seed: Math.floor(Math.random() * 2 ** 31) }, KL.rollCoin(null, KL.bgOf(room.loc, room.code))), 14000);
    coinLoop(room);
  }, Number(process.env.FIND_MS) || 20000 + Math.random() * 20000);
}
function grabFind(room, id, seat) {
  const f = room.finds && room.finds[id];
  if (!f) return false;
  delete room.finds[id];
  blast(room, [{ type: 'found', id, seat, item: f.item, qty: f.qty, rar: f.rar, coin: !!f.coin, at: f.at }]);
  return true;
}
// админ подкинул монет на стол
function coinRain(room, n) { for (let k = 0; k < n; k++) setTimeout(() => dropFind(room, Object.assign({ id: findSeq++, seed: Math.floor(Math.random() * 2 ** 31) }, KL.rollCoin(null, KL.bgOf(room.loc, room.code))), 12000, true), k * 350); }

// Погода: одна на стол, меняется раз в 2.5-5 минут, без снега
const WX_KINDS = ['clear', 'clear', 'cloudy', 'cloudy', 'drizzle', 'drizzle', 'rain', 'rain', 'storm', 'storm', 'wind', 'leaves', 'leaves', 'heat', 'rainbow'];
function weatherLoop(room) {
  clearTimeout(room.wxT);
  room.wxT = setTimeout(() => {
    if (!rooms.has(room.code)) return;
    if (!room.paused && room.phase !== 'lobby') {
      room.weather = { kind: pick(WX_KINDS), seed: Math.floor(Math.random() * 2 ** 31) };
      blast(room, [Object.assign({ type: 'weather', seat: Math.floor(Math.random() * 4) }, room.weather)]);
    }
    weatherLoop(room);
  }, 150000 + Math.random() * 150000);
}

// ---------- Ход игры ----------
function startMatch(room) {
  const free = Object.keys(CHARS).filter((c) => !KL.CHAR[c].boss && !room.seats.some((s) => s && s.char === c)).sort(() => Math.random() - .5);
  room.seats.forEach((s, i) => { if (!s) { const c = free.shift() || pick(Object.keys(CHARS)); room.seats[i] = { name: CHARS[c] + ' (бот)', char: c, xp: Math.floor(Math.random() * 4000), bot: true, conns: new Set() }; } });
  room.match = K.newMatch(room.mode === 'turbo' ? 6 : 12);
  startRound(room);
  if (!room.sceneT) sceneLoop(room);
  if (!room.findT) findLoop(room);
  if (!room.coinT) coinLoop(room);
  if (!room.wxT) { room.weather = { kind: pick(['clear', 'clear', 'cloudy', 'drizzle']), seed: Math.floor(Math.random() * 2 ** 31) }; weatherLoop(room); }
}
function startRound(room) {
  room.round = K.newRound(room.match); room.round.honest = !!room.honest;
  room.bomzhAt = Math.random() < .75 ? 2 + Math.floor(Math.random() * 5) : -1; // бомж заходит примерно раз в две раздачи
  room.voids = [];
  room.phase = 'playing';
  const evs = [{ type: 'deal' }];
  const h = room.round.hvalSeat;
  if (Math.random() < .45) evs.push({ type: 'talk', seat: Math.floor(Math.random() * 4), text: KL.gorl('start'), delay: 1200 });
  else if (room.seats[h].bot && Math.random() < .6) evs.push({ type: 'talk', seat: h, text: pick(LINES.hval) });
  schedule(room, 1600);
  broadcast(room, evs);
}

function schedule(room, delay) {
  if (room.phase === 'closing' || room.paused || room.undo) return; // у последней предъявы свой таймер
  clearTimeout(room.timer);
  const r = room.round;
  if (room.phase !== 'playing' || !r || r.over) { room.deadline = 0; return; }
  const s = room.seats[r.turn];
  const afterHuman = room.undoSnap && room.round.log.length === room.undoSnap.logLen && Date.now() - room.undoSnap.at < 3000;
  if (s.bot) { room.deadline = 0; room.timer = setTimeout(() => botAct(room), delay + BOT_DELAY + (afterHuman ? 1600 : 0) + botStyle(s.char).think * (.6 + Math.random() * .8)); return; }
  const limit = s.conns.size ? (room.mode === 'turbo' ? 45000 : TURN_MS) : AWAY_TURN_MS;
  room.deadline = Date.now() + delay + limit;
  // подколы живому: «Голова, твой выход!» и если долго думает
  const who = r.turn, logN = r.log.length, other = () => pick([0, 1, 2, 3].filter((i) => i !== who));
  clearTimeout(room.slowT);
  if (Math.random() < .1) setTimeout(() => { if (room.round === r && r.turn === who && r.log.length === logN) broadcast(room, [{ type: 'talk', seat: other(), text: KL.gorl('yourTurn', s.name) }]); }, delay + 1200);
  room.slowT = setTimeout(() => { if (room.round === r && r.turn === who && r.log.length === logN && !room.paused && !room.undo && Math.random() < .7) { const sp = other(); broadcast(room, [{ type: 'talk', seat: sp, text: KL.slowLine(room.seats, sp) }]); } }, delay + 28000);
  room.timer = setTimeout(() => timeoutAct(room), delay + limit);
}

function doPlay(room, seat, cardId) {
  const r = room.round;
  const ledCard = r.trick.length ? r.trick[0].card : null;
  const res = K.play(room.match, r, seat, cardId);
  const entry = r.log[r.log.length - 1];
  const evs = [{ type: 'play', seat, card: entry.card }];
  if (ledCard) {
    const led = K.effSuit(ledCard, r.trump);
    if (K.effSuit(entry.card, r.trump) !== led) room.voids.push({ seat, suit: led, trickNo: entry.trickNo, used: false });
  }
  // Боты замечают крысятничество по тому, что видно на столе
  let delay = 0;
  const suit = K.effSuit(entry.card, r.trump);
  const ev = room.voids.find((v) => !v.used && v.seat === seat && v.suit === suit && v.trickNo < entry.trickNo);
  if (ev) {
    ev.used = true;
    const judges = [0, 1, 2, 3].filter((b) => room.seats[b].bot && K.teamOf(b) !== K.teamOf(seat));
    const prev = r.log.find((x) => x.trickNo === ev.trickNo && x.seat === seat);
    const sharp = judges.slice().sort((a, b) => botStyle(room.seats[b].char).catch - botStyle(room.seats[a].char).catch);
    if (judges.length && !prev.checked && Math.random() < botStyle(room.seats[sharp[0]].char).catch) {
      const judge = Math.random() < .7 ? sharp[0] : pick(judges);
      evs.push(verdictEvent(room, judge, ev.trickNo, seat, entry.card));
      delay = AFTER_VERDICT;
    }
  }
  if (!r.over && res.trickDone) {
    evs.push({ type: 'trick', winner: res.winner, points: room.mode !== 'hard' ? res.points : null });
    chatter(room, evs, res);
    delay = Math.max(delay, AFTER_TRICK);
  } else if (r.over && res.trickDone && r.end.type === 'cards') {
    evs.push({ type: 'trick', winner: res.winner, points: room.mode !== 'hard' ? res.points : null });
    chatter(room, evs, res);
  }
  if (res.trickDone && room.mode !== 'hard' && !room.noEmo) { const m = checkMayak(room, res); if (m) evs.push(m); }
  if (r.over) evs.push(endRound(room));
  else if (r.closing && room.honest) { K.finishRound(room.match, r); evs.push(endRound(room)); }
  else if (r.closing) { startClosing(room, delay); evs.push({ type: 'closing' }); broadcast(room, evs); return; }
  schedule(room, delay);
  broadcast(room, evs);
}

// Последняя предъява: все карты сыграны, но счёт ещё не подбит
function startClosing(room, delay) {
  clearTimeout(room.timer);
  room.phase = 'closing';
  room.ready = new Set(room.seats.map((s, i) => (s.bot ? i : -1)).filter((i) => i >= 0));
  room.deadline = Date.now() + delay + CLOSE_MS;
  room.timer = setTimeout(() => finalize(room), delay + CLOSE_MS);
}
function finalize(room) {
  if (room.phase !== 'closing' || !room.round) return;
  clearTimeout(room.timer);
  K.finishRound(room.match, room.round);
  broadcast(room, [endRound(room)]);
}

// Кто за столом: персонаж, имя без «(бот)», бот или нет
const seatsInfo = (room) => room.seats.map((s) => (s ? { char: s.char, name: s.name.replace(' (бот)', ''), bot: !!s.bot } : null));
const GESTURE_MS = 15000;
const GESTURES = ['wink', 'clap', 'fuck'];
// Реплики после взятки (за всех, включая живых: это дворовой юмор) + жесты ботов + Витя Гудок
function chatter(room, evs, res) {
  const r = room.round, t = r.tricks[r.tricks.length - 1];
  const lines = KL.chatter(t.plays, res.winner, r.trump, res.points, K, seatsInfo(room), r.hands);
  lines.forEach((c) => evs.push({ type: 'talk', seat: c.seat, text: c.text, delay: c.delay || 0 }));
  const now = Date.now(), bot = (i) => room.seats[i] && room.seats[i].bot;
  const gest = (i, g, delay) => { const s = room.seats[i]; s.gest = s.gest || {}; if (now - (s.gest[g] || 0) < GESTURE_MS) return; s.gest[g] = now; evs.push({ type: 'gesture', seat: i, g, delay }); };
  if (res.points >= 25 && Math.random() < .45) {
    const enemies = [0, 1, 2, 3].filter((i) => K.teamOf(i) !== K.teamOf(res.winner) && bot(i));
    const mate = (res.winner + 2) % 4;
    const x = Math.random();
    if (x < .35 && enemies.length) gest(enemies[Math.floor(Math.random() * enemies.length)], 'fuck', 1500);
    else if (x < .7 && bot(mate)) gest(mate, 'clap', 900);
    else if (bot(res.winner)) gest(res.winner, 'wink', 700);
  }
  if ((KL.LOCMETA[room.loc] || {}).out && room.bomzhAt === r.tricks.length && !r.closing && !r.over) {
    const b = KL.bomzh(seatsInfo(room), r.hands, r.trump);
    evs.push({ type: 'bomzh', text: b.text, seat: b.reply.seat, reply: b.reply.text, delay: 2500 });
  }
}

function verdictEvent(room, accuser, trickNo, accused, evidenceCard) {
  const r = room.round;
  const res = K.accuse(room.match, r, accuser, trickNo, accused);
  const e = r.log.find((x) => x.trickNo === trickNo && x.seat === accused);
  const ledEntry = r.log.find((x) => x.trickNo === trickNo); // первая карта этой взятки
  return { type: 'verdict', accuser, accused, trickNo, guilty: res.guilty, team: res.team, card: e.card,
    suit: K.effSuit(ledEntry.card, r.trump), evidence: evidenceCard || null,
    talk: room.seats[accused].bot ? pick(res.guilty ? LINES.caught : LINES.clean) : null };
}

// Маяки. Хардкор: во время раздачи смайлы и жесты закрыты.
// Лайт и Турбо: если живой игрок маякнул (смайл или жест) в этой или прошлой взятке,
// а живой кореш после этого накинул ему туза или десятку (не козырь) во взятку, которую тот забрал, команде 1 штрафная (раз за раздачу).
const signalBlocked = (room) => (room.mode === 'hard' || room.noEmo) && room.phase === 'playing';
function markSignal(room, s) {
  if (room.phase !== 'playing' || !room.round || s.bot) return;
  s.sig = { r: room.round, trick: room.round.tricks.length, n: room.round.log.length }; // сигнал только этой раздачи
}
function checkMayak(room, res) {
  const r = room.round, w = res.winner, mate = (w + 2) % 4, W = room.seats[w], M = room.seats[mate];
  if (!W || !M || W.bot || M.bot || !W.sig || W.sig.r !== r) return null;
  r.mayak = r.mayak || [];
  if (r.mayak.includes(K.teamOf(w))) return null;
  const done = r.tricks.length - 1; // индекс только что сыгранной взятки
  if (W.sig.trick < done - 1) return null;
  const i = r.log.findIndex((e, k) => k >= W.sig.n && e.seat === mate && e.trickNo === done);
  if (i < 0) return null;
  const card = r.log[i].card;
  if (card.points < 10 || K.isTrump(card, r.trump)) return null;
  r.mayak.push(K.teamOf(w));
  W.sig = null;
  // без штрафа: только свист, обзывалки и какашки в маякнувшего
  const opp = [0, 1, 2, 3].filter((i) => K.teamOf(i) !== K.teamOf(w));
  return { type: 'mayak', seat: w, mate, card, team: K.teamOf(w), by: pick(opp), seed: Math.floor(Math.random() * 2 ** 31) };
}

function endRound(room) {
  if (K.matchLoser(room.match) !== null) { // конец матча: победители подкалывают
    const L = K.matchLoser(room.match), w = [0, 1, 2, 3].filter((i) => K.teamOf(i) !== L), l = [0, 1, 2, 3].filter((i) => K.teamOf(i) === L);
    setTimeout(() => broadcast(room, [{ type: 'talk', seat: pick(w), text: KL.gorl('win', room.seats[pick(l)].name.replace(' (бот)', '')) }]), 2500);
  }
  room.undoSnap = null; if (room.undo) { clearTimeout(room.undoT); room.undo = null; }
  room.paused = null; clearTimeout(room.pauseT);
  const m = room.match;
  room.phase = K.matchLoser(m) === null ? 'roundEnd' : 'matchEnd';
  room.deadline = 0;
  return { type: 'roundEnd' };
}

function botAct(room) {
  const r = room.round;
  if (!r || r.over || room.phase !== 'playing' || room.paused || room.undo || !room.seats[r.turn].bot) return;
  try { doPlay(room, r.turn, botMove(r, r.turn, botStyle(room.seats[r.turn].char))); } catch (e) { console.error('bot', e); }
}
function timeoutAct(room) {
  const r = room.round;
  if (!r || r.over || room.phase !== 'playing' || room.paused || room.undo) return;
  const s = r.turn;
  const legal = K.legalCards(r.hands[s], r.trick.map((e) => e.card), r.trump);
  const led = r.trick.length ? K.effSuit(r.trick[0].card, r.trump) : null;
  const pw = (c) => K.power(c, r.trump, led || c.suit);
  const c = legal.reduce((a, b) => (a.points < b.points || (a.points === b.points && pw(a) < pw(b)) ? a : b));
  broadcast(room, [{ type: 'talk', seat: (s + 2) % 4, text: 'Уснул? Сходили за тебя', toSeat: s }]);
  doPlay(room, s, c.id);
}

// Боты играют просто и иногда лезут на трояк
// характер бота: как часто крысит, как часто ловит, сколько думает (lines.js CHAR[].style)
function botStyle(ch) { return Object.assign({ cheat: .18, catch: .75, think: 0 }, (KL.CHAR[ch] && KL.CHAR[ch].style) || {}); }
function botMove(r, s, st) {
  st = st || botStyle(null);
  const hand = r.hands[s];
  const trickCards = r.trick.map((e) => e.card);
  const legal = K.legalCards(hand, trickCards, r.trump);
  if (!trickCards.length) {
    const t = legal.filter((c) => !K.isTrump(c, r.trump));
    return (t.length ? t : legal).reduce((a, b) => (a.points > b.points ? a : b)).id;
  }
  const led = K.effSuit(trickCards[0], r.trump);
  const cur = K.trickWinner(trickCards, r.trump);
  const pw = (c) => K.power(c, r.trump, led);
  const best = pw(trickCards[cur]);
  const partnerWins = K.teamOf(r.trick[cur].seat) === K.teamOf(s);
  const onTable = trickCards.reduce((x, c) => x + c.points, 0);
  if (!r.honest && !partnerWins && onTable >= (st.cheat > .3 ? 4 : 10) && legal.length < hand.length && Math.random() < st.cheat) {
    const cheat = hand.filter((c) => !legal.includes(c) && pw(c) > best);
    if (cheat.length) return cheat.reduce((a, b) => (pw(a) < pw(b) ? a : b)).id;
  }
  if (partnerWins) {
    const plain = legal.filter((c) => !K.isTrump(c, r.trump));
    return (plain.length ? plain : legal).reduce((a, b) => (a.points >= b.points ? a : b)).id;
  }
  if (st.wild && Math.random() < st.wild) return legal[Math.floor(Math.random() * legal.length)].id; // по вдохновению
  const win = legal.filter((c) => pw(c) > best);
  if (win.length && (onTable >= 10 || (st.trumps && onTable >= 3) || r.trick.length === 3)) return win.reduce((a, b) => (pw(a) < pw(b) ? a : b)).id;
  return legal.reduce((a, b) => (a.points < b.points || (a.points === b.points && pw(a) < pw(b)) ? a : b)).id;
}

// ---------- Забрать карту обратно (если все не против) ----------
// Можно, пока после твоей карты никто не ходил и прошло не больше 15 секунд
function canUndo(room, seat) {
  const u = room.undoSnap;
  return !!(u && u.seat === seat && room.phase === 'playing' && room.round && !room.round.over && room.round.log.length === u.logLen && Date.now() - u.at < 15000 && !room.paused);
}
function undoYes(room) {
  const u = room.undoSnap, seat = room.undo.seat;
  clearTimeout(room.undoT); room.undo = null; room.undoSnap = null;
  room.round = u.round; room.match = u.match; room.voids = u.voids;
  broadcast(room, [{ type: 'undoDone', seat }, { type: 'talk', seat, text: pick(['Спасибо, пацаны, по-братски', 'Должен буду', 'Всё, теперь нормально кину']) }]);
  schedule(room, 0);
}
function undoNo(room, by) {
  if (!room.undo) return;
  const seat = room.undo.seat;
  clearTimeout(room.undoT); room.undo = null; room.undoSnap = null;
  broadcast(room, [{ type: 'undoNo', seat, by }].concat(by !== null ? [{ type: 'talk', seat: by, text: pick(['Не, кинул так кинул', 'Карта легла, всё', 'Нет! Думать надо было']) }] : []));
  schedule(room, 300);
}

// ---------- Пауза для всех: таймеры стоят, боты ждут ----------
function pauseRoom(room, seat) {
  if (room.paused) return;
  clearTimeout(room.timer);
  const now = Date.now();
  room.paused = { by: seat, at: now, left: room.deadline ? Math.max(3000, room.deadline - now) : 0 };
  room.deadline = 0;
  clearTimeout(room.pauseT); room.pauseT = setTimeout(() => resumeRoom(room, seat), 10 * 60000); // сама снимется через 10 минут
  broadcast(room, [{ type: 'talk', seat, text: pick(['Пацаны, передых!', 'Стоп игра, щас вернусь', 'Пауза, братва', 'Тайм-аут!']) }]);
}
function resumeRoom(room, seat) {
  const p = room.paused;
  if (!p) return;
  room.paused = null; clearTimeout(room.pauseT);
  const now = Date.now();
  if (room.phase === 'closing') {
    room.deadline = now + (p.left || CLOSE_MS);
    room.timer = setTimeout(() => finalize(room), room.deadline - now);
  } else if (room.phase === 'playing' && room.round && !room.round.over) {
    const cur = room.seats[room.round.turn];
    if (cur && !cur.bot && p.left) { room.deadline = now + p.left; room.timer = setTimeout(() => timeoutAct(room), p.left); }
    else schedule(room, 600);
  }
  broadcast(room, [{ type: 'talk', seat, text: pick(['Погнали дальше', 'Всё, играем', 'Продолжаем, пацаны']) }]);
}

// ---------- Действия игроков ----------
function act(room, seat, body) {
  if (room.game === 'bil') return bilAct(room, seat, body);
  const s = room.seats[seat];
  const abs = (rel) => (Number(rel) + seat) % 4;
  if (room.paused && ['play', 'accuse', 'ready'].includes(body.type)) throw new Error('Передых: сначала снимите паузу');
  if (room.undo && ['play', 'accuse', 'ready', 'pause'].includes(body.type)) throw new Error('Идёт голосование: забрать карту или нет');
  switch (body.type) {
    case 'pause': {
      if (room.phase !== 'playing' && room.phase !== 'closing') throw new Error('Пауза только во время игры');
      if (body.on === false || room.paused) resumeRoom(room, seat); else pauseRoom(room, seat);
      return;
    }
    case 'sit': {
      if (room.phase !== 'lobby') throw new Error('Игра уже идёт');
      const to = abs(body.seat);
      if (room.seats[to]) throw new Error('Место занято');
      room.seats[to] = s; room.seats[seat] = null;
      if (room.host === seat) room.host = to;
      broadcast(room, [{ type: 'lobby' }]);
      return;
    }
    case 'start':
      if (room.phase !== 'lobby') throw new Error('Игра уже идёт');
      if (seat !== room.host) throw new Error('Начинает хозяин стола');
      { const poor = room.seats.filter((x) => x && !x.bot && !canPay(room, x)); if (poor.length) throw new Error('На ставку не хватает у: ' + poor.map((x) => x.name).join(', ')); }
      startMatch(room);
      return;
    case 'play':
      if (room.phase !== 'playing') throw new Error('Сейчас не играем');
      if (room.honest) {
        const r = room.round, c = r && r.turn === seat && K.legalCards(r.hands[seat], r.trick.map((e) => e.card), r.trump).find((x) => x.id === String(body.card));
        if (r && r.turn === seat && !c) throw new Error('Честняк: масть есть, клади масть');
      }
      // снимок до хода: вдруг попросит забрать карту обратно
      room.undoSnap = { seat, at: Date.now(), round: structuredClone(room.round), match: structuredClone(room.match), voids: structuredClone(room.voids), logLen: room.round.log.length + 1, card: String(body.card) };
      doPlay(room, seat, String(body.card));
      return;
    case 'undoAsk': {
      if (!canUndo(room, seat)) throw new Error('Поздно, карту уже не забрать');
      if (room.undo) return;
      clearTimeout(room.timer); room.deadline = 0;
      room.undo = { seat, votes: new Set([seat, ...room.seats.map((x, i) => (x && x.bot ? i : -1)).filter((i) => i >= 0)]) };
      room.undoT = setTimeout(() => undoNo(room, null), 20000);
      const card = room.undoSnap.round.hands[seat].find((c) => c.id === room.undoSnap.card);
      broadcast(room, [{ type: 'talk', seat, text: pick(['Пацаны, не ту кинул! Можно назад?', 'Ой, рука соскочила. Верните карту?', 'Стоп-стоп, не та карта! Можно переиграть?']) }, { type: 'undoAsk', seat, card }]);
      if (room.undo.votes.size >= 4) undoYes(room);
      return;
    }
    case 'undoVote': {
      if (!room.undo || room.undo.votes.has(seat)) return;
      if (!body.yes) return undoNo(room, seat);
      room.undo.votes.add(seat);
      if (room.undo.votes.size >= 4) undoYes(room); else broadcast(room, [{ type: 'talk', seat, text: pick(['Да ладно, забирай', 'Пусть забирает', 'Окей, без базара']) }]);
      return;
    }
    case 'accuse': {
      if (room.honest) throw new Error('Честняк: предъявлять некому');
      if (room.phase !== 'playing' && room.phase !== 'closing') throw new Error('Сейчас не играем');
      const closing = room.phase === 'closing';
      const ev = verdictEvent(room, seat, Number(body.trickNo), abs(body.seat), null);
      const evs = [ev];
      if (room.round.over || K.matchLoser(room.match) !== null) {
        room.round.over = true; room.round.closing = false; if (!room.round.end) room.round.end = { type: 'penalty' };
        clearTimeout(room.timer); evs.push(endRound(room));
      } else if (closing) {
        // зря предъявили в конце: окно продолжается, даём время прочитать вердикт
        if (room.ready) room.ready.delete(seat);
        room.deadline = Math.max(room.deadline, Date.now() + AFTER_VERDICT + 6000);
        clearTimeout(room.timer); room.timer = setTimeout(() => finalize(room), room.deadline - Date.now());
        broadcast(room, evs);
        return;
      } else schedule(room, AFTER_VERDICT);
      broadcast(room, evs);
      return;
    }
    case 'ready': {
      if (room.phase !== 'closing') return;
      room.ready.add(seat);
      if (room.seats.every((x, i) => room.ready.has(i) || (x && !x.bot && !x.conns.size))) return finalize(room);
      broadcast(room, [{ type: 'talk', seat, text: pick(['Чисто, считаем', 'Всё ровно, подбивай', 'Претензий нет', '<i>*кивает: считаем*</i>']) }]);
      return;
    }
    case 'loc': {
      // хозяин стола выбирает место: в лобби и между раздачами
      if (seat !== room.host) throw new Error('Место выбирает хозяин стола');
      if (!['lobby', 'roundEnd', 'matchEnd'].includes(room.phase)) throw new Error('Пересядем после раздачи');
      if (!KL.LOC_IDS.includes(body.loc)) throw new Error('Нет такого места');
      room.loc = body.loc;
      broadcast(room, [{ type: room.phase === 'lobby' ? 'lobby' : 'talk', seat, text: '<i>*пересаживает всех: ' + { baza: 'на БАЗУ', yard: 'во двор', office: 'в кабинет', space: 'в космос', cherem: 'на Черёмушки', korolenko: 'на Короленко', stroy: 'на Строитель', centr: 'в Центр', vodokanal: 'на Водоканал' }[body.loc] + '*</i>' }]);
      return;
    }
    case 'opts': { // хозяин в лобби меняет режим, честняк, смайлы и ставку
      if (seat !== room.host) throw new Error('Это решает хозяин стола');
      if (room.phase !== 'lobby') throw new Error('Игра уже идёт');
      if (body.mode !== undefined) room.mode = ['lite', 'turbo'].includes(body.mode) ? body.mode : 'hard';
      if (body.honest !== undefined) room.honest = !!body.honest;
      if (body.noEmo !== undefined) room.noEmo = !!body.noEmo;
      if (body.stake !== undefined) room.stake = KC.STAKES[body.stake] ? Number(body.stake) : 0;
      broadcast(room, [{ type: 'lobby' }]);
      return;
    }
    case 'prank': { // админ за столом прикалывается прямо из игры
      if (!s.acct || s.acct !== KL.ADMIN) throw new Error('Это не для тебя, братан');
      if (Date.now() - (s.prankAt || 0) < 250) return;
      s.prankAt = Date.now();
      prankRoom(room, abs(body.seat), String(body.kind || ''), String(body.text || '').replace(/[<>]/g, '').slice(0, 140));
      return;
    }
    case 'bal': // сколько у игрока семок и гривен (для ставки)
      s.bal = { semki: Math.max(0, Number(body.semki) || 0), uah: Math.max(0, Number(body.uah) || 0) };
      if (room.phase === 'lobby') broadcast(room, []);
      return;
    case 'next':
      if (room.phase !== 'roundEnd') return;
      startRound(room);
      return;
    case 'rematch':
      if (room.phase !== 'matchEnd') return;
      room.match = K.newMatch(room.mode === 'turbo' ? 6 : 12);
      startRound(room);
      return;
    case 'xp':
      s.xp = xpOk(body.xp);
      broadcast(room, []);
      return;
    case 'gesture': {
      if (signalBlocked(room)) throw new Error(room.mode === 'hard' ? 'Хардкор: маяки запрещены, жесты между раздачами' : 'Смайлы за этим столом только между раздачами');
      const g = String(body.g);
      if (!GESTURES.includes(g)) throw new Error('Нет такого жеста');
      const now = Date.now();
      s.gest = s.gest || {};
      if (now - (s.gest[g] || 0) < GESTURE_MS) return;
      s.gest[g] = now;
      markSignal(room, s);
      broadcast(room, [{ type: 'gesture', seat, g }]);
      return;
    }
    case 'say': { // реплика, которую придумал чей-то браузер: показываем всем одну и ту же
      const now = Date.now();
      if (now - (s.sayAt || 0) < 400) return;
      s.sayAt = now;
      const to = (Number(body.seat) + seat) % 4, text = String(body.text || '').replace(/<(?!\/?i>)[^>]*>/g, '').slice(0, 200);
      if (!(to >= 0 && to < 4) || !room.seats[to] || !text) return;
      blast(room, [{ type: 'talk', seat: to, text }]);
      return;
    }
    case 'peek': { // открыл журнал или «Предъявить»: «кто пасёт...»
      const now = Date.now();
      if (now - (room.peekAt || 0) < 30000 || Math.random() > .5) return;
      room.peekAt = now;
      broadcast(room, [{ type: 'talk', seat: pick([0, 1, 2, 3].filter((i) => K.teamOf(i) !== K.teamOf(seat))), text: KL.gorl('peek') }]);
      return;
    }
    case 'grab':
      grabFind(room, Number(body.id), seat);
      return;
    case 'mic': {
      const on = !!body.on, now = Date.now();
      if (on === !!s.mic) return;
      s.mic = on; s.micAt = now;
      blast(room, [{ type: 'mic', seat, on }]);
      return;
    }
    case 'emote': {
      const i = Number(body.i);
      if (!EMOTES[i]) throw new Error('Нет такой эмоции');
      if (signalBlocked(room)) throw new Error(room.mode === 'hard' ? 'Хардкор: маяки запрещены, смайлы между раздачами' : 'Смайлы за этим столом только между раздачами');
      const now = Date.now();
      if (s.lastEmote && now - s.lastEmote < 1500) return;
      s.lastEmote = now;
      markSignal(room, s);
      broadcast(room, [{ type: 'talk', seat, text: EMOTES[i] }]);
      return;
    }
    case 'leave':
      if (room.phase === 'lobby') {
        room.seats[seat] = null;
        if (!humans(room).length) { rooms.delete(room.code); return; }
        if (room.host === seat) room.host = room.seats.findIndex((x) => x && !x.bot);
        broadcast(room, [{ type: 'lobby' }]);
      } else {
        // посреди игры место занимает бот, чтобы партия не встала
        room.seats[seat] = { name: s.name + ' (бот)', char: s.char, bot: true, conns: new Set(), was: { token: s.token, acct: s.acct || null, name: s.name } };
        for (const res of s.conns) res.end();
        if (!humans(room).length) { clearTimeout(room.timer); rooms.delete(room.code); return; }
        if (room.host === seat) room.host = room.seats.findIndex((x) => x && !x.bot);
        if (room.ready) room.ready.add(seat);
        broadcast(room, [{ type: 'talk', seat, text: '<i>*свалил, за него бот*</i>' }]);
        schedule(room, 0);
      }
      return;
    default:
      throw new Error('Непонятное действие');
  }
}

// ---------- Приколы админа над пацанами (только внешний вид, на игру не влияют) ----------
const PRANKS = ['say', 'babka', 'tomato', 'goat', 'flip', 'gudok', 'quake', 'rain', 'fart', 'slap', 'bird', 'call', 'coins', 'drunk', 'bighead', 'fly', 'shout', 'king'];
function prankRoom(room, seat, kind, text) {
  if (!PRANKS.includes(kind)) throw new Error('Нет такого прикола');
  if (!room.seats[seat]) throw new Error('Там никто не сидит');
  if ((kind === 'say' || kind === 'babka' || kind === 'gudok' || kind === 'shout') && !text) throw new Error('Напиши, шо сказать');
  if (kind === 'rain') { room.weather = { kind: 'storm', seed: Date.now() % 1e6 }; blast(room, [{ type: 'weather', kind: 'storm', seed: room.weather.seed, seat }]); }
  else if (kind === 'coins') { if (room.phase !== 'playing') throw new Error('Монеты сыпем, пока идёт раздача'); coinRain(room, 6 + Math.floor(Math.random() * 4)); blast(room, [{ type: 'prank', kind, seat, text: '', name: room.seats[seat].name, seed: Date.now() % 1e6 }]); }
  else blast(room, [{ type: 'prank', kind, seat, text, name: room.seats[seat].name, seed: Date.now() % 1e6 }]);
}
function prank(admin, b) {
  const kind = String(b.kind || ''), text = String(b.text || '').replace(/[<>]/g, '').slice(0, 140);
  const key = A.keyOf(b.to);
  for (const room of rooms.values()) {
    const seat = room.seats.findIndex((x) => x && !x.bot && x.acct === key && x.conns.size);
    if (seat < 0) continue;
    prankRoom(room, seat, kind, text);
    return { ok: true, code: room.code };
  }
  throw new Error('Этот пацан сейчас не за столом');
}

// За каким столом сидит человек с аккаунтом key (для «Двора»)
function tableOf(key) {
  for (const room of rooms.values()) {
    const s = room.seats.find((x) => x && !x.bot && x.acct === key && x.conns.size);
    if (s) return { code: room.code, phase: room.phase, mode: room.mode, game: room.game || 'kozel', free: room.seats.filter((x) => !x || (room.phase !== 'lobby' && x.bot)).length };
  }
  return null;
}

// ======================= 🎱 Бильярдная по сети =======================
// Партия считается здесь (billiard.js), браузеры получают удар и сами его прокручивают (расчёт одинаковый), а потом сверяются с итогом.
const OWN6 = ['oleg', 'dantl', 'lysy', 'elvis', 'vitaha', 'zema'];
const BIL_HALLS = KB.HALLS.filter((h) => !h.soon).map((h) => h.id);
function createBilRoom(b, u) {
  const code = newCode(), n = Number(b.size) === 4 ? 4 : 2;
  const room = { game: 'bil', code, phase: 'lobby', seats: new Array(n).fill(null), host: 0, hall: BIL_HALLS.includes(b.hall) ? b.hall : 'bellagio',
    variant: KB.VARIANTS[b.variant] ? b.variant : 'free', botLevel: Math.max(0, Math.min(2, Number(b.botLevel) || 1)), g: null, shotId: 0, touched: Date.now() };
  rooms.set(code, room);
  const tok = token(), acct = u ? A.keyOf(u.nick) : null, cc = charOk(b.char, acct, room);
  room.seats[0] = { token: tok, name: clean(b.name) || CHARS[cc], char: cc, xp: xpOk(u ? u.xp : b.xp), bot: false, conns: new Set(), acct };
  return { room, tok, seat: 0 };
}
function bilView(room, my) {
  const n = room.seats.length, R = (a) => (a - my + n) % n, t = my % 2, g = room.g;
  const v = { game: 'bil', code: room.code, phase: room.phase, host: R(room.host), hall: room.hall, variant: room.variant, size: n, botLevel: room.botLevel, now: Date.now(),
    seats: room.seats.map((_, i) => room.seats[(i + my) % n]).map((s) => (s ? { name: s.name, bot: s.bot, char: s.char, xp: s.xp || 0, online: s.bot || s.conns.size > 0, level: s.level } : null)) };
  if (g) {
    v.g = { state: g.state, turn: R(g.turn), score: [g.score[t], g.score[1 - t]], hand: g.hand, over: g.over, winner: g.winner === null ? null : (g.winner - t + 2) % 2, shots: g.shots, deadline: room.deadline || 0 };
    if (g.last) v.last = { id: room.shotId, seat: R(g.last.seat), shot: g.last.shot, place: g.last.place || null, before: g.last.before, judge: g.last.judge };
    v.taken = room.taken ? room.seats.map((_, i) => room.taken[(i + my) % n]) : null;
  }
  return v;
}
// лут бильярдной: раз в 30-55 с на ковре или борту, кто первый тыкнул
function bilFindLoop(room) {
  clearTimeout(room.findT);
  room.findT = setTimeout(() => {
    if (!rooms.has(room.code)) return;
    if (room.phase === 'playing' && room.seats.some((x) => x && !x.bot && x.conns.size)) dropFind(room, Object.assign({ id: findSeq++, seed: Math.floor(Math.random() * 2 ** 31) }, KB.rollBilFind()), 30000);
    bilFindLoop(room);
  }, Number(process.env.FIND_MS) || 30000 + Math.random() * 25000);
}
const bilLevel = (s) => (s.char === 'zema' ? 2 : s.level);
function bilStart(room) {
  const used = new Set(room.seats.filter(Boolean).map((x) => x.char)), free = OWN6.filter((c) => !used.has(c)).sort(() => Math.random() - .5);
  room.seats.forEach((s, i) => { if (!s) { const c = free.shift() || pick(OWN6); room.seats[i] = { name: CHARS[c] + ' (бот)', char: c, xp: Math.floor(Math.random() * 4000), bot: true, conns: new Set(), level: c === 'zema' ? 2 : room.botLevel }; } });
  room.g = KB.newGame(room.seats.length, room.variant, Math.floor(Math.random() * 2 ** 31));
  room.taken = room.seats.map(() => 0);
  room.phase = 'playing'; room.shotId = 0;
  if (!room.findT) bilFindLoop(room);
  const L = KB.LINES;
  broadcast(room, [{ type: 'bstart' }, { type: 'talk', seat: room.g.turn, text: pick(L.start), delay: 900 }]);
  bilSchedule(room, 1500);
}
// чей удар: бот бьёт сам, живой — 90 с (без связи — 15 с), потом за него бьёт бот
function bilSchedule(room, delay) {
  clearTimeout(room.timer);
  const g = room.g;
  if (!g || g.over || room.phase !== 'playing') { room.deadline = 0; return; }
  const s = room.seats[g.turn];
  const L = KB.BOT[bilLevel(s) || 0] || KB.BOT[1];
  const wait = s.bot ? delay + L.think[0] + Math.random() * (L.think[1] - L.think[0]) : delay + (s.conns.size ? 90000 : 15000);
  room.deadline = s.bot ? 0 : Date.now() + wait;
  room.timer = setTimeout(() => {
    if (!rooms.has(room.code) || room.g !== g || g.over) return;
    const shot = KB.botShot(g, s.bot ? bilLevel(s) : 0);
    bilShoot(room, g.turn, shot, !s.bot);
  }, wait);
}
function bilShoot(room, seat, shot, auto) {
  const g = room.g, L = KB.LINES;
  if (!g || g.over || g.turn !== seat) throw new Error('Сейчас не твой удар');
  const sh = { dx: Number(shot.dx) || 0, dy: Number(shot.dy) || 0, power: Math.max(0, Math.min(1, Number(shot.power) || 0)) };
  if (!sh.dx && !sh.dy) throw new Error('Куда бьёшь?');
  if (g.hand) sh.place = shot.place && { x: Number(shot.place.x), y: Number(shot.place.y) };
  const r = KB.applyShot(g, sh);
  if (!r.ok) throw new Error(r.error);
  g.last.place = sh.place || null;
  room.shotId++;
  const j = r.judge;
  room.taken[seat] += j.points;
  const evs = [{ type: 'bshot', id: room.shotId }];
  const line = KB.pickLine(j, r.sim.ev, g, seat, Math.random);
  if (line) evs.push({ type: 'talk', seat: line.who === 'me' ? seat : (seat + 1 + Math.floor(Math.random() * (room.seats.length - 1))) % room.seats.length, text: line.text, delay: Math.round(r.sim.ev.t * 1000) + 300 });
  if (auto) evs.push({ type: 'talk', seat, text: '<i>*долго думал, бот ударил за него*</i>' });
  if (g.over) { room.phase = 'over'; evs.push({ type: 'bover' }); }
  broadcast(room, evs);
  bilSchedule(room, Math.round(r.sim.ev.t * 1000) + 600);
}
function bilAct(room, seat, body) {
  const s = room.seats[seat], n = room.seats.length, abs = (rel) => (Number(rel) + seat) % n;
  switch (body.type) {
    case 'sit': {
      if (room.phase !== 'lobby') throw new Error('Игра уже идёт');
      const to = abs(body.seat);
      if (room.seats[to]) throw new Error('Место занято');
      room.seats[to] = s; room.seats[seat] = null;
      if (room.host === seat) room.host = to;
      return broadcast(room, [{ type: 'lobby' }]);
    }
    case 'opts': {
      if (seat !== room.host) throw new Error('Это решает хозяин стола');
      if (room.phase !== 'lobby') throw new Error('Игра уже идёт');
      if (KB.VARIANTS[body.variant]) room.variant = body.variant;
      if (body.botLevel !== undefined) room.botLevel = Math.max(0, Math.min(2, Number(body.botLevel) || 0));
      if (BIL_HALLS.includes(body.hall)) room.hall = body.hall;
      if (body.size !== undefined) {
        const want = Number(body.size) === 4 ? 4 : 2;
        if (want !== n) {
          const people = room.seats.filter(Boolean);
          if (people.length > want) throw new Error('За столом больше людей, чем мест');
          const hostP = room.seats[room.host];
          room.seats = new Array(want).fill(null); people.forEach((p, i) => { room.seats[i] = p; });
          room.host = room.seats.indexOf(hostP);
        }
      }
      return broadcast(room, [{ type: 'lobby' }]);
    }
    case 'start':
      if (room.phase !== 'lobby') throw new Error('Игра уже идёт');
      if (seat !== room.host) throw new Error('Начинает хозяин стола');
      return bilStart(room);
    case 'shot':
      if (room.phase !== 'playing') throw new Error('Сейчас не играем');
      return bilShoot(room, seat, body);
    case 'rematch':
      if (room.phase !== 'over') return;
      return bilStart(room);
    case 'say': {
      if (Date.now() - (s.sayAt || 0) < 400) return;
      s.sayAt = Date.now();
      const text = String(body.text || '').replace(/<(?!\/?i>)[^>]*>/g, '').slice(0, 200);
      if (text) blast(room, [{ type: 'talk', seat: abs(body.seat || 0), text }]);
      return;
    }
    case 'emote': {
      if (Date.now() - (s.emoAt || 0) < 1500) return;
      s.emoAt = Date.now();
      const k = Number(body.i); if (!(k >= 0 && k < 40)) return;
      blast(room, [{ type: 'emote', seat, i: k }]);
      return;
    }
    case 'leave':
      if (room.phase === 'lobby') {
        room.seats[seat] = null;
        if (!humans(room).length) { rooms.delete(room.code); return; }
        if (room.host === seat) room.host = room.seats.findIndex((x) => x && !x.bot);
        return broadcast(room, [{ type: 'lobby' }]);
      }
      room.seats[seat] = { name: s.name + ' (бот)', char: s.char, bot: true, conns: new Set(), level: 1, was: { token: s.token, acct: s.acct || null, name: s.name } };
      for (const res of s.conns) res.end();
      if (!humans(room).length) { clearTimeout(room.timer); rooms.delete(room.code); return; }
      if (room.host === seat) room.host = room.seats.findIndex((x) => x && !x.bot);
      broadcast(room, [{ type: 'talk', seat, text: '<i>*свалил, за него бот*</i>' }]);
      if (room.g && room.g.turn === seat) bilSchedule(room, 500);
      return;
    case 'xp':
      s.xp = xpOk(body.xp); return broadcast(room, []);
    case 'grab':
      grabFind(room, Number(body.id), seat); return;
    default:
      return; // остальное (маяки козла и т.п.) за бильярдом не нужно
  }
}

// ---------- HTTP ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e4) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(new Error('Плохой запрос')); } });
  });
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
const getRoom = (code) => rooms.get(String(code || '').toUpperCase().trim());

const INDEX = path.join(__dirname, 'client', 'index.html');
A.getCfg().then((c) => KL.setOwners(c.owners, c.all)).catch(() => {});
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // кто за кого из своих играет (меняется в «Админке»)
    if (req.method === 'GET' && url.pathname === '/api/cfg') { const c = await A.getCfg(); KL.setOwners(c.owners, c.all); return json(res, 200, { owners: KL.OWNERS, all: c.all || [] }); }
    // Админка: только аккаунт админа (проверка по токену входа)
    const adm = url.pathname.match(/^\/api\/admin\/(\w+)$/);
    if (req.method === 'POST' && adm) {
      const b = await readBody(req);
      try {
        if (adm[1] === 'state') { const st = await A.adminState(b); st.users.forEach((x) => { x.table = tableOf(x.key); }); return json(res, 200, st); }
        if (adm[1] === 'owners') { const r = await A.adminOwners(b); KL.setOwners(r.cfg.owners, r.cfg.all); return json(res, 200, r); }
        if (adm[1] === 'pin') return json(res, 200, await A.adminPin(b));
        if (adm[1] === 'prank') { const u = await A.admin(b); return json(res, 200, prank(u, b)); }
        return json(res, 404, { error: 'Нет такого' });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/ping') return json(res, 200, { ok: true, rooms: rooms.size, accounts: A.store.kind });
    // Аккаунты и «Двор»
    const ACCT = { register: A.register, login: A.login, me: A.me, save: A.save, logout: A.logout, yard: (b) => A.yard(b, tableOf), invite: (b) => A.invite(b, tableOf) };
    const am = url.pathname.match(/^\/api\/acct\/(\w+)$/);
    if (req.method === 'POST' && am && ACCT[am[1]]) {
      const b = await readBody(req);
      try { return json(res, 200, await ACCT[am[1]](b)); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/create') {
      const b = await readBody(req);
      const u = await A.userByToken(b.acct).catch(() => null);
      const { room, tok, seat } = b.game === 'bil' ? createBilRoom(b, u) : createRoom(b.name, b.mode, b.char, u ? u.xp : b.xp, u ? A.keyOf(u.nick) : null, b.loc, b.honest, b.emotes === false, b.stake);
      return json(res, 200, { code: room.code, token: tok, seat });
    }
    if (req.method === 'POST' && url.pathname === '/api/join') {
      const b = await readBody(req);
      const room = getRoom(b.code);
      if (!room) return json(res, 404, { error: 'Такого стола нет' });
      if (b.token && seatOf(room, b.token) >= 0) return json(res, 200, { code: room.code, token: b.token, seat: seatOf(room, b.token) });
      const u0 = await A.userByToken(b.acct).catch(() => null), ak = u0 ? A.keyOf(u0.nick) : null;
      // вернулся тот, кто свалил: отдаём его же место (та же команда), бота убираем
      let i = room.seats.findIndex((s) => s && s.bot && s.was && ((b.was && s.was.token === b.was) || (ak && s.was.acct === ak)));
      if (i < 0) i = room.seats.findIndex((s) => !s);
      if (i < 0 && room.phase !== 'lobby') i = room.seats.findIndex((s) => s && s.bot);
      if (i < 0) return json(res, 409, { error: 'Стол занят, мест нет' });
      const tok = token();
      const u = await A.userByToken(b.acct).catch(() => null);
      const cc = charOk(b.char, u ? A.keyOf(u.nick) : null, room);
      room.seats[i] = { token: tok, name: clean(b.name) || CHARS[cc], char: cc, xp: xpOk(u ? u.xp : b.xp), bot: false, conns: new Set(), acct: u ? A.keyOf(u.nick) : null };
      broadcast(room, [{ type: room.phase === 'lobby' ? 'lobby' : 'talk', seat: i, text: '<i>*подсел за стол*</i>' }]);
      return json(res, 200, { code: room.code, token: tok, seat: i });
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const room = getRoom(url.searchParams.get('code'));
      const seat = room ? seatOf(room, url.searchParams.get('token')) : -1;
      if (seat < 0) return json(res, 404, { error: 'Стол не найден' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      const s = room.seats[seat];
      s.conns.add(res);
      res.write('data: ' + JSON.stringify({ events: [], view: viewFor(room, seat), hello: true }) + '\n\n');
      broadcast(room, []);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(ping);
        s.conns.delete(res);
        if (rooms.get(room.code) === room) broadcast(room, []);
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      const b = await readBody(req);
      const room = getRoom(b.code);
      const seat = room ? seatOf(room, b.token) : -1;
      if (seat < 0) return json(res, 404, { error: 'Стол не найден' });
      act(room, seat, b);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(INDEX).pipe(res);
    }
    json(res, 404, { error: 'Не найдено' });
  } catch (e) {
    json(res, 400, { error: e.message || 'Ошибка' });
  }
});

// Перебранка за столом по сети: примерно раз в минуту кто-то кого-то цепляет
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase !== 'playing' || !room.round || room.round.over || room.paused) continue;
    if (!room.nextBanter) room.nextBanter = now + 40000 + Math.random() * 30000;
    if (now < room.nextBanter) continue;
    room.nextBanter = now + 50000 + Math.random() * 35000;
    const ctx = { pen: room.match.penalties, limit: room.match.limit };
    const wk = room.weather && room.weather.kind, wl = wk && wk !== 'clear' && Math.random() < .4 ? KL.wxLine(wk, seatsInfo(room)) : null;
    const evs = wl ? [{ type: 'talk', seat: wl.seat, text: wl.text }] : KL.banter(seatsInfo(room), ctx).map((c) => ({ type: 'talk', seat: c.seat, text: c.text, delay: c.delay || 0 }));
    if (evs.length) broadcast(room, evs);
  }
}, 3000);

// Старые пустые столы убираем
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyone = room.seats.some((s) => s && !s.bot && s.conns.size);
    if (!anyone && now - room.touched > ROOM_TTL) { clearTimeout(room.timer); rooms.delete(code); }
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => console.log('KOZEL сервер слушает порт ' + PORT));
module.exports = { server, rooms, checkMayak, markSignal };
