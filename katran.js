// KOZEL: «Катран» у местного каталы — дурак, покер (короткая колода) и очко (21).
// Работает и в Node (сервер), и в браузере. Колода везде 36 карт (6..туз), как во дворе.
// У каждой игры одинаковый набор: newGame(opts, rnd), view(st, seat), toMove(st), legal(st, seat), apply(st, seat, act), bot(st, seat, level, rnd).
// Места в st абсолютные (0..n-1). Карта = { id: 'AS', rank: 'A', suit: 'S' }.
(function (root) {
  'use strict';
  const SUITS = ['C', 'D', 'H', 'S'], RANKS = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const RV = { 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 11, Q: 12, K: 13, A: 14 };
  const RU = { J: 'В', Q: 'Д', K: 'К', A: 'Т' }, SYM = { C: '♣', D: '♦', H: '♥', S: '♠' };
  const short = (c) => (RU[c.rank] || c.rank) + SYM[c.suit];
  function deck(rnd) {
    const d = [];
    for (const s of SUITS) for (const r of RANKS) d.push({ id: r + s, rank: r, suit: s });
    for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = d[i]; d[i] = d[j]; d[j] = t; }
    return d;
  }
  const take = (hand, id) => { const k = hand.findIndex((c) => c.id === id); return k < 0 ? null : hand.splice(k, 1)[0]; };
  const has = (hand, id) => hand.some((c) => c.id === id);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const pick = (a, rnd) => a[Math.floor(rnd() * a.length)];

  // =====================================================================
  // ДУРАК. opts: { n: 2..4, kind: 'podkid' | 'perevod', teams: false|true (только n=4: 0+2 против 1+3) }
  // =====================================================================
  const D = {};
  D.beats = (a, b, trump) => (b.suit === a.suit && RV[b.rank] > RV[a.rank]) || (b.suit === trump && a.suit !== trump);
  D.newGame = function (o, rnd) {
    rnd = rnd || Math.random;
    const n = Math.max(2, Math.min(4, o.n | 0 || 2)), dk = deck(rnd);
    const hands = Array.from({ length: n }, () => dk.splice(0, 6));
    const trumpCard = dk[dk.length - 1]; // лежит под колодой, его берут последним
    const st = { game: 'durak', n, kind: o.kind === 'perevod' ? 'perevod' : 'podkid', teams: !!(o.teams && n === 4), hands, deck: dk, trump: trumpCard.suit, trumpCard,
      table: [], att: 0, def: 1, taking: false, passed: [], out: [], order: [], over: false, loser: null, log: [], limit: 6, turnNo: 0 };
    // первым ходит тот, у кого младший козырь
    let best = null;
    hands.forEach((h, i) => h.forEach((c) => { if (c.suit === st.trump && (!best || RV[c.rank] < RV[best.c.rank])) best = { i, c }; }));
    st.att = best ? best.i : 0; st.def = D.next(st, st.att); st.limit = Math.min(6, st.hands[st.def].length);
    st.first = best ? { seat: best.i, card: best.c } : null;
    return st;
  };
  D.active = (st, i) => !st.out.includes(i);
  D.next = (st, i) => { for (let k = 1; k <= st.n; k++) { const j = (i + k) % st.n; if (D.active(st, j)) return j; } return i; };
  // кто может подкидывать: все, кроме защитника (в парах — кроме напарника защитника), у кого есть карты
  D.throwers = (st) => { const out = []; let j = st.att; for (let k = 0; k < st.n; k++) { const s = (st.att + k) % st.n; if (s !== st.def && D.active(st, s) && !(st.teams && s % 2 === st.def % 2)) out.push(s); } return out; };
  D.ranksOnTable = (st) => new Set(st.table.flatMap((p) => [p.a.rank].concat(p.d ? [p.d.rank] : [])));
  D.unbeaten = (st) => st.table.filter((p) => !p.d).length;
  D.toMove = function (st) {
    if (st.over) return -1;
    if (!st.table.length) return st.att;
    if (!st.taking && D.unbeaten(st) > 0) return st.def;
    // подкидывание: первый, кто ещё не сказал «пас»
    const room = st.table.length < st.limit && st.hands[st.def].length - D.unbeaten(st) > 0;
    for (const s of D.throwers(st)) if (!st.passed.includes(s)) {
      const can = room && st.hands[s].some((c) => D.ranksOnTable(st).has(c.rank));
      if (can) return s;
    }
    return -2; // никто не может/не хочет — раунд закрывается (делает apply 'end' автоматически)
  };
  D.legal = function (st, seat) {
    const out = [], h = st.hands[seat], mv = D.toMove(st);
    if (mv !== seat) return out;
    if (!st.table.length) { h.forEach((c) => out.push({ t: 'attack', card: c.id })); return out; }
    if (seat === st.def && !st.taking) {
      const open = st.table.map((p, k) => (p.d ? -1 : k)).filter((k) => k >= 0);
      for (const k of open) for (const c of h) if (D.beats(st.table[k].a, c, st.trump)) out.push({ t: 'beat', k, card: c.id });
      // перевод: ничего не побито, все карты одного ранга, у следующего хватит карт
      if (st.kind === 'perevod' && st.table.every((p) => !p.d)) {
        const r = st.table[0].a.rank, nx = D.next(st, st.def);
        if (st.table.every((p) => p.a.rank === r) && st.hands[nx].length >= st.table.length + 1 && !(st.teams && nx % 2 === st.def % 2))
          h.forEach((c) => { if (c.rank === r) out.push({ t: 'transfer', card: c.id }); });
      }
      out.push({ t: 'take' });
      return out;
    }
    const ranks = D.ranksOnTable(st);
    h.forEach((c) => { if (ranks.has(c.rank)) out.push({ t: 'throw', card: c.id }); });
    out.push({ t: 'pass' });
    return out;
  };
  function dRefill(st) {
    const order = [st.att].concat(D.throwers(st).filter((s) => s !== st.att), [st.def]);
    for (const s of order) while (st.hands[s].length < 6 && st.deck.length) st.hands[s].push(st.deck.shift());
  }
  function dCheckOut(st) {
    if (st.deck.length) return;
    for (let i = 0; i < st.n; i++) if (D.active(st, i) && !st.hands[i].length) { st.out.push(i); st.order.push(i); }
    const left = [...Array(st.n).keys()].filter((i) => D.active(st, i));
    if (st.teams) {
      // пара выбыла целиком — она выиграла; проигрывает вторая
      for (const t of [0, 1]) if (!left.some((i) => i % 2 === t)) { st.over = true; st.loserTeam = 1 - t; st.loser = left.length ? left[0] : null; return; }
    }
    if (left.length <= 1) { st.over = true; st.loser = left.length ? left[0] : null; if (st.teams && st.loser !== null) st.loserTeam = st.loser % 2; }
  }
  function dEndRound(st) {
    const took = st.taking, def = st.def;
    if (took) st.hands[def].push(...st.table.flatMap((p) => [p.a].concat(p.d ? [p.d] : [])));
    st.log.push({ t: took ? 'took' : 'bito', seat: def, n: st.table.length });
    st.table = []; st.taking = false; st.passed = [];
    dRefill(st); dCheckOut(st);
    if (st.over) return;
    // кто ходит дальше: отбился — защитник; взял — следующий после защитника
    let a = took ? D.next(st, def) : (D.active(st, def) ? def : D.next(st, def));
    st.att = a; st.def = D.next(st, a); st.limit = Math.min(6, st.hands[st.def].length); st.turnNo++;
    if (st.att === st.def) { st.over = true; st.loser = st.att; }
  }
  D.apply = function (st, seat, act) {
    if (st.over) return { ok: false, err: 'Партия окончена' };
    const L = D.legal(st, seat), ok = L.some((x) => x.t === act.t && (x.card === undefined || x.card === act.card) && (x.k === undefined || x.k === act.k));
    if (!ok) return { ok: false, err: 'Так ходить нельзя' };
    const h = st.hands[seat], ev = { t: act.t, seat };
    if (act.t === 'attack' || act.t === 'throw') { const c = take(h, act.card); st.table.push({ a: c, d: null, by: seat }); ev.card = c; st.passed = []; }
    else if (act.t === 'beat') { const c = take(h, act.card); st.table[act.k].d = c; ev.card = c; ev.k = act.k; st.passed = []; }
    else if (act.t === 'transfer') { const c = take(h, act.card); st.table.push({ a: c, d: null, by: seat }); ev.card = c; const nd = D.next(st, st.def); st.att = st.def; st.def = nd; st.limit = Math.min(6, st.hands[nd].length + 0); st.limit = Math.max(st.limit, st.table.length); st.passed = []; }
    else if (act.t === 'take') { st.taking = true; st.passed = []; }
    else if (act.t === 'pass') st.passed.push(seat);
    st.log.push(ev);
    // защитник выкинул последние карты, когда колода пуста — побито автоматически
    if (D.toMove(st) === -2 || (!st.taking && D.unbeaten(st) === 0 && !st.hands[st.def].length)) dEndRound(st);
    else dCheckOutMid(st);
    return { ok: true, ev };
  };
  function dCheckOutMid(st) { /* выбывание считаем только в конце раунда */ }
  D.view = function (st, seat) {
    const v = clone(st);
    v.hands = st.hands.map((h, i) => (i === seat ? clone(h) : h.length));
    v.deck = st.deck.length; v.toMove = D.toMove(st);
    return v;
  };
  // ---- бот дурака ----
  const dCost = (c, trump) => RV[c.rank] + (c.suit === trump ? 20 : 0);
  D.bot = function (st, seat, level, rnd) {
    rnd = rnd || Math.random;
    const L = D.legal(st, seat); if (!L.length) return null;
    const h = st.hands[seat], cost = (id) => dCost(h.find((c) => c.id === id), st.trump), late = st.deck.length < 4;
    const by = (t) => L.filter((x) => x.t === t);
    if (level === 0 && rnd() < .25) { const nonTake = L.filter((x) => x.t !== 'take' || L.length === 1); return pick(nonTake.length ? nonTake : L, rnd); }
    if (by('attack').length) {
      // ходим младшей некозырной, умный — парой одного ранга
      const a = by('attack').sort((x, y) => cost(x.card) - cost(y.card));
      return a[0];
    }
    if (seat === st.def && !st.taking) {
      const tr = by('transfer').sort((x, y) => cost(x.card) - cost(y.card));
      if (tr.length && level >= 1 && cost(tr[0].card) < 20 && rnd() < .8) return tr[0];
      const open = st.table.map((p, k) => (p.d ? -1 : k)).filter((k) => k >= 0);
      // бьём каждую карту самой дешёвой; если придётся тратить много козырей рано — забираем
      const used = new Set(); let plan = [], spend = 0;
      for (const k of open) {
        const opts = by('beat').filter((x) => x.k === k && !used.has(x.card)).sort((x, y) => cost(x.card) - cost(y.card));
        if (!opts.length) { plan = null; break; }
        used.add(opts[0].card); plan.push(opts[0]); spend += cost(opts[0].card);
      }
      if (!plan) return { t: 'take' };
      const pricy = plan.filter((x) => cost(x.card) >= 30).length;
      if (level >= 1 && !late && pricy >= 1 && open.length === 1 && st.table.length <= 2 && rnd() < (level >= 2 ? .5 : .3) && spend > 32) return { t: 'take' };
      return plan[0];
    }
    // подкидываем дешёвое, козыри и тузы бережём (под конец не жалеем)
    const th = by('throw').sort((x, y) => cost(x.card) - cost(y.card));
    if (th.length && (late || cost(th[0].card) < (level >= 2 ? 12 : 14) || (st.taking && cost(th[0].card) < 20))) return th[0];
    return { t: 'pass' };
  };

  // =====================================================================
  // ПОКЕР: техасский холдем на короткой колоде (36 карт). Флеш старше фулл-хауса, младший стрит Т-6-7-8-9.
  // opts: { n: 2..6, buyin, sb, bb } — фишки = ставка в семках или гривнах
  // =====================================================================
  const P = {};
  // оценка 5 карт: [категория, ...кикеры] (больше — лучше)
  function eval5(cs) {
    const v = cs.map((c) => RV[c.rank]).sort((a, b) => b - a), cnt = {};
    v.forEach((x) => { cnt[x] = (cnt[x] || 0) + 1; });
    const flush = cs.every((c) => c.suit === cs[0].suit);
    const u = [...new Set(v)];
    let str = 0;
    if (u.length === 5) { if (u[0] - u[4] === 4) str = u[0]; else if (u.join() === '14,9,8,7,6') str = 9; }
    const groups = Object.entries(cnt).map(([r, c]) => [c, +r]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    if (str && flush) return [8, str];
    if (groups[0][0] === 4) return [7, groups[0][1], groups[1][1]];
    if (flush) return [6].concat(v);
    if (groups[0][0] === 3 && groups[1][0] === 2) return [5, groups[0][1], groups[1][1]];
    if (str) return [3, str];
    if (groups[0][0] === 3) return [4].concat(groups.map((g) => g[1]));
    if (groups[0][0] === 2 && groups[1][0] === 2) return [2].concat(groups.map((g) => g[1]));
    if (groups[0][0] === 2) return [1].concat(groups.map((g) => g[1]));
    return [0].concat(v);
  }
  // порядок категорий в коротком покере: стрит < сет (как в таблице выше 3 и 4 поменяны местами в CAT)
  const cmp = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; };
  P.best = function (cards) {
    let best = null;
    const n = cards.length;
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
      const r = eval5([cards[a], cards[b], cards[c], cards[d], cards[e]]);
      if (!best || cmp(r, best) > 0) best = r;
    }
    return best;
  };
  P.catName = (r) => ({ 0: 'Старшая карта', 1: 'Пара', 2: 'Две пары', 3: 'Стрит', 4: 'Сет', 5: 'Фулл-хаус', 6: 'Флеш', 7: 'Каре', 8: 'Стрит-флеш' })[r[0]];
  P.cmp = cmp;
  P.newGame = function (o, rnd) {
    const n = Math.max(2, Math.min(6, o.n | 0 || 4)), buyin = Math.max(10, o.buyin | 0 || 100);
    const st = { game: 'poker', n, buyin, sb: o.sb || Math.max(1, Math.round(buyin / 50)), bb: o.bb || Math.max(2, Math.round(buyin / 25)),
      chips: Array(n).fill(buyin), out: Array(n).fill(false), dealer: Math.floor((rnd || Math.random)() * n), hand: 0, over: false, log: [] };
    P.deal(st, rnd);
    return st;
  };
  P.alive = (st) => [...Array(st.n).keys()].filter((i) => !st.out[i] && st.chips[i] > 0);
  P.deal = function (st, rnd) {
    rnd = rnd || Math.random;
    const live = P.alive(st);
    if (live.length < 2) { st.over = true; st.winner = live[0]; return; }
    st.hand++;
    const nxt = (i) => { for (let k = 1; k <= st.n; k++) { const j = (i + k) % st.n; if (live.includes(j)) return j; } return i; };
    st.dealer = nxt(st.dealer);
    const dk = deck(rnd);
    st.hole = Array.from({ length: st.n }, (_, i) => (live.includes(i) ? dk.splice(0, 2) : []));
    st.deckLeft = dk; st.board = []; st.street = 0; st.bet = Array(st.n).fill(0); st.put = Array(st.n).fill(0);
    st.folded = Array.from({ length: st.n }, (_, i) => !live.includes(i)); st.allin = Array(st.n).fill(false);
    st.showdown = null; st.result = null; st.turn = -1;
    const heads = live.length === 2;
    const sbS = heads ? st.dealer : nxt(st.dealer), bbS = nxt(sbS);
    P.post(st, sbS, st.sb); P.post(st, bbS, st.bb);
    st.cur = Math.max(st.bet[sbS], st.bet[bbS]); st.minRaise = st.bb;
    st.acted = Array(st.n).fill(false);
    st.sbS = sbS; st.bbS = bbS;
    P.advance(st, bbS);
  };
  P.post = function (st, s, x) { const a = Math.min(x, st.chips[s]); st.chips[s] -= a; st.bet[s] += a; st.put[s] += a; if (!st.chips[s]) st.allin[s] = true; };
  P.inHand = (st) => [...Array(st.n).keys()].filter((i) => !st.folded[i]);
  P.canAct = (st, i) => !st.folded[i] && !st.allin[i];
  P.nextActor = function (st, from) { for (let k = 1; k <= st.n; k++) { const j = (from + k) % st.n; if (P.canAct(st, j) && !(st.acted[j] && st.bet[j] === st.cur)) return j; } return -1; };
  // после каждого хода: кто следующий, или новая улица, или вскрытие
  P.advance = function (st, from) {
    for (let guard = 0; guard < 10; guard++) {
      if (P.inHand(st).length === 1) return P.finish(st);
      const actors = P.inHand(st).filter((i) => P.canAct(st, i));
      const complete = actors.every((i) => st.acted[i] && st.bet[i] === st.cur) || (actors.length === 1 && st.bet[actors[0]] >= st.cur);
      if (!complete && actors.length) { const nx = P.nextActor(st, from); if (nx >= 0) { st.turn = nx; return; } }
      if (st.street >= 3) return P.finish(st);
      st.bet = Array(st.n).fill(0); st.cur = 0; st.minRaise = st.bb; st.acted = Array(st.n).fill(false);
      if (st.street === 0) st.board.push(...st.deckLeft.splice(0, 3)); else st.board.push(st.deckLeft.shift());
      st.street++;
      from = st.dealer;
      if (actors.length <= 1) { for (const i of actors) st.acted[i] = true; continue; } // некому торговаться: докладываем карты
    }
    P.finish(st);
  };
  // раздел банка с побочными банками
  P.finish = function (st) {
    while (st.board.length < 5 && P.inHand(st).length > 1) st.board.push(st.deckLeft.shift());
    const live = P.inHand(st), score = {};
    live.forEach((i) => { score[i] = P.best(st.hole[i].concat(st.board)); });
    const levels = [...new Set(st.put.filter((x) => x > 0))].sort((a, b) => a - b), win = Array(st.n).fill(0);
    let prev = 0; const pots = [];
    for (const lv of levels) {
      const amount = st.put.reduce((a, p) => a + Math.max(0, Math.min(p, lv) - prev), 0);
      const elig = live.filter((i) => st.put[i] >= lv);
      prev = lv;
      if (!amount) continue;
      if (!elig.length) { pots.push({ amount, who: [] }); continue; }
      let best = null, who = [];
      for (const i of elig) { const c = live.length > 1 ? cmp(score[i], best || [-1]) : 1; if (!best || c > 0) { best = score[i]; who = [i]; } else if (c === 0) who.push(i); }
      const share = Math.floor(amount / who.length); let rest = amount - share * who.length;
      who.forEach((i) => { win[i] += share + (rest-- > 0 ? 1 : 0); });
      pots.push({ amount, who });
    }
    win.forEach((w, i) => { st.chips[i] += w; });
    st.result = { win, pots, score: live.length > 1 ? Object.fromEntries(live.map((i) => [i, { r: score[i], name: P.catName(score[i]) }])) : null, show: live.length > 1 ? live : [] };
    st.turn = -1;
    st.log.push({ t: 'hand', win });
    for (let i = 0; i < st.n; i++) if (st.chips[i] <= 0) st.out[i] = true;
    if (P.alive(st).length < 2) { st.over = true; st.winner = P.alive(st)[0]; }
  };
  P.toMove = (st) => (st.over || st.result ? -1 : st.turn);
  P.legal = function (st, seat) {
    if (P.toMove(st) !== seat) return [];
    const need = st.cur - st.bet[seat], stack = st.chips[seat], out = [{ t: 'fold' }];
    if (need <= 0) out.push({ t: 'check' }); else out.push({ t: 'call', amt: Math.min(need, stack) });
    const minTo = st.cur + st.minRaise;
    if (stack > need) out.push({ t: 'raise', min: Math.min(minTo, st.bet[seat] + stack), max: st.bet[seat] + stack });
    return out;
  };
  P.apply = function (st, seat, act) {
    const L = P.legal(st, seat), a = L.find((x) => x.t === act.t);
    if (!a) return { ok: false, err: 'Сейчас так нельзя' };
    const ev = { t: act.t, seat };
    if (act.t === 'fold') st.folded[seat] = true;
    else if (act.t === 'check') {}
    else if (act.t === 'call') { P.post(st, seat, a.amt); ev.amt = a.amt; }
    else if (act.t === 'raise') {
      const to = Math.max(a.min, Math.min(a.max, Math.floor(act.to || a.min))), add = to - st.bet[seat];
      if (to - st.cur >= st.minRaise) st.minRaise = to - st.cur;
      P.post(st, seat, add); st.cur = Math.max(st.cur, st.bet[seat]); ev.to = st.bet[seat];
      for (let i = 0; i < st.n; i++) if (i !== seat) st.acted[i] = false;
      if (st.allin[seat]) ev.allin = true;
    }
    st.acted[seat] = true;
    st.log.push(ev);
    P.advance(st, seat);
    return { ok: true, ev };
  };
  P.next = function (st, rnd) { if (st.result && !st.over) P.deal(st, rnd); };
  P.view = function (st, seat) {
    const v = clone(st); delete v.deckLeft;
    const show = st.result ? st.result.show : [];
    v.hole = st.hole.map((h, i) => (i === seat || show.includes(i) ? clone(h) : h.length));
    v.toMove = P.toMove(st);
    return v;
  };
  // ---- бот покера: оценка шансов прогоном раздач (Монте-Карло) ----
  P.equity = function (st, seat, sims, rnd) {
    rnd = rnd || Math.random;
    const known = new Set(st.hole[seat].concat(st.board).map((c) => c.id));
    const pool = []; for (const s of SUITS) for (const r of RANKS) if (!known.has(r + s)) pool.push({ id: r + s, rank: r, suit: s });
    const opp = P.inHand(st).filter((i) => i !== seat).length || 1;
    let win = 0;
    for (let k = 0; k < sims; k++) {
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
      let p = 0; const board = st.board.concat(pool.slice(0, 5 - st.board.length)); p = 5 - st.board.length;
      const me = P.best(st.hole[seat].concat(board));
      let best = true, tie = 0;
      for (let o = 0; o < opp; o++) { const r = P.best(pool.slice(p, p + 2).concat(board)); p += 2; const c = cmp(me, r); if (c < 0) { best = false; break; } if (c === 0) tie++; }
      if (best) win += tie ? 1 / (tie + 1) : 1;
    }
    return win / sims;
  };
  P.bot = function (st, seat, level, rnd, style) {
    rnd = rnd || Math.random; style = style || {};
    const L = P.legal(st, seat); if (!L.length) return null;
    const need = st.cur - st.bet[seat], pot = st.put.reduce((a, b) => a + b, 0), stack = st.chips[seat];
    const opp = Math.max(1, P.inHand(st).length - 1), sims = Math.round(([40, 110, 220][level] || 110) * 2 / (1 + opp)); // чем больше соперников, тем меньше прогонов (иначе тормозит)
    let eq = P.equity(st, seat, sims, rnd) + (rnd() - .5) * [.25, .12, .05][level];
    const odds = need > 0 ? need / (pot + need) : 0;
    const raise = L.find((x) => x.t === 'raise'), can = (t) => L.some((x) => x.t === t);
    const bluff = (style.bluff || .06) * (level === 0 ? .5 : 1);
    const sizeTo = (k) => raise && Math.max(raise.min, Math.min(raise.max, st.cur + Math.round(pot * k)));
    if (raise && (eq > .72 || (rnd() < bluff && st.street > 0))) return { t: 'raise', to: eq > .85 && rnd() < .4 ? raise.max : sizeTo(eq > .8 ? 1 : .6) };
    if (raise && eq > .55 && need === 0 && rnd() < .5) return { t: 'raise', to: sizeTo(.5) };
    if (need <= 0) return { t: 'check' };
    if (eq > odds + (level === 0 ? -.05 : .04) || (need <= st.bb && eq > .25)) return { t: 'call' };
    if (style.wild && rnd() < .2) return { t: 'call' };
    return { t: 'fold' };
  };

  // =====================================================================
  // ОЧКО (21) против банкира-каталы. В=2, Д=3, К=4, Т=11, остальные по номиналу. Два туза — «золотое очко».
  // opts: { n: 1..6 игроков (банкир отдельно, место n), bet }
  // =====================================================================
  const O = {};
  const OV = { 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 2, Q: 3, K: 4, A: 11 };
  O.sum = (h) => h.reduce((a, c) => a + OV[c.rank], 0);
  O.gold = (h) => h.length === 2 && h.every((c) => c.rank === 'A');
  O.bust = (h) => O.sum(h) > 21 && !O.gold(h);
  O.newGame = function (o, rnd) {
    const n = Math.max(1, Math.min(6, o.n | 0 || 3));
    const st = { game: 'ochko', n, bet: Math.max(1, o.bet | 0 || 10), round: 0, bank: [], over: false, net: Array(n).fill(0), log: [] };
    O.deal(st, rnd);
    return st;
  };
  O.deal = function (st, rnd) {
    st.deckLeft = deck(rnd || Math.random); st.round++;
    st.hands = Array.from({ length: st.n }, () => [st.deckLeft.shift()]);
    st.bank = [st.deckLeft.shift()];
    st.done = Array(st.n).fill(false); st.turn = 0; st.result = null;
  };
  O.toMove = (st) => (st.result ? -1 : st.turn);
  O.legal = (st, seat) => (O.toMove(st) === seat ? [{ t: 'hit' }, { t: 'stand' }] : []);
  function oNext(st) {
    while (st.turn < st.n && st.done[st.turn]) st.turn++;
    if (st.turn >= st.n) O.bankPlay(st);
  }
  O.apply = function (st, seat, act) {
    if (!O.legal(st, seat).some((x) => x.t === act.t)) return { ok: false, err: 'Не твой ход' };
    const h = st.hands[seat], ev = { t: act.t, seat };
    if (act.t === 'hit') {
      const c = st.deckLeft.shift(); h.push(c); ev.card = c;
      if (O.bust(h) || O.sum(h) === 21 || O.gold(h)) st.done[seat] = true;
    } else st.done[seat] = true;
    st.log.push(ev);
    oNext(st);
    return { ok: true, ev };
  };
  // банкир добирает до 17 (если все перебрали — не добирает)
  O.bankPlay = function (st) {
    st.turn = -1;
    const anyAlive = st.hands.some((h) => !O.bust(h));
    while (anyAlive && O.sum(st.bank) < 17 && !O.gold(st.bank)) st.bank.push(st.deckLeft.shift());
    const b = O.gold(st.bank) ? 99 : O.bust(st.bank) ? -1 : O.sum(st.bank);
    const res = st.hands.map((h) => {
      const s = O.gold(h) ? 99 : O.bust(h) ? -2 : O.sum(h);
      if (s === -2) return { r: 'lose', k: -1 };
      const natural = (h.length === 2 && O.sum(h) === 21) || O.gold(h);
      if (s > b) return { r: natural ? 'och' : 'win', k: natural ? 1.5 : 1 };
      if (s === b) return { r: 'push', k: 0 };
      return { r: 'lose', k: -1 };
    });
    res.forEach((x, i) => { st.net[i] += Math.round(x.k * st.bet); });
    st.result = { res, bank: b === 99 ? 'Золотое очко' : b === -1 ? 'Перебор' : String(b) };
  };
  O.next = function (st, rnd) { if (st.result) O.deal(st, rnd); };
  O.view = function (st, seat) {
    const v = clone(st); delete v.deckLeft;
    if (!st.result) v.bank = [st.bank[0], null]; // вторая карта банкира закрыта (он её ещё не взял — рисуем рубашку)
    v.toMove = O.toMove(st);
    return v;
  };
  O.bot = function (st, seat, level, rnd) {
    rnd = rnd || Math.random;
    const h = st.hands[seat], s = O.sum(h), up = OV[st.bank[0].rank];
    let stop = [15, 16, 17][level] || 16;
    if (level >= 2 && up >= 10 && s >= 14) stop = 17; else if (level >= 2 && up <= 7) stop = 15;
    if (level === 0 && rnd() < .2) return { t: rnd() < .5 ? 'hit' : 'stand' };
    return { t: s < stop ? 'hit' : 'stand' };
  };

  const GAMES = { durak: D, poker: P, ochko: O };
  const NAMES = { durak: 'Дурак', poker: 'Покер', ochko: 'Очко' };
  const api = { GAMES, NAMES, D, P, O, RV, short, deck, OV };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KozelKat = api;
})(typeof window !== 'undefined' ? window : globalThis);
