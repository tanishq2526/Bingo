// Multiplayer Room-Based Bingo Server — Zero-dependency Node.js
// Ready for Render, Railway, or local LAN deployment
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// 5 rows, 5 columns, 2 diagonals
const LINES = [];
for (let r = 0; r < 5; r++) LINES.push([0, 1, 2, 3, 4].map(c => r * 5 + c));
for (let c = 0; c < 5; c++) LINES.push([0, 1, 2, 3, 4].map(r => r * 5 + c));
LINES.push([0, 6, 12, 18, 24], [4, 8, 12, 16, 20]);

// Multi-room state store: roomCode -> Room Object
const rooms = new Map();

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const lineCount = (board, called) =>
  LINES.filter(l => l.every(i => called.includes(board[i]))).length;

function getClientIp(req) {
  const xfwd = req.headers['x-forwarded-for'];
  if (xfwd) {
    return xfwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

function getNetworkHash(ip) {
  const clean = String(ip || '').replace(/^::ffff:/, '').trim();
  return crypto.createHash('sha256').update(clean).digest('hex').slice(0, 12);
}

function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  if (rooms.has(code)) return generateRoomCode();
  return code;
}

function view(room, p) {
  return {
    code: room.code,
    name: room.name,
    phase: room.phase,
    you: {
      id: p.id,
      name: p.name,
      board: p.board,
      host: room.hostId === p.id
    },
    players: room.players.map(q => ({
      id: q.id,
      name: q.name,
      connected: q.connected,
      host: room.hostId === q.id,
      lines: room.phase === 'lobby' ? 0 : Math.min(5, lineCount(q.board, room.called))
    })),
    called: room.called,
    last: room.last,
    turn: room.turn,
    winners: room.winners
  };
}

function broadcast(room) {
  room.updatedAt = Date.now();
  room.players.forEach(p => {
    if (p.res) {
      try {
        p.res.write(`data: ${JSON.stringify(view(room, p))}\n\n`);
      } catch (e) {}
    }
  });
}

function nextTurn(room) {
  const connected = room.players.filter(p => p.connected);
  if (!connected.length) {
    room.turn = null;
    return;
  }
  const i = connected.findIndex(p => p.id === room.turn);
  const nextIdx = (i + 1) % connected.length;
  room.turn = connected[nextIdx].id;
}

function scheduleRoomCleanup(room) {
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    const active = room.players.filter(p => p.connected).length;
    if (active === 0) {
      rooms.delete(room.code);
      console.log(`[Room ${room.code}] Cleaned up due to inactivity.`);
    }
  }, 3 * 60 * 1000); // 3 minutes after all leave
}

function removePlayer(room, p) {
  room.players = room.players.filter(x => x !== p);
  // Transfer host if current host leaves
  if (room.hostId === p.id && room.players.length > 0) {
    room.hostId = room.players[0].id;
  }
  broadcast(room);
  if (room.players.length === 0) {
    scheduleRoomCleanup(room);
  }
}

const json = (res, code, obj) => {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(obj));
};

