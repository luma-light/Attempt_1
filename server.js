// server.js
// Centralized server for "Rock-Paper-Scissors Coliseum"
// -----------------------------------------------------
// How to run:
// 1) npm install         (express + socket.io v2 already in package.json)
// 2) node server.js
// 3) Open http://localhost:3000 in multiple tabs to test

const express = require('express');
const http = require('http');
const socketIO = require('socket.io'); // v2 style require

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = socketIO(server); // v2 style initialization

// Serve index.html and other static assets from this directory
app.use(express.static(__dirname));

// ----------------------
// Core server data model
// ----------------------

// All connected players keyed by socket.id
let players = {};
/*
players[socketId] = {
  id: socketId,
  name: 'PlayerName',
  preferredColor: '#ff00ff',
  role: 'spectator' | 'player',
  roomId: 'lobby' | `match:${matchId}`,
  matchId: null | matchId,
  spectatingMatchId: null | matchId,
  totalWins: 0,
  totalLosses: 0,
  timeLastHeartbeat: 0
};
*/

// All matches keyed by matchId
let matches = {};
/*
matches[matchId] = {
  id: matchId,
  players: [socketIdA, socketIdB],
  scores: { [socketIdA]: 0, [socketIdB]: 0 },
  round: 1,
  currentTurn: socketIdA,
  turnDeadline: Date.now() + ROUND_TIME_LIMIT,
  moves: { [socketIdA]: null, [socketIdB]: null },
  status: 'active' | 'finished',
  roomId: `match:${matchId}`
};
*/

// Ordered list of socketIds ready to play
let waitingQueue = [];

// Global stats
let globalStats = {
  totalMatchesPlayed: 0,
  totalRoundsPlayed: 0
};

// Heartbeat / AFK timeout in ms
const HEARTBEAT_TIMEOUT = 15000; // 15 seconds

// Match config
const ROUND_TIME_LIMIT = 30000; // 30 seconds per round
const WINS_TO_TAKE_MATCH = 3;

// -------------
// Helper utils
// -------------

function safeGetPlayer(id) {
  return players[id] || null;
}

function broadcastLobbyState() {
  const spectators = Object.values(players)
    .filter(p => p.role === 'spectator')
    .map(p => ({
      id: p.id,
      name: p.name,
      totalWins: p.totalWins,
      totalLosses: p.totalLosses
    }));

  const activeMatches = Object.values(matches)
    .filter(m => m.status === 'active')
    .map(m => ({
      matchId: m.id,
      players: m.players.map(pid => {
        const p = safeGetPlayer(pid);
        return p
          ? { id: p.id, name: p.name }
          : { id: pid, name: 'Unknown' };
      }),
      scores: m.scores
    }));

  io.to('lobby').emit('lobbyState', {
    spectators,
    activeMatches,
    globalStats,
    serverTime: Date.now()
  });
}

function rpsWinner(moveA, moveB) {
  if (moveA === moveB) return 'tie';
  if (moveA === 'rock' && moveB === 'scissors') return 'A';
  if (moveA === 'paper' && moveB === 'rock') return 'A';
  if (moveA === 'scissors' && moveB === 'paper') return 'A';
  return 'B';
}

function getSocketById(id) {
  if (io.sockets && io.sockets.sockets && io.sockets.sockets[id]) {
    return io.sockets.sockets[id];
  }
  if (io.sockets && io.sockets.connected && io.sockets.connected[id]) {
    return io.sockets.connected[id];
  }
  return null;
}

function removeFromWaitingQueue(id) {
  waitingQueue = waitingQueue.filter(pid => pid !== id);
}

