// server.js
// Rock-Paper-Scissors Coliseum server

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.static(__dirname));

// ----------------------
// Core data model
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
  matchId: null | matchId,          // match they are *playing* in
  spectatingMatchId: null | matchId, // match they are spectating
  bestOf: 3,                         // preferred best-of setting (3/5/7)
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
  roomId: `match:${matchId}`,
  rematchVotes: { [socketIdA]: false, [socketIdB]: false },
  bestOf: 3,
  winsToTakeMatch: 2
};
*/

// Ordered list of socketIds ready to play
let waitingQueue = [];

// Global stats
let globalStats = {
  totalMatchesPlayed: 0,
  totalRoundsPlayed: 0
};

// Config
const HEARTBEAT_TIMEOUT = 15000; // 15s
const ROUND_TIME_LIMIT = 30000;  // 30s per round
const DEFAULT_BEST_OF = 3;
const ALLOWED_BEST_OF = [3, 5, 7];

// -------------
// Helpers
// -------------

function safeGetPlayer(id) {
  return players[id] || null;
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

function rpsWinner(moveA, moveB) {
  if (moveA === moveB) return 'tie';
  if (moveA === 'rock' && moveB === 'scissors') return 'A';
  if (moveA === 'paper' && moveB === 'rock') return 'A';
  if (moveA === 'scissors' && moveB === 'paper') return 'A';
  return 'B';
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
      bestOf: m.bestOf,
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

// ----------------------
// Match lifecycle
// ----------------------

function createMatch(playerIdA, playerIdB) {
  const pA = safeGetPlayer(playerIdA);
  const pB = safeGetPlayer(playerIdB);

  const bestOfRaw = Math.max(
    (pA && pA.bestOf) || DEFAULT_BEST_OF,
    (pB && pB.bestOf) || DEFAULT_BEST_OF
  );
  const bestOf = ALLOWED_BEST_OF.includes(bestOfRaw)
    ? bestOfRaw
    : DEFAULT_BEST_OF;

  const winsNeeded = Math.ceil(bestOf / 2);

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
    roomId,
    rematchVotes: { [playerIdA]: false, [playerIdB]: false },
    bestOf,
    winsToTakeMatch: winsNeeded
  };

  matches[matchId] = match;

  // Move both players to the match room
  match.players.forEach(pid => {
    const p = safeGetPlayer(pid);
    const socket = getSocketById(pid);
    if (!p || !socket) return;

    // If they were spectating some match, leave that room first
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
    bestOf,
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
    durationMs: ROUND_TIME_LIMIT
  });
}

function resolveRound(match, reason) {
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
    if (!safeGetPlayer(idA)) winnerId = idB;
    else if (!safeGetPlayer(idB)) winnerId = idA;
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
  const required = match.winsToTakeMatch || Math.ceil((match.bestOf || DEFAULT_BEST_OF) / 2);

  if (maxScore >= required || reason === 'disconnect' || reason === 'forfeit') {
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
    finalScores: match.scores,
    bestOf: match.bestOf
  });

  match.players.forEach(pid => {
    const socket = getSocketById(pid);
    const player = safeGetPlayer(pid);
    if (socket && player) {
      socket.leave(match.roomId);
      socket.join('lobby');
      player.roomId = 'lobby';
      player.matchId = null;
      player.role = 'spectator';
      if (!waitingQueue.includes(pid)) waitingQueue.push(pid);
    }
  });

  delete matches[match.id];

  broadcastLobbyState();
  tryStartMatches();
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
  resolveRound(match, reason || 'disconnect');
}

