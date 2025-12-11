// Author: Matthew Armento
// Course: IMM270 Networked Games
// Professor: Professor Fishburn
//
// File: server.js
//
// This is the centralized, authoritative game server for "RPS Coliseum".
// - Clients (browsers) connect via socket.io.
// - The server owns all real game state: players, matches, scores, timers.
// - Clients mostly send intentions (join queue, play move, chat), and the
//   server responds with snapshots and events.
//
// The design goal: keep clients relatively "dumb" and honest, and have
// the server make all real decisions about who wins, who loses, and when
// rounds or matches end.

const express = require('express');
const http = require('http');
const socketIO = require('socket.io'); // v2 style require

// Node will use the PORT environment variable if we’re deployed somewhere,
// otherwise fall back to running on localhost:3000 for development.
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
// Attach socket.io to the HTTP server, so websockets are served on the same port.
const io = socketIO(server); // v2 style initialization

// Serve index.html and other static assets from this directory
// This means you can just open http://localhost:3000 and get the client.
app.use(express.static(__dirname));

// ----------------------
// Core server data model
// ----------------------

// All connected players keyed by socket.id
// The server never trusts the client for global state; this is the real source of truth.
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
  timeLastHeartbeat: 0,
  wantsMatch: false
};
*/

// All matches keyed by matchId
// Each match holds the set of players, scores, moves, timers, and its own room id.
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
// Think of this as a very simple matchmaking pool.
let waitingQueue = [];

// Global stats
// These are not gameplay-critical, but give the lobby a sense of history.
let globalStats = {
  totalMatchesPlayed: 0,
  totalRoundsPlayed: 0
};

// Heartbeat / AFK timeout in ms
// If a client hasn’t pinged us in this time, we assume they’re gone or AFK.
const HEARTBEAT_TIMEOUT = 15000; // 15 seconds

// Match config
// These constants control pacing (round lengths) and win condition.
const ROUND_TIME_LIMIT = 30000; // 30 seconds per round
const WINS_TO_TAKE_MATCH = 3;

// -------------
// Helper utils
// -------------

// safeGetPlayer:
// - Safely returns a player object if it exists.
// - Returns null instead of undefined so call sites can be explicit.
// - Keeps us from repeatedly writing "players[id] && ..." everywhere.
function safeGetPlayer(id) {
  return players[id] || null;
}

// broadcastLobbyState:
// - Gathers a summary of the current lobby: who’s there and which matches exist.
// - Sends that snapshot to everyone in the 'lobby' room via socket.io.
// - This is how all clients keep their lobby UI in sync with server truth.
function broadcastLobbyState() {
  const spectators = Object.values(players)
    .filter(p => p.roomId === 'lobby') // only those in the lobby
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
        // If the player somehow disappeared, we still show something instead of crashing.
        return p
          ? { id: p.id, name: p.name }
          : { id: pid, name: 'Unknown' };
      }),
      scores: m.scores
    }));

  // serverTime is included so clients could adjust timers if they want.
  io.to('lobby').emit('lobbyState', {
    spectators,
    activeMatches,
    globalStats,
    serverTime: Date.now()
  });
}

// rpsWinner:
// - Pure function that compares two moves and returns:
//   'A' if player A wins, 'B' if player B wins, or 'tie'.
// - Server uses this to decide round results when both players submitted moves.
// - Keeping this isolated makes it easier to test or tweak later.
function rpsWinner(moveA, moveB) {
  if (moveA === moveB) return 'tie';
  if (moveA === 'rock' && moveB === 'scissors') return 'A';
  if (moveA === 'paper' && moveB === 'rock') return 'A';
  if (moveA === 'scissors' && moveB === 'paper') return 'A';
  return 'B';
}

// getSocketById:
// - Socket.io changed its internal APIs across versions.
// - This helper looks in both possible places so the rest of the code
//   can simply call getSocketById(id) and not worry about version differences.
// - If no socket exists for this id, returns null.
function getSocketById(id) {
  if (io.sockets && io.sockets.sockets && io.sockets.sockets[id]) {
    return io.sockets.sockets[id];
  }
  if (io.sockets && io.sockets.connected && io.sockets.connected[id]) {
    return io.sockets.connected[id];
  }
  return null;
}