function createMatch(playerIdA, playerIdB) {
  const matchId = `${playerIdA}_${playerIdB}_${Date.now()}`;
  const roomId = `match:${matchId}`;

  const match = {
    id: matchId,
    players: [playerIdA, playerIdB],
    scores: { [playerIdA]: 0, [playerIdB]: 0 },
    round: 1,
    currentTurn: playerIdA,
    turnDeadline: Date.now() + ROUND_TIME_LIMIT,
    moves: { [playerIdA]: null, [playerIdB]: null },
    status: 'active',
    roomId
  };

  matches[matchId] = match;

  match.players.forEach(pid => {
    const p = safeGetPlayer(pid);
    if (!p) return;
    const socket = getSocketById(pid);
    if (!socket) return;

    if (p.spectatingMatchId) {
      const oldMatch = matches[p.spectatingMatchId];
      if (oldMatch) socket.leave(oldMatch.roomId);
      p.spectatingMatchId = null;
    }

    socket.leave('lobby');
    socket.join(roomId);
    p.roomId = roomId;
    p.matchId = matchId;
    p.role = 'player';
  });

  io.to(roomId).emit('match_start', {
    timestamp: Date.now(),
    matchId,
    players: match.players.map(pid => {
      const p = safeGetPlayer(pid);
      return p ? { id: p.id, name: p.name } : { id: pid, name: 'Unknown' };
    }),
    scores: match.scores,
    round: match.round,
    startingPlayer: match.currentTurn,
    serverTime: Date.now()
  });

  emitTurnUpdate(match);
  broadcastLobbyState();
}

function emitTurnUpdate(match) {
  io.to(match.roomId).emit('turnUpdate', {
    timestamp: Date.now(),
    matchId: match.id,
    holderId: match.currentTurn,
    expiresAt: match.turnDeadline,
    durationMs: ROUND_TIME_LIMIT,
    round: match.round           // <-- include round for client header
  });
}

function resolveRound(match, reason, leaverId = null) {
  if (!match || match.status !== 'active') return;

  const [idA, idB] = match.players;
  const moveA = match.moves[idA];
  const moveB = match.moves[idB];

  let winnerId = null;
  let roundReason = reason;

  if (reason === 'moves') {
    const result = rpsWinner(moveA, moveB);
    if (result === 'A') winnerId = idA;
    else if (result === 'B') winnerId = idB;
  } else if (reason === 'timeout') {
    if (moveA && !moveB) winnerId = idA;
    else if (!moveA && moveB) winnerId = idB;
  } else if (reason === 'disconnect' || reason === 'forfeit') {
    // Prefer explicit leaverId if provided
    if (leaverId && (leaverId === idA || leaverId === idB)) {
      winnerId = leaverId === idA ? idB : idA;
    } else {
      // Fallback to "missing player" check if needed
      if (!safeGetPlayer(idA)) winnerId = idB;
      else if (!safeGetPlayer(idB)) winnerId = idA;
    }
  }

  if (winnerId) {
    match.scores[winnerId] = (match.scores[winnerId] || 0) + 1;
  }

  globalStats.totalRoundsPlayed++;

  io.to(match.roomId).emit('round_result', {
    timestamp: Date.now(),
    matchId: match.id,
    round: match.round,
    winnerId,
    reason: roundReason,
    scores: match.scores,
    revealedMoves: {
      [idA]: moveA,
      [idB]: moveB
    }
  });

  const maxScore = Math.max(
    match.scores[idA] || 0,
    match.scores[idB] || 0
  );

  if (maxScore >= WINS_TO_TAKE_MATCH || reason === 'disconnect' || reason === 'forfeit') {
    endMatch(match, winnerId);
  } else {
    match.round += 1;
    match.moves[idA] = null;
    match.moves[idB] = null;
    match.currentTurn = idA === match.currentTurn ? idB : idA;
    match.turnDeadline = Date.now() + ROUND_TIME_LIMIT;
    emitTurnUpdate(match);
  }
}

