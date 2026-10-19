// KOZEL: аккаунты (ник + PIN), прогресс в облаке и «Двор» (кто онлайн, приглашения).
// Хранилище: Upstash Redis через REST (переменные UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN на Render).
// Если переменных нет (запуск у себя на компьютере), всё пишется в файл data/db.json.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- Хранилище ----------
const URL_ = process.env.UPSTASH_REDIS_REST_URL, TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const P = 'kozel:';
let store;
if (URL_ && TOKEN) {
  const cmd = async (...args) => {
    const r = await fetch(URL_, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    const j = await r.json();
    if (j.error) throw new Error('База: ' + j.error);
    return j.result;
  };
  store = {
    kind: 'upstash',
    get: async (k) => { const v = await cmd('GET', P + k); return v ? JSON.parse(v) : null; },
    set: (k, v) => cmd('SET', P + k, JSON.stringify(v)),
    del: (k) => cmd('DEL', P + k),
    sadd: (k, m) => cmd('SADD', P + k, m),
    smembers: (k) => cmd('SMEMBERS', P + k),
  };
} else {
  const file = path.join(__dirname, 'data', 'db.json');
  let db = {};
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  let t = null;
  const flush = () => { clearTimeout(t); t = setTimeout(() => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(db)); }, 200); };
  store = {
    kind: 'file',
    get: async (k) => (db[k] === undefined ? null : JSON.parse(JSON.stringify(db[k]))),
    set: async (k, v) => { db[k] = v; flush(); },
    del: async (k) => { delete db[k]; flush(); },
    sadd: async (k, m) => { db[k] = db[k] || []; if (!db[k].includes(m)) db[k].push(m); flush(); },
    smembers: async (k) => (db[k] || []).slice(),
  };
}

