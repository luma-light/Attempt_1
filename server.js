// server.js
// Centralized server for "Rock-Paper-Scissors Coliseum"
// -----------------------------------------------------
// How to run:
// 1) npm init -y
// 2) npm install express socket.io
// 3) node server.js
// 4) Open http://localhost:3000 in multiple tabs to test

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve index.html from the same directory
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
  turnDeadline: Date.now() + 10000,
  moves: { [socketIdA]: null, [socketIdB]: null },
  status: 'active' | 'finished',
  roomId: `match:${matchId}`,
  rematchVotes: { [socketIdA]: false, [socketIdB]: false }
};
*/

// Ordered list of socketIds ready to play
let waitingQueue = [];

// Global stats for fun display / debugging
let globalStats = {
  totalMatchesPlayed: 0,
  totalRoundsPlayed: 0
};

// Heartbeat / AFK timeout in ms
const HEARTBEAT_TIMEOUT = 15000; // 15 seconds

// Match config
const ROUND_TIME_LIMIT = 10000; // 10 seconds per turn
const WINS_TO_TAKE_MATCH = 3;

// -------------
// Helper utils
// -------------

function safeGetPlayer(id) {
  return players[id] || null;
}

function broadcastLobbyState() {
  // Build spectators + active matches snapshot
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

// Decide the RPS result from perspective of playerA vs playerB
function rpsWinner(moveA, moveB) {
  if (moveA === moveB) return 'tie';
  if (moveA === 'rock' && moveB === 'scissors') return 'A';
  if (moveA === 'paper' && moveB === 'rock') return 'A';
  if (moveA === 'scissors' && moveB === 'paper') return 'A';
  return 'B';
}

// Create a new match from two player IDs
function createMatch(playerIdA, playerIdB) {
  const matchId = `${playerIdA}_${playerIdB}_${Date.now()}`;
  const roomId = `match:${matchId}`;

  const match = {
    id: matchId,
    players: [playerIdA, playerIdB],
    scores: { [playerIdA]: 0, [playerIdB]: 0 },
    round: 1,
    currentTurn: playerIdA, // arbitrary who starts
    turnDeadline: Date.now() + ROUND_TIME_LIMIT,
    moves: { [playerIdA]: null, [playerIdB]: null },
    status: 'active',
    roomId,
    rematchVotes: { [playerIdA]: false, [playerIdB]: false }
  };

  matches[matchId] = match;

  // Move both players to the match room
  match.players.forEach(pid => {
    const p = safeGetPlayer(pid);
    if (!p) return;
    const socket = io.sockets.sockets.get(pid);
    if (!socket) return;

    // Leave lobby room and join match room
    socket.leave('lobby');
    socket.join(roomId);
    p.roomId = roomId;
    p.matchId = matchId;
    p.role = 'player';
  });

  // Emit match_start to the room
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

  // Emit initial turnUpdate
  emitTurnUpdate(match);

  // Lobby changed (two players left)
  broadcastLobbyState();
}

function emitTurnUpdate(match) {
  io.to(match.roomId).emit('turnUpdate', {
    timestamp: Date.now(),
    matchId: match.id,
    holderId: match.currentTurn,
    expiresAt: match.turnDeadline
  });
}

// Called whenever both moves are present, or a timeout/forfeit occurs
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
    else winnerId = null; // tie
  } else if (reason === 'timeout') {
    // Whoever failed to choose loses
    if (moveA && !moveB) winnerId = idA;
    else if (!moveA && moveB) winnerId = idB;
    else winnerId = null; // both failed? treat as tie
  } else if (reason === 'disconnect' || reason === 'forfeit') {
    // One of the players left
    if (!safeGetPlayer(idA)) winnerId = idB;
    else if (!safeGetPlayer(idB)) winnerId = idA;
  }

  // Update scores if there is a winner
  if (winnerId) {
    match.scores[winnerId] = (match.scores[winnerId] || 0) + 1;
  }

  globalStats.totalRoundsPlayed++;

  // Reveal round result to match room
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

  // Win condition?
  const maxScore = Math.max(
    match.scores[idA] || 0,
    match.scores[idB] || 0
  );
  if (maxScore >= WINS_TO_TAKE_MATCH || reason === 'disconnect' || reason === 'forfeit') {
    endMatch(match, winnerId);
  } else {
    // Next round
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

  // Players will stay in the match room until they join lobby or rematch.
  // For now, we’ll keep simple: automatically send them back to lobby.
  match.players.forEach(pid => {
    const socket = io.sockets.sockets.get(pid);
    const player = safeGetPlayer(pid);
    if (socket && player) {
      socket.leave(match.roomId);
      socket.join('lobby');
      player.roomId = 'lobby';
      player.matchId = null;
      player.role = 'spectator';
      // Put them back in lobby queue so they get matched again
      if (!waitingQueue.includes(pid)) {
        waitingQueue.push(pid);
      }
    }
  });

  // Free up the match
  delete matches[match.id];

  broadcastLobbyState();
  tryStartMatches();
}

