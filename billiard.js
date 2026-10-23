// Бильярд: физика, правила русского бильярда (три варианта) и боты.
// Работает и в Node (сервер), и в браузере (как rules.js). Только +, -, *, / и sqrt в физике,
// поэтому удар считается одинаково везде: сервер и браузеры видят одну и ту же партию.
(function (root) {
  'use strict';

  // ---------- Стол ----------
  // Поле в условных единицах: длина 256, ширина 100 (как сукно на картинке Белладжио). Шар радиусом 2.45.
  const T = {
    W: 256, H: 100, R: 2.45,
    corner: 6,       // насколько от угла начинается борт (ширина угловой лузы вдоль борта)
    side: 6.5,       // половина ширины средней лузы
    potIn: 1.6,      // насколько центр шара должен уйти за линию борта, шоб упасть
    kitchen: 256 * 0.25, // «дом»: левая четверть стола, отсюда бьют с руки
  };
  T.headX = T.kitchen;            // где ставим биток в начале
  T.footX = T.W * 0.72;           // вершина пирамиды
  // лузы (для прицела ботов и рисования): точки чуть внутри дыр
  T.pockets = [
    { x: -1.2, y: -1.2, c: 1 }, { x: T.W / 2, y: -2.6, c: 0 }, { x: T.W + 1.2, y: -1.2, c: 1 },
    { x: -1.2, y: T.H + 1.2, c: 1 }, { x: T.W / 2, y: T.H + 2.6, c: 0 }, { x: T.W + 1.2, y: T.H + 1.2, c: 1 },
  ];
  // губки луз: концы бортов, о них шар тоже отскакивает
  const JAWS = [
    [T.corner, 0], [0, T.corner], [T.W - T.corner, 0], [T.W, T.corner],
    [0, T.H - T.corner], [T.corner, T.H], [T.W - T.corner, T.H], [T.W, T.H - T.corner],
    [T.W / 2 - T.side, 0], [T.W / 2 + T.side, 0], [T.W / 2 - T.side, T.H], [T.W / 2 + T.side, T.H],
  ];

  // ---------- Бильярдные ----------
  // Новая бильярдная = две картинки в assets/billiard (<id>-hall.png — зал, <id>-table.png — стол строго сверху, 16:9)
  // и одна строчка тут. felt — где на картинке стола сукно (края бортов), в процентах: [лево, верх, право, низ].
  const HALLS = [
    { id: 'bellagio', name: 'Белладжио', desc: 'Местный пафосный клуб: люстры, бархат, бар. Кий держи ровно, тут на тебя смотрят', felt: [7.476, 17.003, 92.524, 75.983], music: 'blat' },
    // banya, bar: картинки владельца (2.91), felt померен по борта́м (чуть растянут по высоте, как у Белладжио)
    { id: 'banya', name: 'Супер-баня', desc: 'Баня на Черёмушках: пар, веники, самовар и стол посреди парилки. Кий не урони в тазик', felt: [7.9, 17.5, 92.3, 79], music: 'dacha' },
    { id: 'bar', name: 'Местный бар', desc: 'Бар возле БАЗЫ: кафель, вобла, пиво и стол с прожжённым сукном. Тут играют все свои', felt: [10, 17, 90, 79], music: 'disco' },
  ];

  // ---------- Физика ----------
  const PH = {
    dt: 1 / 600,       // шаг расчёта, с
    vmax: 330,         // скорость битка при полной силе, ед/с
    roll: 38,          // торможение о сукно, ед/с²
    drag: 0.18,        // сопротивление (доля скорости в секунду)
    eBall: 0.95,       // упругость шар-шар
    eRail: 0.78,       // упругость борта
    eJaw: 0.6,         // упругость губки лузы
    stop: 0.6,         // ниже этой скорости шар стоит
    jump: 0.93,        // удар в борт быстрее этой доли vmax почти в лоб — шар вылетает со стола
    maxT: 25,          // больше 25 секунд стол не катится (на всякий случай)
  };

  // Состояние: { balls: [{ n, x, y, out }] }, n = 0 — биток, 1..15 — прицельные
  function rack(seed) {
    let s = (seed >>> 0) || 12345;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const nums = []; for (let i = 1; i <= 15; i++) nums.push(i);
    for (let i = nums.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = nums[i]; nums[i] = nums[j]; nums[j] = t; }
    const balls = [{ n: 0, x: T.headX, y: T.H / 2, out: false }];
    const d = T.R * 2 + 0.02, dx = d * 0.8660254037844386;
    let k = 0;
    for (let row = 0; row < 5; row++) for (let i = 0; i <= row; i++) balls.push({ n: nums[k++], x: T.footX + row * dx, y: T.H / 2 + (i - row / 2) * d, out: false });
    return { balls };
  }
  const clone = (st) => ({ balls: st.balls.map((b) => ({ n: b.n, x: b.x, y: b.y, out: b.out })) });

  // Удар: dx, dy — направление (любой длины), power 0..1. Возвращает итог и события для звука и правил.
  // onFrame(t, balls) — если надо, вызывается каждые ~1/60 с (для записи кадров)
  function simulate(state, shot, onFrame) {
    const st = clone(state);
    const B = st.balls.filter((b) => !b.out).map((b) => ({ n: b.n, x: b.x, y: b.y, vx: 0, vy: 0, out: false, ref: b }));
    const sn = shot.ball === undefined ? 0 : +shot.ball; // каким шаром бьём (в «Местном» — любым)
    const cue = B.find((b) => b.n === sn);
    const ev = { striker: sn, first: null, pocketed: [], off: [], rails: 0, cueRailsBeforeHit: 0, hits: [], t: 0 };
    if (!cue) return { state: st, ev };
    const len = Math.sqrt(shot.dx * shot.dx + shot.dy * shot.dy) || 1;
    const p = Math.max(0.02, Math.min(1, +shot.power || 0));
    cue.vx = shot.dx / len * PH.vmax * p; cue.vy = shot.dy / len * PH.vmax * p;
    const R = T.R, D = 2 * R, D2 = D * D, dt = PH.dt, decel = PH.roll * dt, dragK = 1 - PH.drag * dt, stop2 = PH.stop * PH.stop;
    const jumpV = PH.vmax * PH.jump;
    let t = 0, frameT = 0, moving = true;
    const inGapX = (x) => x < T.corner || x > T.W - T.corner || (x > T.W / 2 - T.side && x < T.W / 2 + T.side);
    const inGapY = (y) => y < T.corner || y > T.H - T.corner;
    const pot = (b) => { b.out = true; b.vx = 0; b.vy = 0; ev.pocketed.push(b.n); ev.hits.push({ t, k: 'pot', n: b.n }); };
    const fly = (b) => { b.out = true; b.vx = 0; b.vy = 0; ev.off.push(b.n); ev.hits.push({ t, k: 'off', n: b.n }); };
    while (moving && t < PH.maxT) {
      t += dt; moving = false;
      for (const b of B) {
        if (b.out) continue;
        const v2 = b.vx * b.vx + b.vy * b.vy;
        if (v2 === 0) continue;
        const v = Math.sqrt(v2);
        let nv = v * dragK - decel;
        if (nv <= 0 || nv * nv < stop2) { b.vx = 0; b.vy = 0; continue; }
        b.vx *= nv / v; b.vy *= nv / v;
        b.x += b.vx * dt; b.y += b.vy * dt;
        moving = true;
      }
      // шар-шар
      for (let i = 0; i < B.length; i++) {
        const a = B[i]; if (a.out) continue;
        for (let j = i + 1; j < B.length; j++) {
          const c = B[j]; if (c.out) continue;
          const dx = c.x - a.x, dy = c.y - a.y, d2 = dx * dx + dy * dy;
          if (d2 >= D2 || d2 === 0) continue;
          const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
          // раздвигаем
          const ov = (D - d) / 2; a.x -= nx * ov; a.y -= ny * ov; c.x += nx * ov; c.y += ny * ov;
          const rv = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny;
          if (rv >= 0) continue;
          const jimp = -(1 + PH.eBall) * rv / 2;
          a.vx -= jimp * nx; a.vy -= jimp * ny; c.vx += jimp * nx; c.vy += jimp * ny;
          if (ev.first === null && (a.n === sn || c.n === sn)) ev.first = a.n === sn ? c.n : a.n;
          ev.hits.push({ t, k: 'ball', v: -rv });
          moving = true;
        }
      }
      // борта, губки, лузы
      for (const b of B) {
        if (b.out) continue;
        // губки луз
        for (const [jx, jy] of JAWS) {
          const dx = b.x - jx, dy = b.y - jy, d2 = dx * dx + dy * dy;
          if (d2 >= R * R || d2 === 0) continue;
          const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, vn = b.vx * nx + b.vy * ny;
          b.x = jx + nx * R; b.y = jy + ny * R;
          if (vn < 0) { b.vx -= (1 + PH.eJaw) * vn * nx; b.vy -= (1 + PH.eJaw) * vn * ny; ev.hits.push({ t, k: 'rail', v: -vn }); }
        }
        // длинные борта (верх и низ)
        if (b.y < R && !inGapX(b.x)) {
          if (b.vy < 0) { if (-b.vy > jumpV && Math.abs(b.vx) < -b.vy * 0.35) { fly(b); continue; } b.vy = -b.vy * PH.eRail; b.vx *= 0.97; ev.rails++; if (b.n === sn && ev.first === null) ev.cueRailsBeforeHit++; ev.hits.push({ t, k: 'rail', v: -b.vy }); }
          b.y = R;
        } else if (b.y > T.H - R && !inGapX(b.x)) {
          if (b.vy > 0) { if (b.vy > jumpV && Math.abs(b.vx) < b.vy * 0.35) { fly(b); continue; } b.vy = -b.vy * PH.eRail; b.vx *= 0.97; ev.rails++; if (b.n === sn && ev.first === null) ev.cueRailsBeforeHit++; ev.hits.push({ t, k: 'rail', v: b.vy }); }
          b.y = T.H - R;
        }
        // короткие борта (лево и право)
        if (b.x < R && !inGapY(b.y)) {
          if (b.vx < 0) { if (-b.vx > jumpV && Math.abs(b.vy) < -b.vx * 0.35) { fly(b); continue; } b.vx = -b.vx * PH.eRail; b.vy *= 0.97; ev.rails++; if (b.n === sn && ev.first === null) ev.cueRailsBeforeHit++; ev.hits.push({ t, k: 'rail', v: -b.vx }); }
          b.x = R;
        } else if (b.x > T.W - R && !inGapY(b.y)) {
          if (b.vx > 0) { if (b.vx > jumpV && Math.abs(b.vy) < b.vx * 0.35) { fly(b); continue; } b.vx = -b.vx * PH.eRail; b.vy *= 0.97; ev.rails++; if (b.n === sn && ev.first === null) ev.cueRailsBeforeHit++; ev.hits.push({ t, k: 'rail', v: b.vx }); }
          b.x = T.W - R;
        }
        // упал в лузу: центр ушёл за линию борта в проёме
        if (b.y < -T.potIn || b.y > T.H + T.potIn || b.x < -T.potIn || b.x > T.W + T.potIn) pot(b);
        // страховка: шар никак не может оказаться далеко за столом
        else if (b.x < -R * 3 || b.x > T.W + R * 3 || b.y < -R * 3 || b.y > T.H + R * 3) pot(b);
      }
      if (onFrame && t - frameT >= 1 / 60) { frameT = t; onFrame(t, B); }
    }
    ev.t = t;
    for (const b of B) { b.ref.x = b.x; b.ref.y = b.y; b.ref.out = b.out; }
    return { state: st, ev };
  }

  // ---------- Правила ----------
  // Все три варианта в одном месте. Владелец может поправить под «как у нас во дворе».
  const VARIANTS = {
    free: {
      name: 'Свободная', sub: 'американка',
      desc: 'Забивать можно любой шар, свояк (биток в лузу) засчитывается. После свояка бьёшь дальше с руки из «дома».',
      cueCounts: true,           // биток в лузе после касания = очко
      afterCue: 'self',          // после свояка: self — сам с руки, opp — ход сопернику с руки
      cueFoul: false,            // биток в лузе = штраф
      returnOnFoul: false,       // при штрафе возвращаем на стол один твой забитый шар
    },
    // «Местный» (правила владельца): бьёшь любым шаром в любой, главное — задеть другой шар.
    // Не задел — штраф, соперник ставит любой шар куда хочет и бьёт. Чёрный (8) — последним: сперва 7 любых, потом чёрный.
    // Забил чёрный раньше — проиграл. Ключ moscow оставлен, шоб старые настройки не сломались.
    moscow: {
      name: 'Местный', sub: 'как у нас',
      desc: 'Бьёшь любым шаром в любой шар, главное — задеть другой шар. Не задел — соперник ставит шар куда хочет. Забей 7 любых, а потом чёрный. Чёрный раньше времени — проиграл.',
      any: true, black: 8, need: 7, cueCounts: true, afterCue: 'self', cueFoul: false, returnOnFoul: false,
    },
    nevsky: {
      name: 'Невская', sub: '',
      desc: 'Забивать только прицельные шары. Биток в лузе — штраф, и один твой забитый шар возвращается на стол.',
      cueCounts: false, afterCue: 'opp', cueFoul: true, returnOnFoul: true,
    },
  };
  const TO_WIN = 8;

  // Новая партия. n — сколько игроков (2 или 4), variant — ключ VARIANTS
  function newGame(n, variant, seed) {
    const v = VARIANTS[variant] ? variant : 'free';
    return { n: n === 4 ? 4 : 2, variant: v, state: rack(seed || Date.now()), turn: 0, score: [0, 0], hand: !VARIANTS[v].any, over: false, winner: null, shots: 0, last: null, seed: seed || 0 };
  }
  const teamOf = (g, seat) => seat % 2;
  const nextSeat = (g, seat) => (seat + 1) % g.n;

  // свободная точка для шара: на линии от точки вправо/влево, шоб ни с кем не пересекаться
  function freeSpot(state, x, y) {
    const D = T.R * 2 + 0.05;
    for (let k = 0; k < 200; k++) {
      const off = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 1.2;
      const cx = Math.min(T.W - T.R, Math.max(T.R, x + off)), cy = y;
      if (state.balls.every((b) => b.out || (b.x - cx) * (b.x - cx) + (b.y - cy) * (b.y - cy) >= D * D)) return { x: cx, y: cy };
    }
    return { x, y: T.R + 1 };
  }
  // можно ли поставить биток сюда (в «дом», не на шар)
  function canPlace(state, x, y) {
    if (x < T.R || x > T.kitchen || y < T.R || y > T.H - T.R) return false;
    const D = T.R * 2 + 0.05;
    return state.balls.every((b) => b.out || b.n === 0 || (b.x - x) * (b.x - x) + (b.y - y) * (b.y - y) >= D * D);
  }

  // «Местный»: шар с руки ставится в любое место стола, лишь бы не на другой шар
  function canPlaceAny(state, n, x, y) {
    if (x < T.R || x > T.W - T.R || y < T.R || y > T.H - T.R) return false;
    const D = T.R * 2 + 0.05;
    return state.balls.every((b) => b.out || b.n === n || (b.x - x) * (b.x - x) + (b.y - y) * (b.y - y) >= D * D);
  }
  // Сыграть удар в партии g. shot: { dx, dy, power, place?: {x, y} } (place — куда поставил биток с руки).
  // Возвращает { ok, error, sim, judge } и меняет g.
  function applyShot(g, shot) {
    if (g.over) return { ok: false, error: 'Партия окончена' };
    if (VARIANTS[g.variant].any) return applyAny(g, shot);
    const st = g.state, cue = st.balls.find((b) => b.n === 0);
    if (g.hand) {
      const pl = shot.place || { x: cue.x, y: cue.y };
      if (!canPlace(st, pl.x, pl.y)) return { ok: false, error: 'Биток ставь в «дом», не на шар' };
      cue.x = +pl.x; cue.y = +pl.y; cue.out = false;
    }
    const before = { balls: st.balls.map((b) => ({ n: b.n, x: b.x, y: b.y, out: b.out })) };
    const sim = simulate(st, shot);
    const j = judge(g, sim.ev);
    g.state = sim.state;
    const V = VARIANTS[g.variant], shooter = g.turn, team = teamOf(g, shooter);
    // вернуть шары на стол: вылетевшие прицельные и (при штрафе) забитые в этом ударе
    const back = j.returnBalls.slice();
    for (const n of back) { const b = g.state.balls.find((x) => x.n === n); const p = freeSpot(g.state, T.footX, T.H / 2); b.x = p.x; b.y = p.y; b.out = false; }
    if (j.foul && V.returnOnFoul && g.score[team] > 0) {
      const lost = g.state.balls.find((b) => b.out && b.n !== 0);
      if (lost) { const p = freeSpot(g.state, T.footX, T.H / 2); lost.x = p.x; lost.y = p.y; lost.out = false; g.score[team]--; j.returned = lost.n; }
    }
    g.score[team] += j.points;
    // биток упал или улетел: вернётся с руки
    const cb = g.state.balls.find((b) => b.n === 0);
    if (cb.out) { const p = freeSpot(g.state, T.headX, T.H / 2); cb.x = p.x; cb.y = p.y; cb.out = false; }
    g.shots++;
    if (g.score[team] >= TO_WIN) { g.over = true; g.winner = team; }
    else if (!g.state.balls.some((b) => b.n !== 0 && !b.out)) { g.over = true; g.winner = g.score[0] === g.score[1] ? team : g.score[0] > g.score[1] ? 0 : 1; }
    g.hand = j.hand; if (!j.again) g.turn = nextSeat(g, shooter);
    g.last = { seat: shooter, shot: { dx: shot.dx, dy: shot.dy, power: shot.power }, before, judge: j };
    return { ok: true, sim, judge: j, before };
  }

  // «Местный»: удар любым шаром, чёрный последним
  function applyAny(g, shot) {
    const st = g.state, V = VARIANTS[g.variant];
    const sn = shot.ball === undefined ? 0 : +shot.ball, sb = st.balls.find((b) => b.n === sn && !b.out);
    if (!sb) return { ok: false, error: 'Таким шаром не ударить' };
    if (g.hand && shot.place) {
      const pl = shot.place, pn = pl.n === undefined ? sn : +pl.n, pb = st.balls.find((b) => b.n === pn && !b.out);
      if (!pb || !canPlaceAny(st, pn, +pl.x, +pl.y)) return { ok: false, error: 'Шар ставь на свободное место стола' };
      pb.x = +pl.x; pb.y = +pl.y;
    }
    const before = { balls: st.balls.map((b) => ({ n: b.n, x: b.x, y: b.y, out: b.out })) };
    const sh = { dx: shot.dx, dy: shot.dy, power: shot.power, ball: sn };
    const sim = simulate(st, sh);
    const j = judge(g, sim.ev);
    g.state = sim.state;
    const shooter = g.turn, team = teamOf(g, shooter);
    for (const n of j.returnBalls) { const b = g.state.balls.find((x) => x.n === n); const p = freeSpot(g.state, T.footX, T.H / 2); b.x = p.x; b.y = p.y; b.out = false; }
    g.score[team] += j.points;
    g.shots++;
    if (j.blackWin) { g.over = true; g.winner = team; }
    else if (j.blackLoss) { g.over = true; g.winner = 1 - team; }
    else if (!g.state.balls.some((b) => !b.out && b.n !== V.black)) { // остался один чёрный, а забивать некому — по счёту
      const b8 = g.state.balls.find((b) => b.n === V.black); if (b8 && b8.out) { g.over = true; g.winner = g.score[0] >= g.score[1] ? 0 : 1; }
    }
    g.hand = j.hand; if (!j.again) g.turn = nextSeat(g, shooter);
    g.last = { seat: shooter, shot: sh, before, judge: j };
    return { ok: true, sim, judge: j, before };
  }
  // Разбор удара: штраф, очки, кто бьёт дальше
  function judge(g, ev) {
    const V = VARIANTS[g.variant];
    if (V.any) {
      const team = teamOf(g, g.turn), pot = ev.pocketed.slice(), B = V.black;
      let foul = null;
      if (ev.first === null) foul = 'Не задел ни одного шара';
      else if (ev.off.length) foul = 'Шар вылетел со стола';
      const r = { foul, points: 0, again: false, hand: false, cue: false, potted: pot.filter((n) => n !== B), off: ev.off.slice(), returnBalls: ev.off.slice(), returned: null, svoyak: pot.includes(ev.striker) && !foul, black: pot.includes(B) };
      if (foul) { r.returnBalls = r.returnBalls.concat(pot); r.hand = true; return r; } // забитое не считается, соперник ставит шар куда хочет
      r.points = pot.filter((n) => n !== B).length;
      if (pot.includes(B)) { if (g.score[team] + r.points >= V.need) r.blackWin = true; else r.blackLoss = true; }
      r.again = r.points > 0;
      return r;
    }
    const objPot = ev.pocketed.filter((n) => n !== 0), cuePot = ev.pocketed.includes(0), offObj = ev.off.filter((n) => n !== 0), cueOff = ev.off.includes(0);
    let foul = null;
    if (ev.first === null) foul = cuePot ? 'Биток в лузе без касания' : 'Не попал ни в один шар';
    else if (ev.off.length) foul = 'Шар вылетел со стола';
    else if (cuePot && V.cueFoul) foul = 'Биток в лузе';
    const r = { foul, points: 0, again: false, hand: false, cue: cuePot, potted: objPot.slice(), off: ev.off.slice(), returnBalls: offObj.slice(), returned: null, svoyak: false };
    if (foul) {
      r.returnBalls = r.returnBalls.concat(objPot); // при штрафе забитое не считается и возвращается
      r.hand = true; r.again = false;
      return r;
    }
    r.points = objPot.length + (cuePot && V.cueCounts ? 1 : 0);
    r.svoyak = cuePot && V.cueCounts;
    if (cuePot) { r.hand = true; r.again = V.afterCue === 'self' && r.points > 0; }
    else r.again = r.points > 0;
    if (cueOff) r.hand = true;
    return r;
  }

  // ---------- Боты ----------
  // 0 — мажет, 1 — нормальный, 2 — снайпер
  const BOT = [
    { name: 'мажет', aim: 2.6, pow: 0.22, look: 4, think: [1200, 2400] },
    { name: 'нормальный', aim: 0.9, pow: 0.1, look: 8, think: [900, 1900] },
    { name: 'снайпер', aim: 0.22, pow: 0.04, look: 14, think: [700, 1500] },
  ];
  function segDist2(px, py, ax, ay, bx, by) {
    const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
    let k = l2 ? ((px - ax) * vx + (py - ay) * vy) / l2 : 0; k = Math.max(0, Math.min(1, k));
    const qx = ax + vx * k - px, qy = ay + vy * k - py;
    return qx * qx + qy * qy;
  }
  // варианты ударов: шар → луза через «призрачный шар», путь чистый
  function candidates(st, cue, variant) {
    const out = [], D = T.R * 2;
    const live = st.balls.filter((b) => !b.out && b.n !== 0);
    for (const b of live) for (const p of T.pockets) {
      const tx = p.x - b.x, ty = p.y - b.y, tl = Math.sqrt(tx * tx + ty * ty);
      const ux = tx / tl, uy = ty / tl, gx = b.x - ux * D, gy = b.y - uy * D;
      const ax = gx - cue.x, ay = gy - cue.y, al = Math.sqrt(ax * ax + ay * ay);
      if (al < 0.5) continue;
      const cut = (ax * ux + ay * uy) / al; // косинус угла резки
      if (cut < 0.2) continue;
      // средняя луза под острым углом не берётся
      if (!p.c && Math.abs(uy) < 0.55) continue;
      let clear = true;
      for (const o of live) {
        if (o === b) continue;
        if (segDist2(o.x, o.y, cue.x, cue.y, gx, gy) < D * D * 0.98) { clear = false; break; }
        if (segDist2(o.x, o.y, b.x, b.y, p.x, p.y) < D * D * 0.9) { clear = false; break; }
      }
      if (!clear) continue;
      const score = cut * cut * 100 / (al * 0.35 + tl + 25);
      const pow = Math.min(1, 0.18 + (al + tl / Math.max(cut, 0.3)) / 330);
      out.push({ dx: ax, dy: ay, power: pow, score, target: b.n, pocket: p });
    }
    return out.sort((a, b) => b.score - a.score);
  }
  // «Местный»: перебираем, каким шаром бить, по какому и в какую лузу
  function candidatesAny(g, st, override) {
    const V = VARIANTS[g.variant], team = teamOf(g, g.turn), canBlack = g.score[team] >= V.need;
    const live = st.balls.filter((b) => !b.out), out = [], D = T.R * 2;
    const pos = (b) => (override && override.n === b.n ? override : b);
    for (const s0 of live) {
      if (s0.n === V.black && !canBlack) continue; // чёрным не бьём, пока рано
      const s = pos(s0);
      for (const b0 of live) {
        if (b0 === s0 || (b0.n === V.black && !canBlack)) continue;
        const b = pos(b0);
        for (const p of T.pockets) {
          const tx = p.x - b.x, ty = p.y - b.y, tl = Math.sqrt(tx * tx + ty * ty);
          const ux = tx / tl, uy = ty / tl, gx = b.x - ux * D, gy = b.y - uy * D;
          const ax = gx - s.x, ay = gy - s.y, al = Math.sqrt(ax * ax + ay * ay);
          if (al < 0.5) continue;
          const cut = (ax * ux + ay * uy) / al;
          if (cut < 0.25 || (!p.c && Math.abs(uy) < 0.55)) continue;
          let clear = true;
          for (const o0 of live) {
            if (o0 === s0 || o0 === b0) continue; const o = pos(o0);
            if (segDist2(o.x, o.y, s.x, s.y, gx, gy) < D * D * 0.98 || segDist2(o.x, o.y, b.x, b.y, p.x, p.y) < D * D * 0.9) { clear = false; break; }
          }
          if (!clear) continue;
          out.push({ dx: ax, dy: ay, power: Math.min(1, 0.18 + (al + tl / Math.max(cut, 0.3)) / 330), score: cut * cut * 100 / (al * 0.35 + tl + 25), ball: s0.n, target: b0.n });
        }
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }
  function botShotAny(g, L, rnd) {
    const V = VARIANTS[g.variant], st = g.state;
    let place = null, override = null, cands;
    if (g.hand) { // штраф соперника: ставим любой шар туда, откуда удобнее всего
      let best = null;
      const pool = st.balls.filter((b) => !b.out && b.n !== V.black);
      for (let k = 0; k < 40; k++) {
        const b = pool[Math.floor(rnd() * pool.length)]; if (!b) break;
        const x = T.R + 1 + rnd() * (T.W - 2 * T.R - 2), y = T.R + 1 + rnd() * (T.H - 2 * T.R - 2);
        if (!canPlaceAny(st, b.n, x, y)) continue;
        const c = candidatesAny(g, st, { n: b.n, x, y }).filter((q) => q.ball === b.n)[0];
        if (c && (!best || c.score > best.c.score)) best = { n: b.n, x, y, c };
      }
      if (best) { place = { n: best.n, x: best.x, y: best.y }; override = place; }
    }
    if (g.shots === 0) { // разбой: белым в пирамиду
      const cue = st.balls.find((b) => b.n === 0), apex = st.balls.filter((b) => b.n !== 0).reduce((a, b) => (b.x < a.x ? b : a));
      return noisy({ dx: apex.x - cue.x, dy: apex.y - cue.y + (rnd() - .5) * 1.5, power: .9 + rnd() * .1, ball: 0 }, L, rnd);
    }
    cands = candidatesAny(g, st, override).slice(0, L.look);
    let pick = null, bestVal = -1e9;
    for (const c of cands.slice(0, 6)) {
      const test = { balls: st.balls.map((b) => (override && b.n === override.n ? { n: b.n, x: override.x, y: override.y, out: false } : b)) };
      const r = simulate(test, c), j = judge(g, r.ev);
      const val = (j.foul ? -50 : 0) + (j.blackLoss ? -500 : 0) + (j.blackWin ? 500 : 0) + j.points * 30 + c.score;
      if (val > bestVal) { bestVal = val; pick = c; }
    }
    if (!pick) { // нечего забить: тихонько толкнём ближнюю пару шаров (не чёрным и не в чёрный)
      const live = st.balls.filter((b) => !b.out && b.n !== V.black);
      let pr = null;
      for (const a of live) for (const b of live) { if (a === b) continue; const d = Math.hypot(a.x - b.x, a.y - b.y); if (!pr || d < pr.d) pr = { a, b, d }; }
      if (!pr) { const b8 = st.balls.find((b) => !b.out); const o = st.balls.find((b) => !b.out && b !== b8) || b8; pr = { a: o, b: b8 }; }
      pick = { dx: pr.b.x - pr.a.x, dy: pr.b.y - pr.a.y, power: .3 + rnd() * .15, ball: pr.a.n };
    }
    return noisy(Object.assign({}, pick, { place }), L, rnd);
  }
  // Бот выбирает удар. rnd — функция случайности (на сервере Math.random)
  function botShot(g, level, rnd) {
    rnd = rnd || Math.random;
    const L = BOT[Math.max(0, Math.min(2, level | 0))];
    if (VARIANTS[g.variant].any) return botShotAny(g, L, rnd);
    let st = g.state, place = null;
    const cue0 = st.balls.find((b) => b.n === 0);
    // с руки: пробуем несколько точек в «доме»
    if (g.hand) {
      let best = null;
      for (let k = 0; k < 24; k++) {
        const x = T.R + 1 + rnd() * (T.kitchen - T.R - 2), y = T.R + 1 + rnd() * (T.H - 2 * T.R - 2);
        if (!canPlace(st, x, y)) continue;
        const c = candidates(st, { x, y }, g.variant)[0];
        if (c && (!best || c.score > best.score)) best = Object.assign({ x, y }, c);
      }
      place = best ? { x: best.x, y: best.y } : (canPlace(st, T.headX, T.H / 2) ? { x: T.headX, y: T.H / 2 } : freeSpot({ balls: st.balls.filter((b) => b.n !== 0) }, T.headX * 0.6, T.H / 2));
    }
    const cue = place || cue0;
    // разбой: в пирамиду
    if (g.shots === 0) {
      const apex = st.balls.filter((b) => b.n !== 0).reduce((a, b) => (b.x < a.x ? b : a));
      return noisy({ dx: apex.x - cue.x, dy: apex.y - cue.y + (rnd() - .5) * 1.5, power: .9 + rnd() * .1, place }, L, rnd);
    }
    let cands = candidates(st, cue, g.variant).slice(0, L.look);
    // проверяем лучшие удары пробным расчётом (без разброса): забивается ли и нет ли штрафа
    let pick = null, bestVal = -1e9;
    for (const c of cands.slice(0, 6)) {
      const test = { balls: st.balls.map((b) => (b.n === 0 ? { n: 0, x: cue.x, y: cue.y, out: false } : b)) };
      const r = simulate(test, c);
      const j = judge(g, r.ev);
      const val = (j.foul ? -50 : 0) + j.points * 30 + c.score - (r.ev.pocketed.includes(0) && !VARIANTS[g.variant].cueCounts ? 40 : 0);
      if (val > bestVal) { bestVal = val; pick = c; }
    }
    if (!pick) {
      // нечего забить: тихонько в ближний шар
      const near = st.balls.filter((b) => !b.out && b.n !== 0).reduce((a, b) => (Math.hypot(b.x - cue.x, b.y - cue.y) < Math.hypot(a.x - cue.x, a.y - cue.y) ? b : a));
      pick = { dx: near.x - cue.x, dy: near.y - cue.y, power: .35 + rnd() * .15 };
    }
    return noisy(Object.assign({}, pick, { place }), L, rnd);
  }
  function noisy(s, L, rnd) {
    const g = () => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return (u - 3) / 1.2; }; // почти нормальный разброс
    const a = Math.atan2(s.dy, s.dx) + g() * L.aim * Math.PI / 180;
    return { dx: Math.cos(a), dy: Math.sin(a), power: Math.max(.08, Math.min(1, s.power * (1 + g() * L.pow))), place: s.place || undefined, ball: s.ball === undefined ? undefined : s.ball };
  }

  // ---------- Реплики за бильярдом (с «шо», без обид между своими) ----------
  const LINES = {
    start: ['Ну шо, погнали шары гонять', 'Разбивай, шо ты как неродной', 'Кий в руки и вперёд', 'Ставлю на себя, как обычно'],
    miss: ['Мимо, как всегда', 'Шо это было?', 'Кий кривой, отвечаю', 'Почти. Почти не считается', 'Мазила ты мой родной', 'Шо, руки трясутся?'],
    missMe: ['Сукно неровное', 'Это я так, разминаюсь', 'Специально оставил, шоб вам интереснее было', 'Свет в глаза'],
    nice: ['Красавчик!', 'Вот это шар!', 'Как по маслу', 'Чисто положил', 'Шо, научился?', 'Не, ну это красиво'],
    niceMe: ['Учитесь, пацаны', 'Ловкость рук', 'Видали?', 'Шо, кто-то сомневался?'],
    double: ['Два за раз! Шо ты творишь', 'Дуплет! Вот это я понимаю', 'Два шара одним ударом, красота'],
    svoyak: ['Свояк! Хитрый лис', 'Свояка положил, красавчик', 'Вот это свояк, учитесь'],
    foul: ['Штраф, брат. Бывает', 'Шо ты по воздуху бьёшь?', 'Кий держать надо другим концом', 'Мимо всего стола, талант'],
    off: ['Шар улетел! Ловите!', 'Ты шо, в боулинг играешь?', 'Аккуратнее, люстру собьёшь'],
    win: ['Вот так играют в бильярд', 'Партия! Кто следующий?', 'Шо, ещё одну?'],
    lose: ['Ну ничего, отыграемся', 'Сегодня не мой день', 'Шары кривые, я ж говорил'],
  };
  const pickA = (a, rnd) => a[Math.floor(rnd() * a.length)];
  // какую реплику сказать после удара: who 'me' — сам бьющий, 'other' — кто-то другой
  function pickLine(j, ev, g, seat, rnd) {
    rnd = rnd || Math.random;
    if (g && g.over) return null;
    if (j.off.length) return { who: 'other', text: pickA(LINES.off, rnd) };
    if (j.foul) return rnd() < .6 ? { who: 'other', text: pickA(LINES.foul, rnd) } : null;
    if (j.svoyak) return { who: 'other', text: pickA(LINES.svoyak, rnd) };
    if (j.points >= 2) return { who: 'other', text: pickA(LINES.double, rnd) };
    if (j.points === 1) return rnd() < .35 ? (rnd() < .5 ? { who: 'me', text: pickA(LINES.niceMe, rnd) } : { who: 'other', text: pickA(LINES.nice, rnd) }) : null;
    return rnd() < .25 ? (rnd() < .5 ? { who: 'me', text: pickA(LINES.missMe, rnd) } : { who: 'other', text: pickA(LINES.miss, rnd) }) : null;
  }

  // ---------- Лут бильярдной: падает только тут ----------
  // Редкость как везде: 0 белая, 1 зелёная, 2 синяя, 3 фиолетовая, 4 оранжевая
  const BIL_LOOT = [
    { item: 'mel', rar: 0, p: .40, qty: [1, 2] },     // мел для кия
    { item: 'sukno', rar: 1, p: .20, qty: [1, 2] },   // обрезок сукна
    { item: 'naklejka', rar: 1, p: .12, qty: [1, 1] },// наклейка для кия
    { item: 'zheton', rar: 2, p: .17, qty: [1, 1] },  // жетон бильярдной
    { item: 'perch', rar: 3, p: .085, qty: [1, 1] },  // перчатка каталы
    { item: 'shar', rar: 4, p: .025, qty: [1, 1] },   // счастливый шар
  ];
  // где лежит: ковёр и борта вокруг стола (в % экрана), не под табличками сверху и не под лентой снизу
  const BIL_SPOTS = [
    { n: 'на ковре', x: [3, 24], y: [86, 96] }, { n: 'на ковре', x: [74, 96], y: [86, 96] },
    { n: 'на ковре', x: [1, 4], y: [24, 70] }, { n: 'на ковре', x: [96, 99], y: [24, 70] },
    { n: 'на борту', x: [10, 40], y: [9.5, 12] }, { n: 'на борту', x: [60, 90], y: [9.5, 12] },
    { n: 'на борту', x: [10, 40], y: [79, 81] }, { n: 'на борту', x: [60, 90], y: [79, 81] },
    { n: 'у лузы', x: [3, 7], y: [11, 16] }, { n: 'у лузы', x: [93, 97], y: [76, 81] },
  ];
  function rollBilFind(R) {
    R = R || Math.random;
    let r = R(), L = BIL_LOOT[0];
    for (const x of BIL_LOOT) { if (r < x.p) { L = x; break; } r -= x.p; }
    const sp = BIL_SPOTS[Math.floor(R() * BIL_SPOTS.length)];
    return { rar: L.rar, item: L.item, qty: L.qty[0] + Math.floor(R() * (L.qty[1] - L.qty[0] + 1)), x: +(sp.x[0] + R() * (sp.x[1] - sp.x[0])).toFixed(1), y: +(sp.y[0] + R() * (sp.y[1] - sp.y[0])).toFixed(1), at: sp.n, bil: true };
  }

  const api = { canPlaceAny, BIL_LOOT, BIL_SPOTS, rollBilFind, HALLS, LINES, pickLine, T, PH, JAWS, VARIANTS, TO_WIN, BOT, rack, simulate, newGame, applyShot, judge, canPlace, freeSpot, botShot, teamOf, nextSeat };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KozelBil = api;
})(typeof window !== 'undefined' ? window : globalThis);
