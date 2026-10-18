// KOZEL: реплики за столом после взяток. Общие для игры с ботами и для сервера.
(function (root) {
  'use strict';
  const L = {
    trumpWin: ['Ну что, взяли в ротик?', 'Козырем по щам!', 'Не ждали? А мы с козыря!', 'Опа, сюрпризик!', 'Бац, и нету вашей карты',
      'Козырёк в деле', 'А козырь-то вот он, родимый', 'Кушайте, не обляпайтесь', 'Это вам не в дурака', 'Шах и мат, пацаны',
      '<i>*бьёт козырем с размаху*</i>', 'Заверните, я беру'],
    trumpVictim: ['Ах ты ж козырная падла!', 'Ну ты и жук', 'Козырнул, гад', 'Это было больно', 'Да ёлки, я на неё надеялся',
      'Нечестно... но по правилам', 'Ой, всё', '<i>*хватается за сердце*</i>', 'Я это запомню', 'Ну ты и змей'],
    bigWin: ['Опа, моё!', 'Забираю, не плачь', 'Как с куста', 'Учись, пока я живой', '<i>*смачно сгребает карты*</i>', 'Фарт пошёл',
      'Жирная, ммм', 'Иди к папочке', 'Спасибо за подгон'],
    bigLoss: ['Ну ёлы-палы', 'Фартануло ему', 'Да ну нафиг', '<i>*чешет затылок*</i>', 'Карта не прёт', 'Ничё, отыграемся', 'Обидно, да'],
    emptyWin: ['Мусор забрал, поздравляю', 'Пустышка, а приятно', 'Ноль очков, зато красиво', 'Взял воздух', 'Богатый улов, ага'],
    feed: ['Держи, кореш, десяточку', 'Подкинул тебе жирка', 'На, не жалко', '<i>*подмигивает корешу*</i>', 'Это тебе на пивко'],
    mother: ['Мать пришла, всем сидеть!', 'Мамка всех построила', 'С матерью не спорят', 'Мать есть мать'],
    jack: ['Валетом по столу!', 'Валет решает', 'Валетик, родной', 'Вот где валет зарыт'],
  };
  const pick = (a) => a[Math.floor(Math.random() * a.length)];

  // plays: [{seat, card}] одной взятки; вернёт [{seat, text, delay}] — кто что скажет
  function chatter(plays, winner, trump, points, K) {
    const out = [];
    if (Math.random() < 0.2) return out; // иногда все молчат
    const led = K.effSuit(plays[0].card, trump);
    const wc = plays.find((p) => p.seat === winner).card;
    if (wc.rank === '6' && wc.suit === trump && Math.random() < 0.7) {
      out.push({ seat: winner, text: pick(L.mother) });
    } else if (led !== 'T' && K.isTrump(wc, trump)) {
      out.push({ seat: winner, text: pick(L.trumpWin) });
      const victims = plays.filter((p) => K.teamOf(p.seat) !== K.teamOf(winner) && K.effSuit(p.card, trump) === led);
      if (victims.length && Math.random() < 0.65) {
        const v = victims.reduce((a, b) => (K.power(a.card, trump, led) >= K.power(b.card, trump, led) ? a : b));
        out.push({ seat: v.seat, text: pick(L.trumpVictim), delay: 1000 });
      }
    } else if (points >= 20) {
      out.push({ seat: winner, text: pick(L.bigWin) });
      if (Math.random() < 0.45) out.push({ seat: (winner + 1) % 4, text: pick(L.bigLoss), delay: 1000 });
    } else if (points === 0 && Math.random() < 0.6) {
      out.push({ seat: winner, text: pick(L.emptyWin) });
    } else if (wc.rank === 'J' && Math.random() < 0.6) {
      out.push({ seat: winner, text: pick(L.jack) });
    }
    const feeder = plays.find((p) => p.seat === (winner + 2) % 4 && p.card.points >= 10);
    if (feeder && Math.random() < 0.5 && !out.some((o) => o.seat === feeder.seat)) out.push({ seat: feeder.seat, text: pick(L.feed), delay: 600 });
    return out;
  }

  const api = { L, chatter };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KozelLines = api;
})(typeof window !== 'undefined' ? window : globalThis);