// removeFromWaitingQueue:
// - Simple helper to yank a player out of the queue by id.
// - Used when a player starts a match, leaves, or disconnects.
// - Helps keep waitingQueue from accumulating stale ids.
function removeFromWaitingQueue(id) {
  waitingQueue = waitingQueue.filter(pid => pid !== id);
}

// createMatch:
// - Given two player ids, builds a match object and registers it in matches.
// - Moves both players out of the lobby and into a dedicated match room.
// - Notifies both players with a 'match_start' event and then a 'turnUpdate'.
// - This function assumes both players are valid and ready; callers must check.
function createMatch(playerIdA, playerIdB) {
  const matchId = `${playerIdA}_${playerIdB}_${Date.now()}`;
  const roomId = `match:${matchId}`;

  // Initialize all state for this match instance.
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

  // Loop through the two participant ids and attach them to this match room.
  match.players.forEach(pid => {
    const p = safeGetPlayer(pid);
    if (!p) return;
    const socket = getSocketById(pid);
    if (!socket) return;

    // If the player was spectating some other match, pull them out of that room first.
    if (p.spectatingMatchId) {
      const oldMatch = matches[p.spectatingMatchId];
      if (oldMatch) socket.leave(oldMatch.roomId);
      p.spectatingMatchId = null;
    }

    // Leave lobby (if they’re still in it) and join this match’s private room.
    socket.leave('lobby');
    socket.join(roomId);

    // Update the server’s player record so we know they’re now playing in this match.
    p.roomId = roomId;
    p.matchId = matchId;
    p.role = 'player';
    p.wantsMatch = false; // once in match, they are no longer in queue
  });

  // Tell everyone in the match room (just the two players for now) that the match started.
  io.to(roomId).emit('match_start', {
    timestamp: Date.now(),
    matchId,
    players: match.players.map(pid => {
      const p = safeGetPlayer(pid);
      // Again, if something is off, we still send a fallback label instead of crashing.
      return p ? { id: p.id, name: p.name } : { id: pid, name: 'Unknown' };
    }),
    scores: match.scores,
    round: match.round,
    startingPlayer: match.currentTurn,
    serverTime: Date.now()
  });

  // Immediately send a turnUpdate so clients can render a timer bar.
  emitTurnUpdate(match);

  // Leaving the lobby changes the lobby composition, so broadcast the new snapshot.
  broadcastLobbyState();
}

// emitTurnUpdate:
// - Sends a 'turnUpdate' event to everyone in a match room.
// - Contains the current holderId, round, and turnDeadline from server time.
// - Clients use this to compute their local countdown and highlight whose turn it is.
function emitTurnUpdate(match) {
  const now = Date.now();
  io.to(match.roomId).emit('turnUpdate', {
    timestamp: now,
    matchId: match.id,
    holderId: match.currentTurn,
    expiresAt: match.turnDeadline,
    durationMs: ROUND_TIME_LIMIT,
    round: match.round
  });
}