// ---------- Пользователи ----------
// В памяти держим всех (их мало, это компания друзей): быстро и почти без запросов к базе.
const users = new Map();      // key (ник в нижнем регистре) -> профиль
const sessions = new Map();   // токен -> key
const seen = new Map();       // key -> { at, status }
const invites = new Map();    // key -> [{ from, code, at }]
const fails = new Map();      // key -> { n, until }
let ready = null;
function load() {
  if (!ready) ready = (async () => {
    const keys = await store.smembers('users');
    for (const k of keys) { const u = await store.get('user:' + k); if (u) users.set(k, u); }
  })().catch((e) => { ready = null; throw e; });
  return ready;
}
const keyOf = (nick) => String(nick || '').trim().toLowerCase();
const cleanNick = (s) => String(s || '').replace(/[<>&"'\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
const CHARS = ['lysy', 'zema', 'dantl', 'vitaha', 'elvis', 'oleg'];

// Прогресс: опыт, статистика, ачивки, персонаж. Объединяем по максимуму, ничего не теряется.
function cleanProgress(p) {
  p = p || {};
  const num = (x) => Math.max(0, Math.min(1e8, Math.floor(Number(x) || 0)));
  const stats = {};
  for (const [k, v] of Object.entries(p.stats || {})) if (/^[a-zA-Z]{1,20}$/.test(k)) stats[k] = num(v);
  const ach = {};
  for (const [k, v] of Object.entries(p.ach || {})) if (/^[a-z0-9]{1,12}$/.test(k)) ach[k] = num(v) || 1;
  return { xp: num(p.xp), stats, ach, char: CHARS.includes(p.char) ? p.char : null };
}
function merge(a, b) {
  const out = { xp: Math.max(a.xp || 0, b.xp || 0), stats: Object.assign({}, a.stats), ach: Object.assign({}, a.ach), char: b.char || a.char || null };
  for (const [k, v] of Object.entries(b.stats || {})) out.stats[k] = Math.max(out.stats[k] || 0, v);
  for (const [k, v] of Object.entries(b.ach || {})) out.ach[k] = out.ach[k] ? Math.min(out.ach[k], v) : v;
  return out;
}
const publicProfile = (u) => ({ nick: u.nick, xp: u.xp, stats: u.stats, ach: u.ach, char: u.char });

async function newSession(key) {
  const tok = crypto.randomBytes(24).toString('hex');
  sessions.set(tok, key);
  await store.set('sess:' + tok, key);
  return tok;
}
async function userByToken(tok) {
  if (!tok || typeof tok !== 'string' || tok.length > 80) return null;
  await load();
  let key = sessions.get(tok);
  if (!key) { key = await store.get('sess:' + tok); if (key) sessions.set(tok, key); }
  return key ? users.get(key) || null : null;
}
function checkFails(key) {
  const f = fails.get(key);
  if (f && f.until > Date.now()) throw new Error('Слишком много попыток. Подожди пару минут');
}
function addFail(key) {
  const f = fails.get(key) || { n: 0, until: 0 };
  f.n++; if (f.n >= 5) { f.until = Date.now() + 3 * 60000; f.n = 0; }
  fails.set(key, f);
}

async function register(body) {
  await load();
  const nick = cleanNick(body.nick), key = keyOf(nick), pin = String(body.pin || '');
  if (nick.length < 2) throw new Error('Ник от 2 букв');
  if (!/^\d{4,6}$/.test(pin)) throw new Error('PIN: от 4 до 6 цифр');
  if (users.has(key)) throw new Error('Такой ник уже занят. Если это ты, жми «Войти»');
  const salt = crypto.randomBytes(12).toString('hex');
  const u = Object.assign({ nick, salt, pin: hashPin(pin, salt), created: Date.now() }, cleanProgress(body.progress));
  users.set(key, u);
  await store.set('user:' + key, u);
  await store.sadd('users', key);
  return { token: await newSession(key), profile: publicProfile(u) };
}
async function login(body) {
  await load();
  const key = keyOf(body.nick), u = users.get(key);
  checkFails(key);
  if (!u || hashPin(String(body.pin || ''), u.salt) !== u.pin) { addFail(key); throw new Error('Неверный ник или PIN'); }
  fails.delete(key);
  // прогресс с этого устройства не теряем: объединяем с облачным
  if (body.progress) { Object.assign(u, merge(u, cleanProgress(body.progress))); await store.set('user:' + key, u); }
  return { token: await newSession(key), profile: publicProfile(u) };
}
async function me(body) {
  const u = await userByToken(body.token);
  if (!u) throw new Error('Нужно войти заново');
  return { profile: publicProfile(u) };
}
const lastWrite = new Map();
async function save(body) {
  const u = await userByToken(body.token);
  if (!u) throw new Error('Нужно войти заново');
  Object.assign(u, merge(u, cleanProgress(body.progress)));
  const key = keyOf(u.nick), now = Date.now();
  // в базу пишем не чаще раза в 5 секунд на человека
  if (now - (lastWrite.get(key) || 0) > 5000) { lastWrite.set(key, now); await store.set('user:' + key, u); }
  else setTimeout(() => store.set('user:' + key, u).catch(() => {}), 5200);
  return { profile: publicProfile(u) };
}
async function logout(body) {
  if (body.token) { sessions.delete(body.token); await store.del('sess:' + body.token).catch(() => {}); }
  return { ok: true };
}

// ---------- Двор: кто онлайн ----------
// Клиент раз в 10 секунд стучится сюда, мы отмечаем его и отдаём список всех пацанов со статусами.
// tableOf(key) -> { code, phase, free } из комнат сервера (передаётся из server.js).
async function yard(body, tableOf) {
  const u = await userByToken(body.token);
  if (!u) throw new Error('Нужно войти заново');
  const key = keyOf(u.nick), now = Date.now();
  seen.set(key, { at: now });
  const list = [...users.entries()].map(([k, x]) => {
    const s = seen.get(k), on = s && now - s.at < 25000;
    const t = on ? tableOf(k) : null;
    return { nick: x.nick, char: x.char, xp: x.xp, wins: (x.stats && x.stats.wins) || 0, rounds: (x.stats && x.stats.rounds) || 0,
      status: !on ? 'off' : t ? (t.phase === 'lobby' ? 'lobby' : 'playing') : 'yard', table: t, seenAgo: s ? Math.round((now - s.at) / 1000) : null, me: k === key };
  }).sort((a, b) => (b.me - a.me) || (rank(b.status) - rank(a.status)) || (a.seenAgo === null) - (b.seenAgo === null) || (a.seenAgo || 0) - (b.seenAgo || 0));
  const inv = (invites.get(key) || []).filter((i) => now - i.at < 60000);
  invites.delete(key);
  return { list, invites: inv };
}
const rank = (s) => ({ yard: 3, lobby: 2, playing: 1, off: 0 }[s]);
async function invite(body, tableOf) {
  const u = await userByToken(body.token);
  if (!u) throw new Error('Нужно войти заново');
  const to = keyOf(body.to), from = keyOf(u.nick);
  if (!users.has(to) || to === from) throw new Error('Некого звать');
  const t = tableOf(from);
  if (!t) throw new Error('Сначала накрой стол');
  const list = (invites.get(to) || []).filter((i) => i.from !== u.nick);
  list.push({ from: u.nick, code: t.code, at: Date.now() });
  invites.set(to, list);
  return { ok: true };
}

module.exports = { store, register, login, me, save, logout, yard, invite, userByToken, keyOf, load };