// ----------------------
// AFK cleanup & timeouts
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
        if (p.matchId) handlePlayerLeaveMatch(id, 'disconnect');
        p.spectatingMatchId = null;
        delete players[id];
      }
    }
  }
}, 5000);

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
// Socket.io events
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
    bestOf: DEFAULT_BEST_OF,
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
    const joinQueue = !!(data && data.joinQueue);

    player.name = name;
    player.preferredColor = preferredColor;
    player.role = 'spectator';
    player.roomId = 'lobby';
    player.matchId = null;
    player.timeLastHeartbeat = now;

    if (joinQueue) {
      if (!waitingQueue.includes(socket.id)) waitingQueue.push(socket.id);
    } else {
      removeFromWaitingQueue(socket.id);
    }

    console.log(`Player ${player.id} joined lobby as "${player.name}" (inQueue=${joinQueue})`);
    broadcastLobbyState();
    tryStartMatches();
  });

  socket.on('setQueueStatus', data => {
    const player = safeGetPlayer(socket.id);
    if (!player) return;
    const inQueue = !!(data && data.inQueue);
    if (inQueue) {
      if (!waitingQueue.includes(socket.id)) waitingQueue.push(socket.id);
    } else {
      removeFromWaitingQueue(socket.id);
    }
    broadcastLobbyState();
    tryStartMatches();
  });

  // Player sets preferred best-of (3/5/7)
  socket.on('setBestOf', data => {
    const player = safeGetPlayer(socket.id);
    if (!player) return;
    let n = data && data.bestOf;
    n = parseInt(n, 10);
    if (!ALLOWED_BEST_OF.includes(n)) return;
    player.bestOf = n;
  });

  socket.on('spectateMatch', data => {
    const player = safeGetPlayer(socket.id);
    if (!player || !data) return;
    const matchId = data.matchId;
    const match = matches[matchId];
    if (!match || match.status !== 'active') return;

    if (player.spectatingMatchId && player.spectatingMatchId !== matchId) {
      const oldMatch = matches[player.spectatingMatchId];
      if (oldMatch) socket.leave(oldMatch.roomId);
    }

    socket.join(match.roomId);
    player.spectatingMatchId = matchId;

    socket.emit('match_snapshot', {
      timestamp: Date.now(),
      matchId: match.id,
      bestOf: match.bestOf,
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
    if (match) socket.leave(match.roomId);
    player.spectatingMatchId = null;
  });

  socket.on('heartbeat', data => {
    const player = safeGetPlayer(socket.id);
    if (!player) return;
    player.timeLastHeartbeat = data && data.timestamp ? data.timestamp : Date.now();
  });

  socket.on('playerMove', data => {
    const player = safeGetPlayer(socket.id);
    if (!player || !data) return;

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

  // Match chat (only players can send; spectators read)
  socket.on('chatMessage', data => {
    const player = safeGetPlayer(socket.id);
    if (!player || !data) return;

    const matchId = data.matchId;
    let text = data.text;
    if (typeof text !== 'string') return;
    text = text.trim().slice(0, 200);
    if (!text) return;

    const match = matches[matchId];
    if (!match || match.status !== 'active') return;
    if (!match.players.includes(socket.id)) return; // spectators cannot send

    io.to(match.roomId).emit('chatMessage', {
      timestamp: Date.now(),
      matchId: match.id,
      fromId: socket.id,
      fromName: player.name,
      text
    });
  });

  socket.on('requestRematch', () => {
    const player = safeGetPlayer(socket.id);
    if (!player) return;
    if (!waitingQueue.includes(socket.id)) {
      waitingQueue.push(socket.id);
      broadcastLobbyState();
      tryStartMatches();
    }
  });

  socket.on('leaveMatch', () => {
    const player = safeGetPlayer(socket.id);
    if (!player || !player.matchId) return;
    handlePlayerLeaveMatch(socket.id, 'forfeit');
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    const player = safeGetPlayer(socket.id);
    if (!player) return;

    removeFromWaitingQueue(socket.id);

    if (player.spectatingMatchId) {
      const m = matches[player.spectatingMatchId];
      if (m) {
        const s = getSocketById(socket.id);
        if (s) s.leave(m.roomId);
      }
    }

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