// resolveRound:
// - Core logic that finalizes a single round within a match.
// - The 'reason' parameter tells us *why* we’re resolving (both moved, timeout, disconnect, forfeit).
// - It calculates the winner (if any), updates scores, increments global rounds, and notifies clients.
// - Depending on scores and reason, it either ends the match or sets up the next round.
function resolveRound(match, reason, leaverId = null) {
  if (!match || match.status !== 'active') return;

  const [idA, idB] = match.players;
  const moveA = match.moves[idA];
  const moveB = match.moves[idB];

  let winnerId = null;
  let roundReason = reason;

  if (reason === 'moves') {
    // Both players chose something; use pure RPS rules to determine winner.
    const result = rpsWinner(moveA, moveB);
    if (result === 'A') winnerId = idA;
    else if (result === 'B') winnerId = idB;
  } else if (reason === 'timeout') {
    // One player did not move in time; the one who did gets the win.
    if (moveA && !moveB) winnerId = idA;
    else if (!moveA && moveB) winnerId = idB;
  } else if (reason === 'disconnect' || reason === 'forfeit') {
    // When someone leaves mid-match, the other player is awarded the round (and effectively the match).
    // We prefer an explicit leaverId if provided to avoid any ambiguity.
    if (leaverId && (leaverId === idA || leaverId === idB)) {
      winnerId = leaverId === idA ? idB : idA;
    } else {
      // Fallback: see which player still exists in our players map.
      if (!safeGetPlayer(idA)) winnerId = idB;
      else if (!safeGetPlayer(idB)) winnerId = idA;
    }
  }

  // If we found a winner, increment their score in this match.
  if (winnerId) {
    match.scores[winnerId] = (match.scores[winnerId] || 0) + 1;
  }

  // Every resolved round contributes to global stats, whether tie or win.
  globalStats.totalRoundsPlayed++;

  // Broadcast a full 'round_result' to the match room, including revealed moves.
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

  // Check the win condition: if someone has enough score, the match is done.
  const maxScore = Math.max(
    match.scores[idA] || 0,
    match.scores[idB] || 0
  );

  if (maxScore >= WINS_TO_TAKE_MATCH || reason === 'disconnect' || reason === 'forfeit') {
    // Either someone hit the target score, or we had a decisive exit (disconnect/forfeit).
    endMatch(match, winnerId);
  } else {
    // Otherwise, we prepare for the next round:
    // - increase round
    // - reset moves
    // - swap which player starts
    // - set a fresh turnDeadline
    match.round += 1;
    match.moves[idA] = null;
    match.moves[idB] = null;
    match.currentTurn = idA === match.currentTurn ? idB : idA;
    match.turnDeadline = Date.now() + ROUND_TIME_LIMIT;
    emitTurnUpdate(match);
  }
}

// endMatch:
// - Wraps up a match that has reached a conclusion.
// - Updates persistent W/L records for players.
// - Sends 'game_end' to everyone in the match room.
// - Moves players back to the lobby and cleans the match out of memory.
function endMatch(match, winnerId) {
  if (!match || match.status === 'finished') return;
  match.status = 'finished';
  globalStats.totalMatchesPlayed++;

  const [idA, idB] = match.players;
  const pA = safeGetPlayer(idA);
  const pB = safeGetPlayer(idB);

  // If both players still exist and we have a winner, bump their win/loss stats.
  if (winnerId && pA && pB) {
    if (winnerId === idA) {
      pA.totalWins++;
      pB.totalLosses++;
    } else if (winnerId === idB) {
      pB.totalWins++;
      pA.totalLosses++;
    }
  }

  // Send final match results to the match room: who won and what the final scores are.
  io.to(match.roomId).emit('game_end', {
    timestamp: Date.now(),
    matchId: match.id,
    winnerId,
    finalScores: match.scores
  });

  // For each player:
  // - remove them from any waiting queue
  // - move them out of match room into lobby
  // - reset their match fields on the server
  match.players.forEach(pid => {
    removeFromWaitingQueue(pid);
    const socket = getSocketById(pid);
    const player = safeGetPlayer(pid);
    if (socket && player) {
      socket.leave(match.roomId);
      socket.join('lobby');
      player.roomId = 'lobby';
      player.matchId = null;
      player.role = 'spectator';
      player.wantsMatch = false;
    }
  });

  // Also clean up any spectators who were watching this match.
  for (const [pid, player] of Object.entries(players)) {
    if (player.spectatingMatchId === match.id) {
      const socket = getSocketById(pid);
      if (socket) {
        socket.leave(match.roomId);
        socket.join('lobby');
      }
      player.spectatingMatchId = null;
      player.roomId = 'lobby';
    }
  }

  // Remove the match from our master matches table; it no longer exists.
  delete matches[match.id];

  // Lobby composition changed, so tell all lobby clients.
  broadcastLobbyState();
}

