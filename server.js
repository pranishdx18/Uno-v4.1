// UNO Online: zero dependencies. Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path');
const rooms = {}, C = ['R', 'Y', 'G', 'B'], DRAW = { '+2': 2, '+4': 4, 'rev+4': 4, '+6': 6, '+10': 10 };
let cid = 0;
// ms. Clients ping every 5s; no ping for WIN = offline. Offline for AFK = their turn is auto-played; offline for GRACE = removed.
const GRACE = { lobby: 30000, game: 60000 }, AFK = 20000, WIN = 15000;
const online = p => Date.now() - p.seen < WIN;
const rnd = n => Math.floor(Math.random() * n), uid = () => Math.random().toString(36).slice(2, 10);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const top = r => r.disc[r.disc.length - 1];
const live = r => r.players.filter(p => !p.out).length;

// Card counts follow the real decks: Classic 108, No Mercy 168 (edit here to tweak)
function deck(m) {
  const d = [], nm = m == 'nomercy', add = (c, v, n) => { while (n--) d.push({ id: cid++, c, v }); };
  for (const c of C) {
    add(c, '0', 1);
    for (let n = 1; n < 10; n++) add(c, '' + n, 2);
    for (const v of nm ? ['skip', 'rev', '+2', '+4', 'skipall', 'discard'] : ['skip', 'rev', '+2']) add(c, v, nm ? 3 : 2);
  }
  if (nm) { add('W', 'rev+4', 4); add('W', '+6', 4); add('W', '+10', 4); add('W', 'roulette', 8); }
  else { add('W', 'wild', 4); add('W', '+4', 4); }
  return shuffle(d);
}
function take(r, n) {
  const a = [];
  while (n--) {
    if (!r.deck.length) { const t = r.disc.pop(); r.deck = shuffle(r.disc); r.disc = [t]; }
    if (!r.deck.length) break;
    a.push(r.deck.pop());
  }
  return a;
}
// No Mercy: 25+ cards and you're out
function mercy(r, p) {
  if (r.mode == 'nomercy' && p.hand.length >= 25) {
    r.deck.unshift(...p.hand); p.hand = []; p.out = true;
    r.log.push(p.name + ' is out (25+ cards)!');
    const l = r.players.filter(x => !x.out);
    if (l.length == 1) r.winner = l[0].id;
  }
}
const give = (r, p, n) => { p.hand.push(...take(r, n)); mercy(r, p); };
const nxt = (r, i, n = 1) => { while (n--) { do i = (i + r.dir + r.players.length) % r.players.length; while (r.players[i].out); } return i; };
const step = (r, n = 1) => { r.turn = nxt(r, r.turn, n); r.drew = false; };
const ok = (r, c) => {
  const t = top(r);
  if (r.pend) return DRAW[c.v] >= DRAW[t.v]; // stack same or higher
  return c.c == 'W' || c.c == r.color || c.v == t.v;
};
function view(r, p) {
  return {
    code: r.code, mode: r.mode, started: r.started, host: r.host, me: p.id, turn: r.turn, color: r.color, dir: r.dir,
    pend: r.pend, winner: r.winner, top: top(r), deckN: r.deck.length, drew: r.drew, hand: p.hand, log: r.log.slice(-4),
    players: r.players.map(q => ({ id: q.id, name: q.name, n: q.hand.length, out: q.out, on: online(q) }))
  };
}
const send = r => {
  r.players.forEach(p => p.res && p.res.write('data:' + JSON.stringify(view(r, p)) + '\n\n'));
};
function join(r, name) {
  name = (name || '').trim().slice(0, 14);
  if (!name) throw Error('Enter your name first');
  const same = r.players.find(x => x.name.toLowerCase() == name.toLowerCase());
  if (same) { // same name: take the seat back if that player is offline
    if (online(same)) throw Error('That name is taken in this room, pick another');
    return { room: r.code, pid: same.id };
  }
  if (r.players.length >= 10) throw Error('Room is full (10 max)');
  const p = { id: uid(), name, hand: [], out: false, seen: Date.now() };
  if (r.started) { p.hand = take(r, 7); r.log.push(name + ' joined'); } // late joiners get 7 cards
  r.players.push(p); r.host = r.host || p.id; send(r);
  return { room: r.code, pid: p.id };
}
// remove a player (Leave button, or offline too long)
function leave(r, p) {
  const i = r.players.indexOf(p); if (i < 0) return;
  if (p.res) p.res.end(); p.res = null;
  r.deck.unshift(...p.hand); p.hand = []; r.players.splice(i, 1); r.log.push(p.name + ' left');
  if (!r.players.length) { delete rooms[r.code]; return; }
  if (r.host == p.id) r.host = (r.players.find(online) || r.players[0]).id;
  if (r.started && !r.winner) {
    const n = r.players.length;
    if (r.turn > i) r.turn--;
    else if (r.turn == i) { r.turn = r.dir == 1 ? i % n : (i - 1 + n) % n; r.pend = 0; r.drew = false; }
    const l = r.players.filter(x => !x.out);
    if (l.length < 2) r.winner = l.length ? l[0].id : null; // everyone else left
    else while (r.players[r.turn].out) r.turn = (r.turn + r.dir + n) % n;
  }
  send(r);
}
// every 2s: show who is offline, auto-play an offline player's turn, remove players who stayed offline too long
setInterval(() => {
  const now = Date.now();
  for (const r of Object.values(rooms)) {
    let changed = false;
    for (const p of [...r.players]) {
      const o = online(p);
      if (o !== p.was) { p.was = o; changed = true; }
      if (!o && now - p.seen > (r.started ? GRACE.game : GRACE.lobby)) { leave(r, p); changed = false; }
    }
    const c = r.started && !r.winner && r.players[r.turn];
    if (c && now - c.seen > AFK) auto(r, c); else if (changed) send(r);
  }
}, 2000);
// offline player's turn: draw (and pass) so the game never freezes
function auto(r, c) {
  if (r.players[r.turn] !== c || online(c) || r.winner) return;
  try {
    if (!r.drew) act({ t: 'draw', room: r.code, pid: c.id, auto: 1 });
    if (r.players[r.turn] === c && r.drew) act({ t: 'pass', room: r.code, pid: c.id, auto: 1 });
  } catch (e) {}
}
function act(b) {
  if (b.t == 'create') {
    let code; do code = Math.random().toString(36).slice(2, 6).toUpperCase(); while (rooms[code]);
    const r = rooms[code] = { code, mode: b.mode == 'nomercy' ? 'nomercy' : 'classic', players: [], started: false, deck: [], disc: [], turn: 0, dir: 1, pend: 0, log: [] };
    return join(r, b.name);
  }
  const r = rooms[(b.room || '').toUpperCase()];
  if (!r) throw Error('Room not found');
  if (b.t == 'join') return join(r, b.name);
  const p = r.players.find(x => x.id == b.pid);
  if (!p) throw Error('You are not in this room');
  if (!b.auto) p.seen = Date.now();
  if (b.t == 'ping') return { ok: 1 };
  if (b.t == 'bye') { p.seen = Date.now() - WIN; return { ok: 1 }; } // tab closing: show offline right away
  if (b.t == 'leave') { leave(r, p); return { ok: 1 }; }

  if (b.t == 'start') {
    if (r.host != p.id || (r.started && !r.winner)) throw Error('Only the host can start');
    if (r.players.length < 2) throw Error('Need at least 2 players');
    r.deck = shuffle(deck(r.mode)); r.disc = []; r.started = true; r.winner = null; r.dir = 1; r.pend = 0; r.turn = 0; r.drew = false; r.log = [];
    r.players.forEach(x => { x.out = false; x.hand = take(r, 7); });
    r.disc = r.deck.splice(r.deck.findIndex(x => /^\d$/.test(x.v)), 1); r.color = top(r).c;
  } else {
    if (!r.started || r.winner || r.players[r.turn] !== p) throw Error('Not your turn');
    const nm = r.mode == 'nomercy';
    if (b.t == 'play') {
      const c = p.hand.find(x => x.id == b.card);
      if (!c || !ok(r, c)) throw Error("You can't play that card");
      if (c.c == 'W' && !C.includes(b.color)) throw Error('Pick a color');
      p.hand = p.hand.filter(x => x !== c); r.disc.push(c); r.color = c.c == 'W' ? b.color : c.c;
      r.log.push(p.name + ' played ' + (c.c == 'W' ? '' : c.c + ' ') + c.v);
      const v = c.v; let skip = 1;
      if (v == 'discard') { const rm = p.hand.filter(x => x.c == c.c); p.hand = p.hand.filter(x => x.c != c.c); r.disc.splice(r.disc.length - 1, 0, ...rm); }
      if (v == 'rev' || v == 'rev+4') { r.dir *= -1; if (v == 'rev' && live(r) == 2) skip = 2; }
      if (v == 'skip') skip = 2;
      if (v == 'skipall') skip = live(r);
      if (DRAW[v] && v != 'rev+4' || v == 'rev+4') {
        if (nm) r.pend += DRAW[v];
        else { give(r, r.players[nxt(r, r.turn)], DRAW[v]); skip = 2; }
      }
      if (v == 'roulette') { // next player draws until the chosen color shows up
        const q = r.players[nxt(r, r.turn)]; let g;
        do { g = take(r, 1)[0]; if (g) q.hand.push(g); } while (g && g.c != r.color && q.hand.length < 25);
        mercy(r, q); skip = 2;
      }
      if (!p.hand.length && !r.winner) r.winner = p.id;
      if (!r.winner) step(r, skip);
    } else if (b.t == 'draw') {
      if (r.drew) throw Error('You already drew');
      if (r.pend) { give(r, p, r.pend); r.log.push(p.name + ' took +' + r.pend); r.pend = 0; if (!r.winner) step(r); }
      else if (nm) { // No Mercy: draw until you can play
        let g; do { g = take(r, 1)[0]; if (g) p.hand.push(g); } while (g && !ok(r, g) && p.hand.length < 25);
        mercy(r, p); r.drew = !p.out; if (p.out && !r.winner) step(r);
      } else { const g = take(r, 1)[0]; if (g) p.hand.push(g); r.drew = true; if (!g || !ok(r, g)) step(r); }
    } else if (b.t == 'pass') {
      if (!r.drew) throw Error('Draw first');
      step(r);
    }
  }
  send(r);
  return { ok: 1 };
}

http.createServer((q, s) => {
  const u = new URL(q.url, 'http://x');
  if (u.pathname == '/events') {
    const r = rooms[u.searchParams.get('room')], p = r && r.players.find(x => x.id == u.searchParams.get('pid'));
    if (!p) return s.writeHead(404).end();
    s.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    p.seen = Date.now(); p.res = s; s.on('error', () => {});
    s.on('close', () => { if (p.res === s) p.res = null; });
    return send(r);
  }
  if (u.pathname == '/act' && q.method == 'POST') {
    let b = ''; q.on('data', d => b += d).on('end', () => {
      let out; try { out = act(JSON.parse(b)); } catch (e) { out = { err: e.message }; }
      s.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
    });
    return;
  }
  s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(fs.readFileSync(path.join(__dirname, 'index.html')));
}).listen(process.env.PORT || 3000, () => console.log('UNO running on port ' + (process.env.PORT || 3000)));

setInterval(() => Object.values(rooms).forEach(r => r.players.forEach(p => p.res && p.res.write(':\n\n'))), 20000);
