// LAN Bingo server — no npm install needed, just: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;

// 5 rows, 5 columns, 2 diagonals
const LINES = [];
for (let r = 0; r < 5; r++) LINES.push([0, 1, 2, 3, 4].map(c => r * 5 + c));
for (let c = 0; c < 5; c++) LINES.push([0, 1, 2, 3, 4].map(r => r * 5 + c));
LINES.push([0, 6, 12, 18, 24], [4, 8, 12, 16, 20]);

let players = [];          // {id, name, board, res, connected, timer}
let phase = 'lobby';       // lobby | playing | over
let called = [];
let turn = null;           // player id whose turn it is
let winners = [];          // player ids
let last = null;           // {n, by}
let emptyTimer = null;

const shuffle = a => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const lineCount = board => LINES.filter(l => l.every(i => called.includes(board[i]))).length;
const connected = () => players.filter(p => p.connected);

function view(p) {
  return {
    phase,
    you: { id: p.id, name: p.name, board: p.board, host: players[0] === p },
    players: players.map(q => ({
      id: q.id, name: q.name, connected: q.connected,
      lines: phase === 'lobby' ? 0 : Math.min(5, lineCount(q.board))
    })),
    called, last, turn, winners
  };
}

function broadcast() {
  players.forEach(p => { if (p.res) p.res.write(`data: ${JSON.stringify(view(p))}\n\n`); });
}

function nextTurn() {
  const i = players.findIndex(p => p.id === turn);
  for (let k = 1; k <= players.length; k++) {
    const q = players[(i + k) % players.length];
    if (q.connected) { turn = q.id; return; }
  }
  turn = null;
}

function resetAll() {
  players = []; phase = 'lobby'; called = []; turn = null; winners = []; last = null;
}

function removePlayer(p) {
  players = players.filter(x => x !== p);
  broadcast();
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};
const readBody = req => new Promise(resolve => {
  let d = '';
  req.on('data', c => { d += c; if (d.length > 1e4) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  // Allow the page to be opened straight from disk (file://) and still talk to this server
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // Live updates stream
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const p = players.find(x => x.id === url.searchParams.get('id'));
    if (!p) { res.write('data: {"gone":true}\n\n'); return res.end(); }
    clearTimeout(p.timer);
    clearTimeout(emptyTimer);
    if (p.res) { try { p.res.end(); } catch {} }
    p.res = res; p.connected = true;
    res.write(`data: ${JSON.stringify(view(p))}\n\n`);
    broadcast();
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      if (p.res !== res) return;
      p.res = null; p.connected = false;
      if (phase === 'lobby') {
        p.timer = setTimeout(() => removePlayer(p), 5000);
      } else if (phase === 'playing' && turn === p.id) {
        nextTurn();
      }
      if (!connected().length) {
        clearTimeout(emptyTimer);
        emptyTimer = setTimeout(() => { if (!connected().length) resetAll(); }, 60000);
      }
      broadcast();
    });
    return;
  }

  // Game actions
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const b = await readBody(req);
    const action = url.pathname.slice(5);

    if (action === 'join') {
      if (phase !== 'lobby') return json(res, 409, { error: 'A game is in progress. Wait for it to finish.' });
      if (players.length >= MAX_PLAYERS) return json(res, 409, { error: 'The room is full.' });
      const name = String(b.name || '').trim().slice(0, 16);
      if (!name) return json(res, 400, { error: 'Enter a name to join.' });
      const p = { id: crypto.randomBytes(8).toString('hex'), name, board: [], res: null, connected: false, timer: null };
      p.timer = setTimeout(() => { if (!p.connected) removePlayer(p); }, 10000);
      players.push(p);
      return json(res, 200, { id: p.id });
    }

    const p = players.find(x => x.id === b.id);
    if (!p) return json(res, 404, { error: 'Unknown player.' });

    if (action === 'start') {
      if (phase !== 'lobby' || players[0] !== p) return json(res, 403, { error: 'Only the host can start.' });
      players = players.filter(x => x.connected);
      if (players.length < 2) return json(res, 400, { error: 'Need at least 2 players.' });
      players.forEach(x => { x.board = shuffle(Array.from({ length: 25 }, (_, i) => i + 1)); });
      phase = 'playing'; called = []; winners = []; last = null; turn = players[0].id;
      broadcast();
      return json(res, 200, {});
    }

    if (action === 'pick') {
      const n = Number(b.n);
      if (phase !== 'playing' || turn !== p.id) return json(res, 400, { error: 'Not your turn.' });
      if (!Number.isInteger(n) || n < 1 || n > 25 || called.includes(n)) return json(res, 400, { error: 'Invalid number.' });
      called.push(n);
      last = { n, by: p.name };
      winners = players.filter(q => lineCount(q.board) >= 5).map(q => q.id);
      if (winners.length) { phase = 'over'; turn = null; } else { nextTurn(); }
      broadcast();
      return json(res, 200, {});
    }

    if (action === 'again') {
      if (phase !== 'over') return json(res, 400, { error: 'Game is not over.' });
      players = players.filter(x => x.connected);
      players.forEach(x => { x.board = []; });
      phase = 'lobby'; called = []; winners = []; turn = null; last = null;
      broadcast();
      return json(res, 200, {});
    }

    return json(res, 404, { error: 'Unknown action.' });
  }

  // Page
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); return res.end('index.html not found next to server.js'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\nBingo server is running.\n');
  console.log('  On this computer:  http://localhost:' + PORT);
  Object.values(os.networkInterfaces()).flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .forEach(i => console.log('  Friends on your Wi-Fi:  http://' + i.address + ':' + PORT));
  console.log('\nOpen the Wi-Fi address on every device (including yours) so everyone joins the same room.\n');
});