// tryStartMatches:
// - Simple matchmaking loop that pairs players in waitingQueue two at a time.
// - Only starts a match if both players still exist, want a match, and are in the lobby.
// - Called whenever queue status changes, or a rematch is requested.
function tryStartMatches() {
  while (waitingQueue.length >= 2) {
    const playerIdA = waitingQueue.shift();
    const playerIdB = waitingQueue.shift();

    const pA = safeGetPlayer(playerIdA);
    const pB = safeGetPlayer(playerIdB);

    // Extra safety: only match if both explicitly want a match and are in lobby
    if (
      !pA || !pB ||
      !pA.wantsMatch || !pB.wantsMatch ||
      pA.roomId !== 'lobby' ||
      pB.roomId !== 'lobby'
    ) {
      // If one of them is no longer valid for a match, skip this pair
      // and continue looking for the next pair in the queue.
      continue;
    }

    createMatch(playerIdA, playerIdB);
  }
}

// handlePlayerLeaveMatch:
// - Shared logic when a player leaves a match intentionally (forfeit)
//   or unintentionally (disconnect/AFK).
// - Finds the match and calls resolveRound with a special reason so the other player wins.
// - If the match doesn’t exist, it just resets the player back to lobby state.
function handlePlayerLeaveMatch(socketId, reason) {
  const player = safeGetPlayer(socketId);
  if (!player || !player.matchId) return;
  const match = matches[player.matchId];
  if (!match) {
    // If the match is already gone, just clean up the player’s state.
    player.matchId = null;
    player.roomId = 'lobby';
    player.role = 'spectator';
    player.wantsMatch = false;
    return;
  }

  // We don’t need to fake a move here; we just say “someone left” and let resolveRound
  // handle the rest based on the reason and leaverId.
  match.moves[socketId] = match.moves[socketId] || null;
  resolveRound(match, reason, socketId);
}

// ----------------------
// Heartbeat AFK cleaner
// ----------------------

// This interval:
// - Periodically checks last heartbeat time for each player.
// - If a player is “too quiet” for HEARTBEAT_TIMEOUT, we treat them as gone.
// - If a socket exists, we force-disconnect it (which triggers our disconnect logic).
// - If not, we clean up the player and their match directly.
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

// This timer:
// - Runs every 500ms and looks at every active match.
// - If the current time is past the match’s turnDeadline, we check moves.
// - If at least one player moved, we resolve as a timeout round.
// - If nobody moved, we simply reset the deadline and keep waiting.
//   (This avoids a soft-lock where both players just never move.)
setInterval(() => {
  const now = Date.now();
  Object.values(matches).forEach(match => {
    if (!match || match.status !== 'active') return;
    if (now < match.turnDeadline) return;

    const [idA, idB] = match.players;
    const moveA = match.moves[idA];
    const moveB = match.moves[idB];

    if (moveA || moveB) {
      // At least one player acted; resolve the round with "timeout" reason.
      resolveRound(match, 'timeout');
    } else {
      // Both players did nothing: extend the deadline and notify them again.
      match.turnDeadline = Date.now() + ROUND_TIME_LIMIT;
      emitTurnUpdate(match);
    }
  });
}, 500);

// ----------------------
// Socket.io event wiring
// ----------------------