function endMatch(match, winnerId) {
  if (!match || match.status === 'finished') return;
  match.status = 'finished';
  globalStats.totalMatchesPlayed++;

  const [idA, idB] = match.players;
  const pA = safeGetPlayer(idA);
  const pB = safeGetPlayer(idB);

  if (winnerId && pA && pB) {
    if (winnerId === idA) {
      pA.totalWins++;
      pB.totalLosses++;
    } else if (winnerId === idB) {
      pB.totalWins++;
      pA.totalLosses++;
    }
  }

  io.to(match.roomId).emit('game_end', {
    timestamp: Date.now(),
    matchId: match.id,
    winnerId,
    finalScores: match.scores
  });

  match.players.forEach(pid => {
    // IMPORTANT: do not keep players in the queue after a match;
    // they must click the queue button again to rejoin.
    removeFromWaitingQueue(pid);

    const socket = getSocketById(pid);
    const player = safeGetPlayer(pid);
    if (socket && player) {
      socket.leave(match.roomId);
      socket.join('lobby');
      player.roomId = 'lobby';
      player.matchId = null;
      player.role = 'spectator';
    }
  });

  delete matches[match.id];

  broadcastLobbyState();
}

function tryStartMatches() {
  while (waitingQueue.length >= 2) {
    const playerIdA = waitingQueue.shift();
    const playerIdB = waitingQueue.shift();

    const pA = safeGetPlayer(playerIdA);
    const pB = safeGetPlayer(playerIdB);
    if (!pA || !pB) continue;

    createMatch(playerIdA, playerIdB);
  }
}

function handlePlayerLeaveMatch(socketId, reason) {
  const player = safeGetPlayer(socketId);
  if (!player || !player.matchId) return;
  const match = matches[player.matchId];
  if (!match) {
    player.matchId = null;
    player.roomId = 'lobby';
    player.role = 'spectator';
    return;
  }

  match.moves[socketId] = match.moves[socketId] || null;
  resolveRound(match, reason, socketId);
}

// ----------------------
// Heartbeat AFK cleaner
// ----------------------

setInterval(() => {
  const now = Date.now();
  for (const [id, p] of Object.entries(players)) {
    if (now - p.timeLastHeartbeat > HEARTBEAT_TIMEOUT) {
      const socket = getSocketById(id);
      if (socket) {
        socket.disconnect(true);
      } else {
        removeFromWaitingQueue(id);
        if (p.matchId) {
          handlePlayerLeaveMatch(id, 'disconnect');
        }
        p.spectatingMatchId = null;
        delete players[id];
      }
    }
  }
}, 5000);

// ------------------------------
// Round timeout checker
// ------------------------------

setInterval(() => {
  const now = Date.now();
  Object.values(matches).forEach(match => {
    if (!match || match.status !== 'active') return;
    if (now < match.turnDeadline) return;

    const [idA, idB] = match.players;
    const moveA = match.moves[idA];
    const moveB = match.moves[idB];

    if (moveA || moveB) {
      resolveRound(match, 'timeout');
    } else {
      match.turnDeadline = Date.now() + ROUND_TIME_LIMIT;
      emitTurnUpdate(match);
    }
  });
}, 500);

// ----------------------
// Socket.io event wiring
// ----------------------