function tryStartMatches() {
  // While we have at least two people waiting, start a new match
  while (waitingQueue.length >= 2) {
    const playerIdA = waitingQueue.shift();
    const playerIdB = waitingQueue.shift();

    // Basic sanity check
    const pA = safeGetPlayer(playerIdA);
    const pB = safeGetPlayer(playerIdB);
    if (!pA || !pB) continue;

    createMatch(playerIdA, playerIdB);
  }
}

// Remove player from waitingQueue helper
function removeFromWaitingQueue(id) {
  waitingQueue = waitingQueue.filter(pid => pid !== id);
}

// Handle player leaving a match (manual or disconnect)
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

  // Mark their move as null if not set
  match.moves[socketId] = match.moves[socketId] || null;

  // Resolve with forfeit / disconnect
  resolveRound(match, reason || 'disconnect');
}

// ----------------------
// Heartbeat AFK cleaner
// ----------------------

setInterval(() => {
  const now = Date.now();
  for (const [id, p] of Object.entries(players)) {
    if (now - p.timeLastHeartbeat > HEARTBEAT_TIMEOUT) {
      const socket = io.sockets.sockets.get(id);
      if (socket) {
        // This will trigger the normal 'disconnect' handler
        socket.disconnect(true);
      } else {
        // No socket; clean up manually
        removeFromWaitingQueue(id);
        if (p.matchId) {
          handlePlayerLeaveMatch(id, 'disconnect');
        }
        delete players[id];
      }
    }
  }
}, 5000);

// ----------------------
// Socket.io event wiring
// ----------------------

io.on('connection', socket => {
  console.log('Client connected:', socket.id);

  // Initialize a very barebones player record; upgraded on joinLobby
  players[socket.id] = {
    id: socket.id,
    name: 'Anonymous',
    preferredColor: '#ffffff',
    role: 'spectator',
    roomId: 'lobby',
    matchId: null,
    totalWins: 0,
    totalLosses: 0,
    timeLastHeartbeat: Date.now()
  };

  socket.join('lobby');
  broadcastLobbyState();

  // Client wants to enter lobby with a name/color
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

    // Put them into waiting queue
    if (!waitingQueue.includes(socket.id)) {
      waitingQueue.push(socket.id);
    }

    console.log(`Player ${player.id} joined lobby as "${player.name}"`);

    broadcastLobbyState();
    tryStartMatches();
  });

  // Heartbeat to detect AFK / dead sockets
  socket.on('heartbeat', data => {
    const player = safeGetPlayer(socket.id);
    if (!player) return;
    player.timeLastHeartbeat = data && data.timestamp ? data.timestamp : Date.now();
  });

  // Player chooses R/P/S
  socket.on('playerMove', data => {
    const player = safeGetPlayer(socket.id);
    if (!player) return;
    if (!data) return;

    const matchId = data.matchId;
    const move = data.move;

    const match = matches[matchId];
    if (!match || match.status !== 'active') return;

    // Validation
    if (!match.players.includes(socket.id)) return;
    if (match.currentTurn !== socket.id) return;
    if (!['rock', 'paper', 'scissors'].includes(move)) return;

    match.moves[socket.id] = move;

    // If both moves are non-null, resolve the round
    const [idA, idB] = match.players;
    if (match.moves[idA] && match.moves[idB]) {
      resolveRound(match, 'moves');
    }
  });

  // Player wants a rematch (optional: here we just requeue them)
  socket.on('requestRematch', data => {
    const player = safeGetPlayer(socket.id);
    if (!player || !data) return;
    // Simple approach: just requeue this player
    if (!waitingQueue.includes(socket.id)) {
      waitingQueue.push(socket.id);
      broadcastLobbyState();
      tryStartMatches();
    }
  });

  // Player manually leaves a match
  socket.on('leaveMatch', data => {
    const player = safeGetPlayer(socket.id);
    if (!player) return;
    if (!player.matchId) return;
    handlePlayerLeaveMatch(socket.id, 'forfeit');
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    const player = safeGetPlayer(socket.id);
    if (!player) {
      return;
    }

    // Remove from waiting queue
    removeFromWaitingQueue(socket.id);

    // If they were in a match, handle it
    if (player.matchId) {
      handlePlayerLeaveMatch(socket.id, 'disconnect');
    }

    // Finally, delete from players
    delete players[socket.id];

    broadcastLobbyState();
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});