// The heart of the server: what happens when a client connects, sends events, and disconnects.
io.on('connection', socket => {
  console.log('Client connected:', socket.id);

  // Newly connected players always start as lobby spectators, *not* queued.
  // We immediately create a server-side player record, even before we know their name.
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
    timeLastHeartbeat: Date.now(),
    wantsMatch: false
  };

  // Make sure they are not in the queue from some weird edge-case, then join the lobby room.
  removeFromWaitingQueue(socket.id);
  socket.join('lobby');
  broadcastLobbyState();

  // joinLobby:
  // - Called when the client’s page first loads and they send us their chosen name/color.
  // - Resets the player’s role to spectator and ensures they’re in the lobby.
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
    player.wantsMatch = false;

    // Absolutely no auto-queue here.
    removeFromWaitingQueue(socket.id);
    socket.join('lobby');

    console.log(`Player ${player.id} joined lobby as "${player.name}"`);

    broadcastLobbyState();
    // Do NOT call tryStartMatches here; only on setQueueStatus / rematch.
  });

  // setQueueStatus:
  // - Client explicitly asks to join or leave the matchmaking queue.
  // - This is the only place where "wantsMatch" is toggled and queue membership is updated.
  socket.on('setQueueStatus', data => {
    const player = safeGetPlayer(socket.id);
    if (!player) return;
    const inQueue = !!(data && data.inQueue);

    if (inQueue) {
      player.wantsMatch = true;
      if (!waitingQueue.includes(socket.id)) {
        waitingQueue.push(socket.id);
      }
    } else {
      player.wantsMatch = false;
      removeFromWaitingQueue(socket.id);
    }

    broadcastLobbyState();
    tryStartMatches();
  });

  // spectateMatch:
  // - Client wants to watch a specific match that’s currently active.
  // - We move them into that match’s room and send them a match_snapshot with relevant info.
  socket.on('spectateMatch', data => {
    const player = safeGetPlayer(socket.id);
    if (!player || !data) return;
    const matchId = data.matchId;
    const match = matches[matchId];
    if (!match || match.status !== 'active') return;

    // If they were spectating another match, leave its room first.
    if (player.spectatingMatchId && player.spectatingMatchId !== matchId) {
      const oldMatch = matches[player.spectatingMatchId];
      if (oldMatch) {
        socket.leave(oldMatch.roomId);
      }
    }

    socket.join(match.roomId);
    player.spectatingMatchId = matchId;
    player.roomId = match.roomId; // for clarity

    const now = Date.now();
    // Send the spectator a snapshot so their client can reconstruct the UI.
    io.to(socket.id).emit('match_snapshot', {
      timestamp: now,
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

  // leaveSpectate:
  // - Spectator is done watching and wants to return to the lobby.
  // - We remove them from the match room and put them back in 'lobby'.
  socket.on('leaveSpectate', () => {
    const player = safeGetPlayer(socket.id);
    if (!player || !player.spectatingMatchId) return;
    const match = matches[player.spectatingMatchId];
    if (match) {
      socket.leave(match.roomId);
    }
    player.spectatingMatchId = null;
    player.roomId = 'lobby';
    socket.join('lobby');
    broadcastLobbyState();
  });

  // heartbeat:
  // - Client sends this periodically to tell us “I’m still here”.
  // - We record the time so we can detect AFK / dead clients later.
  socket.on('heartbeat', data => {
    const player = safeGetPlayer(socket.id);
    if (!player) return;
    player.timeLastHeartbeat = data && data.timestamp ? data.timestamp : Date.now();
  });

  // playerMove:
  // - One of the two match players has chosen rock/paper/scissors.
  // - We validate that:
  //   * the player exists
  //   * the match exists and is active
  //   * the sender is actually in that match
  //   * the move is valid and not past the deadline
  // - When both players have moved, we resolve the round immediately.
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

  // CHAT: players AND spectators in the match room may chat.
  // - The client passes matchId and text.
  // - We trust that matchId enough to look it up, then send message to that room.
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

    // Option A: allow anyone in the match room to chat
    // (we rely on the client using a valid matchId; no need to over-restrict)
    io.to(match.roomId).emit('chatMessage', {
      timestamp: Date.now(),
      matchId: match.id,
      fromId: socket.id,
      fromName: player.name,
      text
    });
  });

  // requestRematch:
  // - A player wants to hop back into the matchmaking queue after a match.
  // - We mark them as wanting a match again and push them to waitingQueue.
  socket.on('requestRematch', data => {
    const player = safeGetPlayer(socket.id);
    if (!player || !data) return;
    if (!waitingQueue.includes(socket.id)) {
      player.wantsMatch = true;
      waitingQueue.push(socket.id);
      broadcastLobbyState();
      tryStartMatches();
    }
  });

  // leaveMatch:
  // - Player explicitly clicks a “leave/forfeit” button on the client.
  // - We treat this as a forfeit in the context of that match.
  socket.on('leaveMatch', () => {
    const player = safeGetPlayer(socket.id);
    if (!player) return;
    if (!player.matchId) return;
    handlePlayerLeaveMatch(socket.id, 'forfeit');
  });

  // disconnect:
  // - Called whenever socket.io notices the connection has dropped.
  // - We remove player from queues, handle any match they are in, and
  //   broadcast a new lobby state so other players see the change.
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

// Start the HTTP + WebSocket server listening on the chosen PORT.
// Once this log appears, you can open the URL in a browser and play.
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});