io.on('connection', socket => {
  console.log('Client connected:', socket.id);

  players[socket.id] = {
    id: socket.id,
    name: 'Anonymous',
    preferredColor: '#ffffff',
    role: 'spectator',
    roomId: 'lobby',
    matchId: null,
    spectatingMatchId: null,
    totalWins: 0,
    totalLosses: 0,
    timeLastHeartbeat: Date.now()
  };

  socket.join('lobby');
  broadcastLobbyState();

  socket.on('joinLobby', data => {
    const now = Date.now();
    const player = safeGetPlayer(socket.id);
    if (!player) return;

    const name = (data && data.name) ? String(data.name).slice(0, 20) : 'Anonymous';
    const preferredColor = (data && data.preferredColor) || '#ff00ff';

    player.name = name;
    player.preferredColor = preferredColor;
    player.role = 'spectator';
    player.roomId = 'lobby';
    player.matchId = null;
    player.timeLastHeartbeat = now;

    // DO NOT auto-queue on joinLobby.
    removeFromWaitingQueue(socket.id);

    console.log(`Player ${player.id} joined lobby as "${player.name}"`);

    broadcastLobbyState();
    // NOTE: we NO LONGER call tryStartMatches here.
    // Matches only start when someone changes queue status or requests a rematch.
  });

  socket.on('setQueueStatus', data => {
    const player = safeGetPlayer(socket.id);
    if (!player) return;
    const inQueue = !!(data && data.inQueue);

    if (inQueue) {
      if (!waitingQueue.includes(socket.id)) {
        waitingQueue.push(socket.id);
      }
    } else {
      removeFromWaitingQueue(socket.id);
    }

    broadcastLobbyState();
    tryStartMatches();
  });

  socket.on('spectateMatch', data => {
    const player = safeGetPlayer(socket.id);
    if (!player || !data) return;
    const matchId = data.matchId;
    const match = matches[matchId];
    if (!match || match.status !== 'active') return;

    if (player.spectatingMatchId && player.spectatingMatchId !== matchId) {
      const oldMatch = matches[player.spectatingMatchId];
      if (oldMatch) {
        socket.leave(oldMatch.roomId);
      }
    }

    socket.join(match.roomId);
    player.spectatingMatchId = matchId;

    socket.emit('match_snapshot', {
      timestamp: Date.now(),
      matchId: match.id,
      players: match.players.map(pid => {
        const p = safeGetPlayer(pid);
        return p ? { id: p.id, name: p.name } : { id: pid, name: 'Unknown' };
      }),
      scores: match.scores,
      round: match.round,
      turnInfo: {
        holderId: match.currentTurn,
        expiresAt: match.turnDeadline,
        durationMs: ROUND_TIME_LIMIT
      }
    });
  });

  socket.on('leaveSpectate', () => {
    const player = safeGetPlayer(socket.id);
    if (!player || !player.spectatingMatchId) return;
    const match = matches[player.spectatingMatchId];
    if (match) {
      socket.leave(match.roomId);
    }
    player.spectatingMatchId = null;
  });

  socket.on('heartbeat', data => {
    const player = safeGetPlayer(socket.id);
    if (!player) return;
    player.timeLastHeartbeat = data && data.timestamp ? data.timestamp : Date.now();
  });

  socket.on('playerMove', data => {
    const player = safeGetPlayer(socket.id);
    if (!player) return;
    if (!data) return;

    const matchId = data.matchId;
    const move = data.move;

    const match = matches[matchId];
    if (!match || match.status !== 'active') return;

    if (!match.players.includes(socket.id)) return;
    if (!['rock', 'paper', 'scissors'].includes(move)) return;
    if (Date.now() > match.turnDeadline) return;

    match.moves[socket.id] = move;
    console.log(`Move from ${socket.id} in match ${matchId}: ${move}`);

    const [idA, idB] = match.players;
    if (match.moves[idA] && match.moves[idB]) {
      resolveRound(match, 'moves');
    }
  });

  socket.on('chatMessage', data => {
    const player = safeGetPlayer(socket.id);
    if (!player || !data) return;

    const matchId = data.matchId;
    let text = data.text;
    if (typeof text !== 'string') return;
    text = text.trim();
    if (!text) return;
    text = text.slice(0, 200);

    const match = matches[matchId];
    if (!match || match.status !== 'active') return;

    if (!match.players.includes(socket.id)) return;

    io.to(match.roomId).emit('chatMessage', {
      timestamp: Date.now(),
      matchId: match.id,
      fromId: socket.id,
      fromName: player.name,
      text
    });
  });

  socket.on('requestRematch', data => {
    // Simple behavior: just re-enter the queue (no special rematch pairing)
    const player = safeGetPlayer(socket.id);
    if (!player || !data) return;
    if (!waitingQueue.includes(socket.id)) {
      waitingQueue.push(socket.id);
      broadcastLobbyState();
      tryStartMatches();
    }
  });

  socket.on('leaveMatch', () => {
    const player = safeGetPlayer(socket.id);
    if (!player) return;
    if (!player.matchId) return;
    handlePlayerLeaveMatch(socket.id, 'forfeit');
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    const player = safeGetPlayer(socket.id);
    if (!player) return;

    removeFromWaitingQueue(socket.id);
    player.spectatingMatchId = null;

    if (player.matchId) {
      handlePlayerLeaveMatch(socket.id, 'disconnect');
    }

    delete players[socket.id];
    broadcastLobbyState();
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});