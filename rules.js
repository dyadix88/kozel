// KOZEL: ядро правил. Без интерфейса и сети, работает в Node и в браузере.
(function (root) {
  'use strict';
  const SUITS = ['C', 'S', 'H', 'D']; // крести, пики, черви, бубны
  const SUIT_SYMBOL = { C: '♣', S: '♠', H: '♥', D: '♦' };
  const RANKS = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const POINTS = { A: 11, '10': 10, K: 4, Q: 3, J: 2, '9': 0, '8': 0, '7': 0, '6': 0 };

  // Места по часовой стрелке: 0, 1, 2, 3. Напротив сидит напарник.
  const opposite = (s) => (s + 2) % 4;
  const teamOf = (s) => s % 2;

  function createDeck() {
    const deck = [];
    for (const suit of SUITS)
      for (const rank of RANKS) deck.push({ id: rank + suit, rank, suit, points: POINTS[rank] });
    return deck;
  }

  // Честный криптографический случай без смещения: никаких «выравниваний» рук.
  function randomInt(n) {
    const c = root.crypto || require('crypto').webcrypto;
    const limit = Math.floor(0x100000000 / n) * n;
    const buf = new Uint32Array(1);
    do { c.getRandomValues(buf); } while (buf[0] >= limit);
    return buf[0] % n;
  }

  function shuffle(deck) {
    const d = deck.slice();
    for (let i = d.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [d[i], d[j]] = [d[j], d[i]];
    }
    return d;
  }

  function dealHands() {
    const d = shuffle(createDeck());
    return [0, 1, 2, 3].map((s) => d.slice(s * 9, s * 9 + 9));
  }

  const holderOf = (hands, id) => hands.findIndex((h) => h.some((c) => c.id === id));

  // Состояние матча: постоянные масти хвала, штрафы до 12, яйца.
  function newMatch() {
    return { praise: [null, null, null, null], penalties: [0, 0], eggs: [0, 0] };
  }

  // Кому первому в матче достался J♣: он крести, напарник пики.
  // Другой паре: кому первому достался J♣, тот черви, напарник бубны.
  function assignPraise(match, holder) {
    if (match.praise[holder]) return match.praise[holder];
    const [mine, partner] = match.praise.some(Boolean) ? ['H', 'D'] : ['C', 'S'];
    match.praise[holder] = mine;
    match.praise[opposite(holder)] = partner;
    return mine;
  }

  // Начало раздачи: первым ходит хвал (J♣), козырь это его масть хвала.
  function startRound(match) {
    const hands = dealHands();
    const hvalSeat = holderOf(hands, 'JC');
    const trump = assignPraise(match, hvalSeat);
    return { hands, hvalSeat, trump, leader: hvalSeat };
  }

  // Таблица штрафов. h: карточные очки команды, которая хвалила (всего 120).
  function roundPenalties(h) {
    const o = 120 - h;
    if (h === 0) return { praise: 12, other: 0, lusya: 'praise' };
    if (o === 0) return { praise: 0, other: 6, lusya: 'other' };
    if (h === 60) return { praise: 2, other: 0, egg: true };
    if (h <= 29) return { praise: 3, other: 0 };
    if (h <= 59) return { praise: 2, other: 0 };
    if (o <= 29) return { praise: 0, other: 2 };
    return { praise: 0, other: 1 }; // соперники набрали от 30 до 59
  }

  function applyRound(match, hvalSeat, h) {
    const r = roundPenalties(h);
    const t = teamOf(hvalSeat);
    match.penalties[t] += r.praise;
    match.penalties[1 - t] += r.other;
    if (r.egg) match.eggs[t] += 1;
    return r;
  }


  // ---------- Взятки ----------
  // Козырь: любой валет или любая карта козырной масти. Валет не считается картой своей масти.
  const isTrump = (c, trump) => c.rank === 'J' || c.suit === trump;
  const effSuit = (c, trump) => (isTrump(c, trump) ? 'T' : c.suit);
  const JACKS = ['JC', 'JS', 'JH', 'JD'];
  const PLAIN = ['A', '10', 'K', 'Q', '9', '8', '7', '6'];

  // Сила карты во взятке. 0 значит карта взятку взять не может.
  function power(c, trump, led) {
    if (isTrump(c, trump)) {
      if (c.rank === '6') return 1000;                       // мать
      if (c.rank === 'J') return 900 - JACKS.indexOf(c.id) * 10; // хвал, пикаш, черваш, бубнаш
      return 800 - PLAIN.indexOf(c.rank) * 10;               // туз ... семёрка козырей
    }
    if (c.suit === led) return 100 - PLAIN.indexOf(c.rank) * 10;
    return 0;
  }

  // Что игрок обязан положить: масть первого хода, если она есть. Иначе любую карту.
  function legalCards(hand, trickCards, trump) {
    if (!trickCards.length) return hand.slice();
    const led = effSuit(trickCards[0], trump);
    const follow = hand.filter((c) => effSuit(c, trump) === led);
    return follow.length ? follow : hand.slice();
  }

  // Индекс победившей карты во взятке.
  function trickWinner(cards, trump) {
    const led = effSuit(cards[0], trump);
    let best = 0;
    cards.forEach((c, i) => { if (power(c, trump, led) > power(cards[best], trump, led)) best = i; });
    return best;
  }

  // Раздача целиком: ходы, взятки, скрытая история, проверки.
  function newRound(match) {
    const r = startRound(match);
    return Object.assign(r, { turn: r.leader, trick: [], tricks: [], taken: [0, 0], log: [], over: false, end: null });
  }

  // Сыграть карту. Нарушение масти разрешено, но тайно записывается в историю.
  function play(match, round, seat, cardId) {
    if (round.over) throw new Error('Раздача уже закончена');
    if (seat !== round.turn) throw new Error('Сейчас не твой ход');
    const hand = round.hands[seat];
    const i = hand.findIndex((c) => c.id === cardId);
    if (i < 0) throw new Error('Такой карты нет в руке');
    const legal = legalCards(hand, round.trick.map((e) => e.card), round.trump).map((c) => c.id);
    const card = hand.splice(i, 1)[0];
    const entry = { seat, card, trickNo: round.tricks.length, legal, violation: !legal.includes(card.id), checked: false };
    round.trick.push(entry);
    round.log.push(entry);
    if (round.trick.length < 4) { round.turn = (seat + 1) % 4; return { trickDone: false }; }

    const cards = round.trick.map((e) => e.card);
    const winner = round.trick[trickWinner(cards, round.trump)].seat;
    const points = cards.reduce((s, c) => s + c.points, 0);
    round.taken[teamOf(winner)] += points;
    round.tricks.push({ plays: round.trick, winner, points });
    round.trick = [];
    round.turn = winner; // следующую взятку начинает тот, кто взял
    if (round.tricks.length === 9) {
      const h = round.taken[teamOf(round.hvalSeat)];
      round.over = true;
      round.end = Object.assign({ type: 'cards', h }, applyRound(match, round.hvalSeat, h));
    }
    return { trickDone: true, winner, points };
  }

  // Проверка: соперник указывает конкретный ход. Сервер смотрит в скрытую историю.
  function accuse(match, round, accuser, trickNo, accused) {
    if (round.over) throw new Error('Раздача уже закончена');
    if (teamOf(accuser) === teamOf(accused)) throw new Error('Проверять можно только соперников');
    const e = round.log.find((x) => x.trickNo === trickNo && x.seat === accused);
    if (!e) throw new Error('Такого хода не было');
    if (e.checked) throw new Error('Этот ход уже проверяли');
    e.checked = true;
    const guilty = e.violation;
    const team = guilty ? teamOf(accused) : teamOf(accuser);
    match.penalties[team] += 3;
    if (guilty) { round.over = true; round.end = { type: 'caught', team, accused, trickNo }; }
    return { guilty, team };
  }

  const matchLoser = (m) => (m.penalties[0] >= 12 ? 0 : m.penalties[1] >= 12 ? 1 : null);

  const api = { SUITS, SUIT_SYMBOL, RANKS, POINTS, opposite, teamOf, createDeck, shuffle,
    dealHands, holderOf, newMatch, assignPraise, startRound, roundPenalties, applyRound, matchLoser,
    isTrump, effSuit, power, legalCards, trickWinner, newRound, play, accuse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Kozel = api;
})(typeof window !== 'undefined' ? window : globalThis);
