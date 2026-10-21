// KOZEL: мозги ботов с уровнями (общие для браузера и сервера).
// Бот видит только то, что видел бы человек за столом: свою руку и все карты, которые уже легли на стол.
// Чужие руки он НЕ смотрит. Уровни:
//   0 слабый   — путает масть, тупит, сливает очки соперникам
//   1 средний  — помнит вышедшие козыри и тузы, подкидывает корешу
//   2 сильный  — считает очки, бережёт мать и валетов, крысит редко и только когда выгодно, крыс ловит почти всегда
//   3 деды     — всё то же, плюс помнит, у кого нет какой масти, и играет на это
(function (root) {
  'use strict';
  const K = root.Kozel || require('./rules.js');

  const LEVELS = [
    { name: 'слабый', dumb: .3, mistake: .07, cheat: .1, catch: .35, memory: false, feed: false, save: false, voids: false },
    { name: 'средний', dumb: .06, mistake: .02, cheat: .1, catch: .7, memory: true, feed: true, save: false, voids: false },
    { name: 'сильный', dumb: 0, mistake: 0, cheat: .22, catch: .95, memory: true, feed: true, save: true, voids: false, smartCheat: true },
    { name: 'деды', dumb: 0, mistake: 0, cheat: .3, catch: .98, memory: true, feed: true, save: true, voids: true, smartCheat: true },
  ];
  const lv = (n) => LEVELS[Math.max(0, Math.min(3, n | 0))];

  const DECK = K.createDeck();
  const pick = (a, R) => a[Math.floor((R || Math.random)() * a.length)];
  const minBy = (a, f) => a.reduce((x, y) => (f(y) < f(x) ? y : x));
  const maxBy = (a, f) => a.reduce((x, y) => (f(y) > f(x) ? y : x));

  // Что видно со стола: какие карты вышли, у кого какой масти точно нет (не положил масть)
  function table(round, seat) {
    const tr = round.trump, played = new Set(round.log.map((e) => e.card.id));
    const mine = new Set(round.hands[seat].map((c) => c.id));
    const unseen = DECK.filter((c) => !played.has(c.id) && !mine.has(c.id));
    const voids = [{}, {}, {}, {}];
    const byTrick = {};
    round.log.forEach((e) => { (byTrick[e.trickNo] = byTrick[e.trickNo] || []).push(e); });
    Object.values(byTrick).forEach((pl) => {
      const led = K.effSuit(pl[0].card, tr);
      pl.slice(1).forEach((e) => { if (K.effSuit(e.card, tr) !== led) voids[e.seat][led] = true; });
    });
    return { tr, unseen, voids };
  }

  // Может ли кто-то из тех, кто ходит после меня, перебить эту карту (по тому, что ещё не вышло)
  function threat(card, led, t, after, L) {
    const p = K.power(card, t.tr, led);
    const higher = t.unseen.filter((c) => K.power(c, t.tr, led) > p);
    if (!higher.length || !after.length) return false;
    if (!L.voids) return true;
    // деды: если масть не козырная и все, кто после, точно имеют масть (не было отказа), бить могут только старшей в масть
    if (led !== 'T' && after.every((s) => !t.voids[s][led])) return higher.some((c) => K.effSuit(c, t.tr) === led);
    // если все после меня без козырей (отказывались от козыря) — бить могут только в масть
    if (after.every((s) => t.voids[s].T)) return higher.some((c) => K.effSuit(c, t.tr) === led);
    return true;
  }

  const isPower = (c, tr) => K.isTrump(c, tr) && (c.rank === 'J' || c.rank === '6'); // мать и валеты
  const spend = (c, tr) => (isPower(c, tr) ? 30 : K.isTrump(c, tr) ? 8 + c.points : c.points); // во что обходится карта

  // Главное: какую карту положить. ctx: { honest, mem (память бота за раздачу), R (случайность), oppCatch }
  function choose(round, seat, level, ctx) {
    ctx = ctx || {};
    const R = ctx.R || Math.random, L = ctx.cheatK !== undefined ? Object.assign({}, lv(level), { cheat: lv(level).cheat * ctx.cheatK }) : lv(level), tr = round.trump;
    const hand = round.hands[seat];
    const trickCards = round.trick.map((e) => e.card);
    const legal = K.legalCards(hand, trickCards, tr);
    const illegal = hand.filter((c) => !legal.includes(c));
    const t = table(round, seat);
    const mate = K.opposite(seat), left = 9 - round.tricks.length;

    // слабый иногда путает масть
    if (!ctx.honest && illegal.length && trickCards.length && R() < L.mistake) return pick(illegal, R).id;
    // и просто тупит
    if (R() < L.dumb) return pick(legal, R).id;

    if (!trickCards.length) return lead(round, seat, L, t, legal, R).id;

    const led = K.effSuit(trickCards[0], tr);
    const cur = K.trickWinner(trickCards, tr);
    const curSeat = round.trick[cur].seat, best = K.power(trickCards[cur], tr, led);
    const onTable = trickCards.reduce((x, c) => x + c.points, 0);
    const after = [1, 2, 3].map((k) => (seat + k) % 4).slice(0, 3 - trickCards.length);
    const oppAfter = after.filter((s) => K.teamOf(s) !== K.teamOf(seat));
    const last = !after.length;
    const mateWins = K.teamOf(curSeat) === K.teamOf(seat);
    const pw = (c) => K.power(c, tr, led);

    // крысить (не класть масть), чтобы забрать жирную взятку
    if (!ctx.honest && !mateWins && illegal.length) {
      const cheat = illegal.filter((c) => pw(c) > best && (!oppAfter.length || !threat(c, led, t, oppAfter, L)));
      if (cheat.length) {
        let go;
        if (L.smartCheat) {
          // выгодно, только если куш большой, а соперники ловят плохо, или раздачу и так сливаем
          const mineTaken = round.taken[K.teamOf(seat)], hvalMine = K.teamOf(round.hvalSeat) === K.teamOf(seat);
          const losing = hvalMine ? mineTaken + 30 < 61 - (9 - left) * 4 : mineTaken < 20 && left <= 4;
          const risk = ctx.oppCatch === undefined ? .7 : ctx.oppCatch;
          go = onTable >= 20 && (risk < .6 || losing) && R() < L.cheat * 2;
        } else go = onTable >= 10 && R() < L.cheat;
        if (go) return minBy(cheat, (c) => spend(c, tr)).id;
      }
    }

    const winners = legal.filter((c) => pw(c) > best);
    if (!L.memory) {
      // как раньше: кореш берёт — кидаем жир, иначе бьём, если на столе что-то есть
      if (mateWins) return maxBy(legal, (c) => c.points).id;
      if (winners.length && (onTable >= 10 || last)) return minBy(winners, pw).id;
      return minBy(legal, (c) => c.points * 100 + pw(c)).id;
    }

    // кореш забирает
    if (mateWins) {
      const safe = last || !threat(trickCards[cur], led, t, oppAfter, L);
      if (safe && L.feed) {
        // подкидываем: тузы и десятки не козырные, мать и валетов не отдаём
        const feed = legal.filter((c) => !isPower(c, tr));
        if (feed.length) return maxBy(feed, (c) => c.points * 10 - (K.isTrump(c, tr) ? 5 : 0)).id;
      }
      // не уверены: перебиваем своей надёжной картой, если на столе жирно
      if (onTable >= 15) {
        const sure = winners.filter((c) => !threat(c, led, t, oppAfter, L));
        if (sure.length && (!L.save || !sure.every((c) => isPower(c, tr)))) return minBy(sure, (c) => spend(c, tr)).id;
      }
      return dump(legal, tr, L);
    }

    // соперник забирает: стоит ли бить
    if (winners.length) {
      const sure = last ? winners : winners.filter((c) => !threat(c, led, t, oppAfter, L));
      const pool = sure.length ? sure : winners;
      const card = minBy(pool, (c) => spend(c, tr) * 10 + pw(c) / 100);
      const gain = onTable + card.points;
      let worth = sure.length ? gain >= (L.save ? 4 : 0) || last : gain >= 10;
      // сильный бережёт мать и валетов на мелочь
      if (L.save && isPower(card, tr) && gain < 10 && left > 2) worth = false;
      if (worth) return card.id;
    }
    return dump(legal, tr, L);
  }

  // Скинуть: самую дешёвую карту
  function dump(legal, tr, L) {
    return minBy(legal, (c) => spend(c, tr) * 100 + K.power(c, tr, K.effSuit(c, tr))).id;
  }

  // Заход
  function lead(round, seat, L, t, legal, R) {
    const tr = round.trump;
    if (!L.memory) {
      const plain = legal.filter((c) => !K.isTrump(c, tr));
      return (plain.length ? plain : legal).reduce((a, b) => (a.points > b.points ? a : b));
    }
    const opps = [1, 3].map((k) => (seat + k) % 4), mate = K.opposite(seat);
    const after = [1, 2, 3].map((k) => (seat + k) % 4).filter((s) => K.teamOf(s) !== K.teamOf(seat));
    const sideSuit = (c) => K.effSuit(c, tr);
    const oppVoid = (s) => L.voids && opps.some((o) => t.voids[o][s] && !t.voids[o].T);
    // 1) верняк в боковой масти: старшая из оставшихся, и соперники не пустые по ней
    const tops = legal.filter((c) => !K.isTrump(c, tr) && !threat(c, sideSuit(c), t, after, Object.assign({}, L, { voids: true })) && !oppVoid(sideSuit(c)));
    const sureSide = legal.filter((c) => !K.isTrump(c, tr) && !t.unseen.some((u) => K.effSuit(u, tr) === sideSuit(c) && K.power(u, tr, sideSuit(c)) > K.power(c, tr, sideSuit(c))) && !oppVoid(sideSuit(c)));
    const strong = (L.voids ? tops : sureSide).filter((c) => c.points >= 10);
    if (strong.length) return maxBy(strong, (c) => c.points);
    // 2) вытянуть козыри: старший козырь у меня и козырей много
    const trumps = legal.filter((c) => K.isTrump(c, tr));
    if (L.save && trumps.length >= 3) {
      const top = maxBy(trumps, (c) => K.power(c, tr, 'T'));
      if (!t.unseen.some((u) => K.power(u, tr, 'T') > K.power(top, tr, 'T'))) return top;
    }
    // 3) деды: ход в масть, где кореш пустой (он перебьёт козырем), а соперники нет
    if (L.voids) {
      const viaMate = legal.filter((c) => !K.isTrump(c, tr) && t.voids[mate][sideSuit(c)] && !t.voids[mate].T && !oppVoid(sideSuit(c)) && c.points < 10);
      if (viaMate.length) return minBy(viaMate, (c) => c.points);
    }
    // 4) мелочь из длинной боковой масти, голых десяток и королей не светим
    const side = legal.filter((c) => !K.isTrump(c, tr));
    if (side.length) {
      const len = (s) => side.filter((c) => sideSuit(c) === s).length;
      const cheap = side.filter((c) => c.points < 10);
      const pool = cheap.length ? cheap : side;
      return minBy(pool, (c) => c.points * 10 - len(sideSuit(c)) + (L.save && oppVoid(sideSuit(c)) ? 50 : 0));
    }
    // одни козыри: с младшего (мать и валетов не светим)
    return minBy(legal, (c) => (isPower(c, tr) ? 100 : 0) + K.power(c, tr, 'T') / 100 + c.points);
  }

  // Поймает ли бот крысу (вероятность по уровню)
  const catchChance = (level) => lv(level).catch;

  const api = { LEVELS, choose, catchChance, table };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KozelAI = api;
})(typeof window !== 'undefined' ? window : globalThis);