const readBody = req =>
  new Promise(resolve => {
    let d = '';
    req.on('data', c => {
      d += c;
      if (d.length > 2e4) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(d || '{}'));
      } catch {
        resolve({});
      }
    });
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Health check endpoint (for Render keep-alive / health checks)
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) {
    return json(res, 200, { status: 'ok', activeRooms: rooms.size, timestamp: Date.now() });
  }

  // Client IP and Network Hash discovery
  if (req.method === 'GET' && url.pathname === '/api/network') {
    const ip = getClientIp(req);
    return json(res, 200, { networkHash: getNetworkHash(ip) });
  }

  // List active rooms (Wi-Fi match + all active rooms)
  if (req.method === 'GET' && url.pathname === '/api/rooms') {
    const clientIp = getClientIp(req);
    const networkHash = getNetworkHash(clientIp);
    const wifiRooms = [];
    const allRooms = [];

    for (const r of rooms.values()) {
      const activeCount = r.players.filter(p => p.connected).length;
      const host = r.players.find(p => p.id === r.hostId);
      const info = {
        code: r.code,
        name: r.name,
        hostName: host ? host.name : 'Unknown',
        playerCount: r.players.length,
        activeCount,
        maxPlayers: MAX_PLAYERS,
        phase: r.phase,
        sameWifi: r.networkHash === networkHash,
        createdAt: r.createdAt
      };

      if (info.sameWifi) wifiRooms.push(info);
      allRooms.push(info);
    }

    return json(res, 200, { wifiRooms, allRooms, networkHash });
  }

  // SSE Live Game Updates Stream
  if (req.method === 'GET' && url.pathname === '/events') {
    const code = String(url.searchParams.get('code') || '').toUpperCase();
    const playerId = url.searchParams.get('id');
    const room = rooms.get(code);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    if (!room) {
      res.write('data: {"gone":true,"error":"Room not found"}\n\n');
      return res.end();
    }

    const p = room.players.find(x => x.id === playerId);
    if (!p) {
      res.write('data: {"gone":true,"error":"Player not found in this room"}\n\n');
      return res.end();
    }

    clearTimeout(p.timer);
    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
    if (p.res) {
      try {
        p.res.end();
      } catch (e) {}
    }

    p.res = res;
    p.connected = true;

    // Send initial snapshot
    res.write(`data: ${JSON.stringify(view(room, p))}\n\n`);
    broadcast(room);

    // Keep-alive ping
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch (e) {
        clearInterval(ping);
      }
    }, 20000);

    req.on('close', () => {
      clearInterval(ping);
      if (p.res !== res) return;
      p.res = null;
      p.connected = false;

      if (room.phase === 'lobby') {
        p.timer = setTimeout(() => removePlayer(room, p), 8000);
      } else if (room.phase === 'playing' && room.turn === p.id) {
        nextTurn(room);
      }

      const anyConnected = room.players.some(x => x.connected);
      if (!anyConnected) {
        scheduleRoomCleanup(room);
      }
      broadcast(room);
    });

    return;
  }

  // Room Actions
  if (req.method === 'POST' && url.pathname.startsWith('/api/rooms/')) {
    const b = await readBody(req);
    const action = url.pathname.slice(11);

    // Host a new room
    if (action === 'create') {
      const name = String(b.name || '').trim().slice(0, 16);
      if (!name) return json(res, 400, { error: 'Please enter your name.' });
      const roomName = String(b.roomName || '').trim().slice(0, 24) || `${name}'s Room`;
      const clientIp = getClientIp(req);
      const networkHash = getNetworkHash(clientIp);
      const code = generateRoomCode();
      const playerId = crypto.randomBytes(8).toString('hex');

      const p = {
        id: playerId,
        name,
        board: [],
        res: null,
        connected: false,
        timer: null
      };

      const room = {
        code,
        name: roomName,
        networkHash,
        hostId: playerId,
        phase: 'lobby',
        players: [p],
        called: [],
        turn: null,
        winners: [],
        last: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        cleanupTimer: null
      };

      rooms.set(code, room);
      p.timer = setTimeout(() => {
        if (!p.connected) removePlayer(room, p);
      }, 25000);

      console.log(`[Room ${code}] Created by "${name}" (Room: "${roomName}")`);
      return json(res, 200, { code, playerId, roomName });
    }

    // Join an existing room
    if (action === 'join') {
      const code = String(b.code || '').trim().toUpperCase();
      const name = String(b.name || '').trim().slice(0, 16);
      if (!name) return json(res, 400, { error: 'Please enter your name.' });

      const room = rooms.get(code);
      if (!room) return json(res, 404, { error: 'Room not found. Check the room code.' });
      if (room.phase !== 'lobby') return json(res, 409, { error: 'Game is already in progress in this room.' });
      if (room.players.length >= MAX_PLAYERS) return json(res, 409, { error: 'Room is full (max 8 players).' });

      const playerId = crypto.randomBytes(8).toString('hex');
      const p = {
        id: playerId,
        name,
        board: [],
        res: null,
        connected: false,
        timer: null
      };

      room.players.push(p);
      p.timer = setTimeout(() => {
        if (!p.connected) removePlayer(room, p);
      }, 25000);

      broadcast(room);
      console.log(`[Room ${code}] "${name}" joined.`);
      return json(res, 200, { code: room.code, playerId, roomName: room.name });
    }

    // Start game (host only)
    if (action === 'start') {
      const code = String(b.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return json(res, 404, { error: 'Room not found.' });

      const p = room.players.find(x => x.id === b.id);
      if (!p || room.hostId !== p.id) return json(res, 403, { error: 'Only the host can start the game.' });
      if (room.phase !== 'lobby') return json(res, 400, { error: 'Game has already started.' });

      const connected = room.players.filter(x => x.connected);
      if (connected.length < 2) return json(res, 400, { error: 'Need at least 2 connected players to start.' });

      room.players.forEach(x => {
        x.board = shuffle(Array.from({ length: 25 }, (_, i) => i + 1));
      });

      room.phase = 'playing';
      room.called = [];
      room.winners = [];
      room.last = null;
      room.turn = connected[0].id;

      broadcast(room);
      console.log(`[Room ${code}] Game started with ${connected.length} players.`);
      return json(res, 200, { ok: true });
    }

    // Pick a number
    if (action === 'pick') {
      const code = String(b.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return json(res, 404, { error: 'Room not found.' });

      const p = room.players.find(x => x.id === b.id);
      if (!p) return json(res, 404, { error: 'Player not found.' });
      if (room.phase !== 'playing') return json(res, 400, { error: 'Game is not in progress.' });
      if (room.turn !== p.id) return json(res, 400, { error: 'Not your turn.' });

      const n = Number(b.n);
      if (!Number.isInteger(n) || n < 1 || n > 25 || room.called.includes(n)) {
        return json(res, 400, { error: 'Invalid number selection.' });
      }

      room.called.push(n);
      room.last = { n, by: p.name };

      room.winners = room.players.filter(q => lineCount(q.board, room.called) >= 5).map(q => q.id);
      if (room.winners.length > 0) {
        room.phase = 'over';
        room.turn = null;
        console.log(`[Room ${code}] Game Over! Winners: ${room.winners.join(', ')}`);
      } else {
        nextTurn(room);
      }

      broadcast(room);
      return json(res, 200, { ok: true });
    }

    // Play again
    if (action === 'again') {
      const code = String(b.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return json(res, 404, { error: 'Room not found.' });
      if (room.phase !== 'over') return json(res, 400, { error: 'Game is not over yet.' });

      room.players = room.players.filter(x => x.connected);
      room.players.forEach(x => {
        x.board = [];
      });
      room.phase = 'lobby';
      room.called = [];
      room.winners = [];
      room.turn = null;
      room.last = null;

      broadcast(room);
      return json(res, 200, { ok: true });
    }

    // Leave room
    if (action === 'leave') {
      const code = String(b.code || '').toUpperCase();
      const room = rooms.get(code);
      if (room) {
        const p = room.players.find(x => x.id === b.id);
        if (p) {
          if (p.res) {
            try {
              p.res.end();
            } catch (e) {}
          }
          removePlayer(room, p);
        }
      }
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'Unknown action.' });
  }

  // Fallback static page (if accessing server directly)
  const indexPath = path.join(__dirname, 'index.html');
  const indexV3Path = path.join(__dirname, 'index V3.html');
  const targetFile = fs.existsSync(indexPath) ? indexPath : fs.existsSync(indexV3Path) ? indexV3Path : null;

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html') && targetFile) {
    fs.readFile(targetFile, (err, data) => {
      if (err) {
        res.writeHead(500);
        return res.end('Error loading Bingo page');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n===========================================`);
  console.log(`  BINGO MULTIPLAYER ROOM SERVER IS RUNNING `);
  console.log(`  Port: ${PORT}`);
  console.log(`  Local: http://localhost:${PORT}`);
  Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .forEach(i => console.log(`  Wi-Fi: http://${i.address}:${PORT}`));
  console.log(`===========================================\n`);
});
