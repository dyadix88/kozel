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

function createRoom(name, mode, ch, xp, acct, loc, honest, noEmo) {
  const code = newCode();
  const room = { code, loc: ['baza', 'yard', 'office', 'space'].includes(loc) ? loc : 'baza', mode: ['lite', 'turbo'].includes(mode) ? mode : 'hard', phase: 'lobby', honest: !!honest, noEmo: !!noEmo, seats: [null, null, null, null], host: 0,
    match: null, round: null, voids: [], timer: null, deadline: 0, touched: Date.now() };
  rooms.set(code, room);
  const tok = token();
  const cc = charOk(ch, acct, room);
  room.seats[0] = { token: tok, name: clean(name) || CHARS[cc], char: cc, xp: xpOk(xp), bot: false, conns: new Set(), acct: acct || null };
  return { room, tok, seat: 0 };
}
const clean = (s) => String(s || '').replace(/[<>&"]/g, '').trim().slice(0, 14);

// ---------- Что видит конкретный игрок ----------
// Места поворачиваются так, что сам игрок всегда на месте 0, напарник на 2.
function viewFor(room, my) {
  const R = (a) => (a - my + 4) % 4;
  const rot = (arr) => [0, 1, 2, 3].map((r) => arr[(r + my) % 4]);
  const t = my % 2;
  const v = {
    code: room.code, phase: room.phase, mode: room.mode, honest: !!room.honest, noEmo: !!room.noEmo, paused: room.paused ? { by: R(room.paused.by) } : null, weather: room.weather || null, canUndo: canUndo(room, my), undo: room.undo ? { seat: R(room.undo.seat), votes: [...room.undo.votes].map(R), mine: room.undo.votes.has(my) } : null, loc: room.loc, host: R(room.host), now: Date.now(),
    seats: rot(room.seats).map((s) => (s ? { name: s.name, bot: s.bot, char: s.char, xp: s.xp || 0, online: s.bot || s.conns.size > 0 } : null)),
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
function convEvent(ev, my) {
  const e = Object.assign({}, ev);
  for (const k of ['seat', 'winner', 'accuser', 'accused', 'mate', 'by']) if (e[k] !== undefined) e[k] = (e[k] - my + 4) % 4;
  if (e.team !== undefined) e.team = (e.team - (my % 2) + 2) % 2;
  return e;
}
function broadcast(room, events) {
  room.touched = Date.now();
  room.seats.forEach((s, i) => {
    if (!s || s.bot || !s.conns.size) return;
    const msg = 'data: ' + JSON.stringify({ events: (events || []).map((e) => convEvent(e, i)), view: viewFor(room, i) }) + '\n\n';
    for (const res of s.conns) res.write(msg);
  });
}

// Лёгкие события без вида стола (рот по микрофону, общие сценки): клиент показывает сразу
function blast(room, events) {
  room.seats.forEach((s, i) => {
    if (!s || s.bot || !s.conns.size) return;
    const msg = 'data: ' + JSON.stringify({ fx: events.map((e) => convEvent(e, i)) }) + '\n\n';
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
      const kind = room.loc === 'yard' ? (r < .5 ? 'guest' : r < .8 ? 'babka' : 'neigh') : 'guest';
      blast(room, [{ type: 'scene', kind, seed: Math.floor(Math.random() * 2 ** 31), seat: Math.floor(Math.random() * 4) }]);
    }
    sceneLoop(room);
  }, 70000 + Math.random() * 60000);
}

// Находки во дворе: кто первый тыкнул, тот забрал. Боты тоже иногда подбирают
let findSeq = 1;
function findLoop(room) {
  clearTimeout(room.findT);
  room.findT = setTimeout(() => {
    if (!rooms.has(room.code)) return;
    if (room.phase === 'playing' && !room.paused && !room.find && room.seats.some((x) => x && !x.bot && x.conns.size)) {
      const f = Object.assign({ id: findSeq++, seed: Math.floor(Math.random() * 2 ** 31) }, KL.rollFind());
      room.find = f;
      blast(room, [Object.assign({ type: 'find' }, f)]);
      const bots = room.seats.map((x, i) => (x && x.bot ? i : -1)).filter((i) => i >= 0);
      if (bots.length && Math.random() < .4) setTimeout(() => grabFind(room, f.id, pick(bots)), 9000 + Math.random() * 13000);
      setTimeout(() => { if (room.find && room.find.id === f.id) { room.find = null; blast(room, [{ type: 'findGone', id: f.id }]); } }, 30000);
    }
    findLoop(room);
  }, Number(process.env.FIND_MS) || 90000 + Math.random() * 90000); // FIND_MS только для проверок
}
function grabFind(room, id, seat) {
  const f = room.find;
  if (!f || f.id !== id) return false;
  room.find = null;
  blast(room, [{ type: 'found', id, seat, item: f.item, qty: f.qty, rar: f.rar }]);
  return true;
}

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
  if (!room.wxT) { room.weather = { kind: pick(['clear', 'clear', 'cloudy', 'drizzle']), seed: Math.floor(Math.random() * 2 ** 31) }; weatherLoop(room); }
}
function startRound(room) {
  room.round = K.newRound(room.match); room.round.honest = !!room.honest;
  room.bomzhAt = Math.random() < .5 ? 2 + Math.floor(Math.random() * 5) : -1; // бомж заходит примерно раз в две раздачи
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
  if ((room.loc === 'yard' || room.loc === 'baza') && room.bomzhAt === r.tricks.length && !r.closing && !r.over) {
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
      if (!['baza', 'yard', 'office', 'space'].includes(body.loc)) throw new Error('Нет такого места');
      room.loc = body.loc;
      broadcast(room, [{ type: room.phase === 'lobby' ? 'lobby' : 'talk', seat, text: '<i>*пересаживает всех: ' + { baza: 'на БАЗУ', yard: 'во двор', office: 'в кабинет', space: 'в космос' }[body.loc] + '*</i>' }]);
      return;
    }
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

// За каким столом сидит человек с аккаунтом key (для «Двора»)
function tableOf(key) {
  for (const room of rooms.values()) {
    const s = room.seats.find((x) => x && !x.bot && x.acct === key && x.conns.size);
    if (s) return { code: room.code, phase: room.phase, mode: room.mode, free: room.seats.filter((x) => !x || (room.phase !== 'lobby' && x.bot)).length };
  }
  return null;
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
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
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
      const { room, tok, seat } = createRoom(b.name, b.mode, b.char, u ? u.xp : b.xp, u ? A.keyOf(u.nick) : null, b.loc, b.honest, b.emotes === false);
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
