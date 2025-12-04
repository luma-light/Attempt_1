# Adding Socket.IO Rooms to Matter.js Physics Demo

**Time Required:** 60-90 minutes
**Prerequisites:** Experience with Socket.IO echo server, basic server.js knowledge
**Learning Goals:**
- Understand Socket.IO rooms for isolated multiplayer sessions
- Learn data structures for tracking multi-room game state
- Practice server-authoritative architecture patterns

## Overview

We're going to transform this single-world physics demo into a multi-room system where:
- Players join named rooms (like "room1", "room2", etc.)
- Each room has a maximum of 3 players
- Each room has its own **independent physics world**
- Players in different rooms never see each other's objects

## Key Architecture Patterns

1. **Room-Based State Isolation**: Each room has its own physics engine and object list
2. **Player Tracking**: Server maintains a list of who is in which room
3. **Targeted Broadcasting**: Socket.IO rooms ensure updates only go to relevant players

## Before We Start

Make sure you have the original code working:
```bash
npm install
npm start
```
Open http://localhost:3000 and verify you can spawn circles/boxes. Then commit your working code:
```bash
git add .
git commit -m "Starting point before adding rooms"
```

---

## Step 1: Add Player Tracking Data Structure (10 min)

**Goal:** Track which players are connected and which room they're in.

### What We're Adding

A simple array to store player information:
```javascript
const users = [
  { id: "socket123", username: "Alice", room: "room1" },
  { id: "socket456", username: "Bob", room: "room1" }
]
```

### Code Changes

Open `server.js`. After line 15 (`const io = socketIO(server);`), add this new section:

```javascript
// ====== ROOM MANAGEMENT (3 Players Max) ======

const MAX_PLAYERS_PER_ROOM = 3;
const users = [];

// Helper function: Join user to room
function userJoin(id, username, room) {
    const user = { id, username, room };
    users.push(user);
    return user;
}

// Helper function: Get the current user
function getCurrentUser(id) {
    return users.find(user => user.id === id);
}

// Helper function: User leaves room
function userLeave(id) {
    const index = users.findIndex(user => user.id === id);
    if (index !== -1) {
        return users.splice(index, 1)[0];
    }
}

// Helper function: Get all users in a room
function getRoomUsers(room) {
    return users.filter(user => user.room === room);
}
```

### Testing Step 1

Add temporary test code in the `io.on('connection')` handler. Find this line (around line 155):
```javascript
io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);
```

Add this test code right after:
```javascript
    // TEST: Simulate joining a room
    const testUser = userJoin(socket.id, "TestPlayer", "testroom");
    console.log("Added user:", testUser);
    console.log("All users:", users);
    console.log("Users in testroom:", getRoomUsers("testroom"));
```

**Expected Output:**
```
Client connected: abc123xyz
Added user: { id: 'abc123xyz', username: 'TestPlayer', room: 'testroom' }
All users: [ { id: 'abc123xyz', username: 'TestPlayer', room: 'testroom' } ]
Users in testroom: [ { id: 'abc123xyz', username: 'TestPlayer', room: 'testroom' } ]
```

**Remove the test code** before continuing to Step 2.

**Commit:** `git commit -am "Step 1: Add player tracking data structure"`

---

## Step 2: Add Room-Based Physics Worlds Data Structure (10 min)

**Goal:** Instead of one global physics world, create a separate world for each room.

### What We're Adding

A nested object structure:
```javascript
const rooms = {
  "room1": {
    engine: <Matter.js Engine>,
    world: <Matter.js World>,
    bodies: [...],
    nextBodyId: 5
  },
  "room2": {
    engine: <Matter.js Engine>,
    world: <Matter.js World>,
    bodies: [...],
    nextBodyId: 2
  }
}
```

### Code Changes

**Find and DELETE** these lines in server.js (around lines 47-72):
```javascript
// Create physics engine
const engine = Engine.create();
const world = engine.world;

// World settings
const WORLD_WIDTH = 800;
const WORLD_HEIGHT = 600;

// Disable gravity initially (we'll add it later)
engine.world.gravity.y = 1;

// Create static walls
const wallThickness = 50;
const walls = [
    Bodies.rectangle(WORLD_WIDTH / 2, -wallThickness / 2, WORLD_WIDTH, wallThickness, { isStatic: true }),
    Bodies.rectangle(WORLD_WIDTH / 2, WORLD_HEIGHT + wallThickness / 2, WORLD_WIDTH, wallThickness, { isStatic: true }),
    Bodies.rectangle(-wallThickness / 2, WORLD_HEIGHT / 2, wallThickness, WORLD_HEIGHT, { isStatic: true }),
    Bodies.rectangle(WORLD_WIDTH + wallThickness / 2, WORLD_HEIGHT / 2, wallThickness, WORLD_HEIGHT, { isStatic: true })
];

World.add(world, walls);

// Track dynamic bodies (circles and boxes)
let bodies = [];
let nextBodyId = 0;
```

**Replace with:**
```javascript
// World settings (shared constants)
const WORLD_WIDTH = 800;
const WORLD_HEIGHT = 600;

// Store physics worlds per room
const rooms = {}; // { roomName: { engine, world, bodies, nextBodyId } }

// Helper function: Create a new physics world for a room
function createRoomPhysics(roomName) {
    // Create physics engine
    const engine = Engine.create();
    const world = engine.world;

    // Set gravity
    engine.world.gravity.y = 1;

    // Create static walls
    const wallThickness = 50;
    const walls = [
        Bodies.rectangle(WORLD_WIDTH / 2, -wallThickness / 2, WORLD_WIDTH, wallThickness, { isStatic: true }),
        Bodies.rectangle(WORLD_WIDTH / 2, WORLD_HEIGHT + wallThickness / 2, WORLD_WIDTH, wallThickness, { isStatic: true }),
        Bodies.rectangle(-wallThickness / 2, WORLD_HEIGHT / 2, wallThickness, WORLD_HEIGHT, { isStatic: true }),
        Bodies.rectangle(WORLD_WIDTH + wallThickness / 2, WORLD_HEIGHT / 2, wallThickness, WORLD_HEIGHT, { isStatic: true })
    ];

    World.add(world, walls);

    // Create room object
    rooms[roomName] = {
        engine: engine,
        world: world,
        bodies: [],
        nextBodyId: 0
    };

    console.log(`Physics world created for room: ${roomName}`);
    return rooms[roomName];
}

// Helper function: Get room physics (creates if doesn't exist)
function getRoomPhysics(roomName) {
    if (!rooms[roomName]) {
        return createRoomPhysics(roomName);
    }
    return rooms[roomName];
}

// Helper function: Delete room physics when empty
function deleteRoomPhysics(roomName) {
    if (rooms[roomName]) {
        delete rooms[roomName];
        console.log(`Physics world deleted for room: ${roomName}`);
    }
}
```

### Testing Step 2

Add this test code right after the `deleteRoomPhysics` function:

```javascript
// TEST: Create some rooms
console.log("\n=== TESTING ROOM CREATION ===");
const room1 = getRoomPhysics("testroom1");
console.log("Created room1, has engine?", room1.engine !== undefined);
console.log("Created room1, has bodies array?", Array.isArray(room1.bodies));

const room2 = getRoomPhysics("testroom2");
console.log("Created room2");

console.log("All rooms:", Object.keys(rooms));
console.log("Room1 nextBodyId:", rooms.testroom1.nextBodyId);

deleteRoomPhysics("testroom1");
console.log("After deleting testroom1:", Object.keys(rooms));
console.log("=== TEST COMPLETE ===\n");
```

**Expected Output:**
```
=== TESTING ROOM CREATION ===
Physics world created for room: testroom1
Created room1, has engine? true
Created room1, has bodies array? true
Physics world created for room: testroom2
Created room2
All rooms: [ 'testroom1', 'testroom2' ]
Room1 nextBodyId: 0
Physics world deleted for room: testroom1
After deleting testroom1: [ 'testroom2' ]
=== TEST COMPLETE ===
```

**Remove the test code** and **delete the testroom2** before continuing:
```javascript
delete rooms.testroom2; // Add this temporarily, then remove
```

**Commit:** `git commit -am "Step 2: Add room-based physics world data structure"`

---

## Step 3: Make Helper Functions Room-Aware (15 min)

**Goal:** Update `createCircle()`, `createBox()`, `clearAllBodies()`, and `getPhysicsState()` to work with specific rooms.

### Code Changes

Find the `createCircle` function and **replace it entirely**:

**Old (find and delete):**
```javascript
function createCircle(x, y) {
    const radius = 15 + Math.random() * 25;
    const circle = Bodies.circle(x, y, radius, {
        restitution: 0.8,
        friction: 0.01,
        density: 0.001,
        render: {
            fillStyle: `rgb(${Math.floor(Math.random() * 256)}, ${Math.floor(Math.random() * 256)}, ${Math.floor(Math.random() * 256)})`
        }
    });

    const bodyData = {
        id: nextBodyId++,
        matterId: circle.id,
        type: 'circle',
        radius: radius,
        color: circle.render.fillStyle
    };

    World.add(world, circle);
    bodies.push({ matter: circle, data: bodyData });

    return bodyData;
}
```

**New:**
```javascript
function createCircle(roomName, x, y) {
    const room = getRoomPhysics(roomName);

    const radius = 15 + Math.random() * 25;
    const circle = Bodies.circle(x, y, radius, {
        restitution: 0.8,
        friction: 0.01,
        density: 0.001,
        render: {
            fillStyle: `rgb(${Math.floor(Math.random() * 256)}, ${Math.floor(Math.random() * 256)}, ${Math.floor(Math.random() * 256)})`
        }
    });

    const bodyData = {
        id: room.nextBodyId++,
        matterId: circle.id,
        type: 'circle',
        radius: radius,
        color: circle.render.fillStyle
    };

    World.add(room.world, circle);
    room.bodies.push({ matter: circle, data: bodyData });

    return bodyData;
}
```

**Key changes:**
- Added `roomName` parameter
- Use `getRoomPhysics(roomName)` to get the right room
- Use `room.nextBodyId++` instead of global `nextBodyId`
- Use `room.world` and `room.bodies` instead of globals

Do the same for `createBox` - add `roomName` parameter and update all references.

**Update clearAllBodies:**
```javascript
function clearAllBodies(roomName) {
    const room = rooms[roomName];
    if (room) {
        room.bodies.forEach(b => World.remove(room.world, b.matter));
        room.bodies = [];
    }
}
```

**Update getPhysicsState:**
```javascript
function getPhysicsState(roomName) {
    const room = rooms[roomName];
    if (!room) return [];

    return room.bodies.map(b => {
        const matter = b.matter;
        return {
            id: b.data.id,
            type: b.data.type,
            x: matter.position.x,
            y: matter.position.y,
            angle: matter.angle,
            vx: matter.velocity.x,
            vy: matter.velocity.y,
            angularVelocity: matter.angularVelocity,
            radius: b.data.radius,
            width: b.data.width,
            height: b.data.height,
            color: b.data.color
        };
    });
}
```

### Testing Step 3

Add this test after the helper functions:

```javascript
// TEST: Create objects in different rooms
console.log("\n=== TESTING ROOM-SPECIFIC OBJECTS ===");
getRoomPhysics("alpha");
getRoomPhysics("beta");

createCircle("alpha", 100, 100);
createCircle("alpha", 200, 200);
createBox("beta", 300, 300);

console.log("Alpha room bodies:", rooms.alpha.bodies.length); // Should be 2
console.log("Beta room bodies:", rooms.beta.bodies.length);   // Should be 1
console.log("Alpha nextBodyId:", rooms.alpha.nextBodyId);     // Should be 2
console.log("Beta nextBodyId:", rooms.beta.nextBodyId);       // Should be 1

clearAllBodies("alpha");
console.log("After clearing alpha:", rooms.alpha.bodies.length); // Should be 0
console.log("Beta still has:", rooms.beta.bodies.length);        // Should still be 1
console.log("=== TEST COMPLETE ===\n");

// Clean up
delete rooms.alpha;
delete rooms.beta;
```

**Expected Output:**
```
=== TESTING ROOM-SPECIFIC OBJECTS ===
Physics world created for room: alpha
Physics world created for room: beta
Alpha room bodies: 2
Beta room bodies: 1
Alpha nextBodyId: 2
Beta nextBodyId: 1
After clearing alpha: 0
Beta still has: 1
=== TEST COMPLETE ===
```

**Remove test code and cleanup.**

**Commit:** `git commit -am "Step 3: Make helper functions room-aware"`

---

## Step 4: Update Game Loops for Multiple Rooms (10 min)

**Goal:** Make physics and network loops process all active rooms.

### Code Changes

Find the game loop section (around line 136). **Replace:**

**Old:**
```javascript
// Physics update loop
setInterval(() => {
    Engine.update(engine, 1000 / TICK_RATE);
}, 1000 / TICK_RATE);

// Network update loop
setInterval(() => {
    if (bodies.length > 0) {
        io.emit('physicsUpdate', getPhysicsState());
    }
}, 1000 / UPDATE_RATE);
```

**New:**
```javascript
// Physics update loop - updates all active room physics
setInterval(() => {
    Object.keys(rooms).forEach(roomName => {
        const room = rooms[roomName];
        Engine.update(room.engine, 1000 / TICK_RATE);
    });
}, 1000 / TICK_RATE);

// Network update loop - sends updates to each room
setInterval(() => {
    Object.keys(rooms).forEach(roomName => {
        const room = rooms[roomName];
        if (room.bodies.length > 0) {
            io.to(roomName).emit('physicsUpdate', getPhysicsState(roomName));
        }
    });
}, 1000 / UPDATE_RATE);
```

**Key changes:**
- Use `Object.keys(rooms).forEach()` to iterate all rooms
- Use `io.to(roomName).emit()` instead of `io.emit()` - this is **crucial**!

### Understanding io.to()

```javascript
io.emit('event', data);              // Sends to EVERYONE
io.to('room1').emit('event', data);  // Sends ONLY to players in room1
socket.emit('event', data);          // Sends ONLY to one specific player
```

### Testing Step 4

This won't work fully yet because we haven't updated Socket.IO handlers, but add this temporary test to see the loops working:

```javascript
// TEST: Create rooms and watch game loops
console.log("\n=== TESTING GAME LOOPS ===");
getRoomPhysics("looptest1");
getRoomPhysics("looptest2");
createCircle("looptest1", 400, 100); // Drop from top

setTimeout(() => {
    console.log("After 2 seconds of physics:");
    console.log("looptest1 circle position:", rooms.looptest1.bodies[0].matter.position.y);
    console.log("Should be > 100 due to gravity");

    // Cleanup
    delete rooms.looptest1;
    delete rooms.looptest2;
    console.log("=== TEST COMPLETE ===\n");
}, 2000);
```

**Expected Output:**
```
=== TESTING GAME LOOPS ===
Physics world created for room: looptest1
Physics world created for room: looptest2
(after 2 seconds...)
After 2 seconds of physics:
looptest1 circle position: 234.5 (or some number > 100)
Should be > 100 due to gravity
=== TEST COMPLETE ===
```

**Remove test code.**

**Commit:** `git commit -am "Step 4: Update game loops for multiple rooms"`

---

## Step 5: Add Socket.IO Room Joining Logic (15 min)

**Goal:** Let players join Socket.IO rooms and update event handlers.

### Understanding Socket.IO Rooms

When you call `socket.join('room1')`, Socket.IO:
1. Adds that socket to a group called "room1"
2. Lets you broadcast to only that group with `io.to('room1').emit()`
3. Player can be in multiple rooms (we'll use just one)

### Code Changes

Find the `io.on('connection')` handler and **add this at the top** (after the console.log):

```javascript
io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    // Handle room join request
    socket.on('joinRoom', ({ username, room }) => {
        console.log(`User ${username} attempting to join room: ${room}`);

        // Check if room is full
        if (getRoomUsers(room).length >= MAX_PLAYERS_PER_ROOM) {
            socket.emit('roomFull', {
                message: `Room "${room}" is full! Maximum ${MAX_PLAYERS_PER_ROOM} players allowed.`
            });
            console.log(`Room ${room} is full. User ${username} rejected.`);
            return;
        }

        // Join the user to the room
        const user = userJoin(socket.id, username, room);
        socket.join(user.room);

        // Create or get physics world for this room
        getRoomPhysics(user.room);

        // Send initial world state to the joining player
        socket.emit('worldState', {
            width: WORLD_WIDTH,
            height: WORLD_HEIGHT,
            bodies: getPhysicsState(user.room)
        });

        // Notify room about player count
        const roomUsers = getRoomUsers(user.room);
        io.to(user.room).emit('roomInfo', {
            room: user.room,
            playerCount: roomUsers.length,
            maxPlayers: MAX_PLAYERS_PER_ROOM,
            players: roomUsers.map(u => u.username)
        });

        console.log(`${username} joined room ${room}. Players: ${roomUsers.length}/${MAX_PLAYERS_PER_ROOM}`);
    });
```

Now **update the existing event handlers**. Find `spawnCircle` and change:

**Old:**
```javascript
socket.on('spawnCircle', (data) => {
    const bodyData = createCircle(data.x, data.y);
    io.emit('bodySpawned', bodyData);
    console.log(`Circle ${bodyData.id} spawned at (${data.x}, ${data.y})`);
});
```

**New:**
```javascript
socket.on('spawnCircle', (data) => {
    const user = getCurrentUser(socket.id);
    if (!user) return;

    const bodyData = createCircle(user.room, data.x, data.y);
    io.to(user.room).emit('bodySpawned', bodyData);
    console.log(`Circle ${bodyData.id} spawned in room ${user.room} at (${data.x}, ${data.y})`);
});
```

Do the same for:
- `spawnBox` - add user lookup and room parameter
- `explode` - get user's room and iterate `rooms[user.room].bodies`
- `clearBodies` - pass user's room to `clearAllBodies()`

**Update disconnect handler:**

**Old:**
```javascript
socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
});
```

**New:**
```javascript
socket.on('disconnect', () => {
    const user = userLeave(socket.id);

    if (user) {
        console.log(`Client disconnected: ${user.username} from room ${user.room}`);

        // Update room info
        const roomUsers = getRoomUsers(user.room);
        io.to(user.room).emit('roomInfo', {
            room: user.room,
            playerCount: roomUsers.length,
            maxPlayers: MAX_PLAYERS_PER_ROOM,
            players: roomUsers.map(u => u.username)
        });

        // If room is empty, delete the physics world
        if (roomUsers.length === 0) {
            deleteRoomPhysics(user.room);
        }
    }
});
```

### Testing Step 5

Start the server and open the browser console. Type this in the console:

```javascript
socket.emit('joinRoom', { username: 'TestUser', room: 'testroom' });
```

**Expected Server Output:**
```
User TestUser attempting to join room: testroom
Physics world created for room: testroom
TestUser joined room testroom. Players: 1/3
```

**Expected Browser Console:**
You should receive `worldState` and `roomInfo` events. Check with:
```javascript
socket.on('roomInfo', data => console.log('Room info:', data));
```

Try clicking to spawn circles - server should log:
```
Circle 0 spawned in room testroom at (234, 456)
```

**Commit:** `git commit -am "Step 5: Add Socket.IO room joining logic"`

---

## Step 6: Add Join Screen UI to Client (15 min)

**Goal:** Add a form so players can't access the game without joining a room first.

### Code Changes

Open `index.html`. In the `<style>` section, add these new styles after the `body` style:

```css
#joinScreen {
    background: rgba(255, 255, 255, 0.95);
    padding: 30px;
    border-radius: 10px;
    text-align: center;
    box-shadow: 0 4px 20px rgba(0,0,0,0.4);
    max-width: 400px;
}
#joinScreen h2 {
    margin: 0 0 20px 0;
    color: #333;
}
#joinScreen input {
    width: 100%;
    padding: 10px;
    margin: 10px 0;
    border: 2px solid #ddd;
    border-radius: 5px;
    font-size: 14px;
    box-sizing: border-box;
}
#joinScreen input:focus {
    outline: none;
    border-color: #2196F3;
}
#joinBtn {
    width: 100%;
    padding: 12px;
    margin-top: 10px;
    font-size: 16px;
    font-weight: bold;
    background: #2196F3;
    color: white;
    border: none;
    border-radius: 5px;
    cursor: pointer;
}
#joinBtn:hover {
    background: #0b7dda;
}
#errorMessage {
    color: #f44336;
    margin-top: 10px;
    display: none;
}
#gameContainer {
    display: none;
}
#roomInfo {
    background: #e3f2fd;
    padding: 10px;
    border-radius: 5px;
    margin-bottom: 15px;
    font-size: 14px;
}
.player-name {
    display: inline-block;
    background: #4CAF50;
    color: white;
    padding: 3px 8px;
    margin: 2px;
    border-radius: 3px;
    font-size: 12px;
}
```

In the `<body>` section, **replace the entire controls div** with:

```html
<!-- Join Screen (shown first) -->
<div id="joinScreen">
    <h2>🎮 p5.js + Matter.js Physics Server</h2>
    <p>Enter your details to join a room (max 3 players per room)</p>
    <input type="text" id="usernameInput" placeholder="Your name" maxlength="20" required>
    <input type="text" id="roomInput" placeholder="Room name" maxlength="20" required>
    <button id="joinBtn">Join Room</button>
    <div id="errorMessage"></div>
</div>

<!-- Game Container (shown after joining) -->
<div id="gameContainer">
    <div id="controls">
        <h2>🎮 p5.js + Matter.js Physics Server</h2>

        <div id="roomInfo"></div>

        <div class="button-row">
            <button id="circleBtn" class="circle">🔵 Circle Mode</button>
            <button id="boxBtn" class="box">🟧 Box Mode</button>
            <button id="explodeBtn" class="explode">💥 Explode Mode</button>
        </div>

        <div class="button-row">
            <button id="clearBtn" class="clear">🗑️ Clear All</button>
        </div>

        <div id="info">
            <strong>Current Mode:</strong> <span class="mode" id="currentMode">Circle</span><br>
            <strong>Instructions:</strong> Click canvas to spawn objects or create explosions<br>
            Matter.js physics runs on server @ 60 FPS | p5.js renders on client @ 60 FPS | Network @ 20 Hz
        </div>
    </div>
</div>
```

In the `<script>` section, add these variables after the `mode` variable:

```javascript
// Room state
let username = '';
let roomName = '';
let inRoom = false;
```

Add this **before the `function setup()`**:

```javascript
// ====== JOIN ROOM LOGIC ======

// Handle join button click
document.getElementById('joinBtn').addEventListener('click', () => {
    username = document.getElementById('usernameInput').value.trim();
    roomName = document.getElementById('roomInput').value.trim();

    if (!username || !roomName) {
        showError('Please enter both name and room name!');
        return;
    }

    // Send join request to server
    socket.emit('joinRoom', { username, room: roomName });
});

// Handle Enter key in input fields
document.getElementById('usernameInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') document.getElementById('joinBtn').click();
});
document.getElementById('roomInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') document.getElementById('joinBtn').click();
});

// Handle room full error
socket.on('roomFull', (data) => {
    showError(data.message);
});

// Handle room info updates
socket.on('roomInfo', (data) => {
    const roomInfoDiv = document.getElementById('roomInfo');
    const playersList = data.players.map(p => `<span class="player-name">${p}</span>`).join(' ');
    roomInfoDiv.innerHTML = `
        <strong>Room:</strong> ${data.room} |
        <strong>Players:</strong> ${data.playerCount}/${data.maxPlayers}<br>
        ${playersList}
    `;
});

function showError(message) {
    const errorDiv = document.getElementById('errorMessage');
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
    setTimeout(() => {
        errorDiv.style.display = 'none';
    }, 3000);
}

// ====== P5.JS SETUP ======
```

Update the `worldState` handler in `setup()`:

**Find:**
```javascript
socket.on('worldState', (data) => {
    worldWidth = data.width;
    worldHeight = data.height;
    bodies = {};
    data.bodies.forEach(bodyData => {
        bodies[bodyData.id] = bodyData;
    });
    console.log('World state received:', data);
});
```

**Replace with:**
```javascript
socket.on('worldState', (data) => {
    worldWidth = data.width;
    worldHeight = data.height;
    bodies = {};
    data.bodies.forEach(bodyData => {
        bodies[bodyData.id] = bodyData;
    });
    console.log('World state received:', data);

    // Switch to game screen
    if (!inRoom) {
        inRoom = true;
        document.getElementById('joinScreen').style.display = 'none';
        document.getElementById('gameContainer').style.display = 'block';
    }
});
```

### Testing Step 6

Restart server and open http://localhost:3000

**Expected:** You should see a join screen, NOT the game.

1. Try clicking "Join Room" with empty fields → Error message appears
2. Enter name "Alice" and room "testroom"
3. Click "Join Room"
4. Join screen should disappear, game should appear
5. Room info should show: "Room: testroom | Players: 1/3" with your name

**Commit:** `git commit -am "Step 6: Add join screen UI"`

---

## Step 7: Enforce 3-Player Limit (10 min)

**Goal:** Test that the 4th player gets rejected.

### Testing Step 7

The limit is already enforced from Step 5! Let's verify it works:

1. Open http://localhost:3000 in Tab 1
   - Join as "Alice" in "room1"

2. Open Tab 2
   - Join as "Bob" in "room1"
   - Should see: "Room: room1 | Players: 2/3"
   - Both Alice and Bob names should appear

3. Open Tab 3
   - Join as "Carol" in "room1"
   - Should see: "Room: room1 | Players: 3/3"
   - All three names appear

4. Open Tab 4
   - Join as "Dave" in "room1"
   - Should see **RED ERROR**: "Room 'room1' is full! Maximum 3 players allowed."
   - Should stay on join screen

5. In Tab 4
   - Join as "Dave" in "room2"
   - Should succeed! Separate physics world

6. Spawn objects in Tab 1 (room1) and Tab 4 (room2)
   - They should NOT see each other's objects!

### Server Console Check

You should see output like:
```
User Alice attempting to join room: room1
Physics world created for room: room1
Alice joined room room1. Players: 1/3

User Bob attempting to join room: room1
Bob joined room room1. Players: 2/3

User Carol attempting to join room: room1
Carol joined room room1. Players: 3/3

User Dave attempting to join room: room1
Room room1 is full. User Dave rejected.

User Dave attempting to join room: room2
Physics world created for room: room2
Dave joined room room2. Players: 1/3
```

### Adding Console Logging

If you want students to see the data structures in action, add these console.logs:

In `createCircle`:
```javascript
console.log(`Room ${roomName} now has ${room.bodies.length} bodies`);
```

In `deleteRoomPhysics`:
```javascript
console.log(`Remaining rooms: ${Object.keys(rooms).join(', ') || 'none'}`);
```

**Commit:** `git commit -am "Step 7: Verify 3-player limit works"`

---

## Complete Testing Checklist

Run through this entire scenario:

- [ ] 3 players join room1 successfully
- [ ] 4th player rejected from room1
- [ ] 4th player can join room2
- [ ] Objects in room1 not visible in room2
- [ ] Player names show in room info
- [ ] When player disconnects, count updates (e.g., 3/3 → 2/3)
- [ ] When all players leave, server logs "Physics world deleted"
- [ ] New player can re-join empty room (physics world recreates)

---

## Key Concepts Review

### Data Structure: users array
```javascript
[
  { id: "socket123", username: "Alice", room: "room1" },
  { id: "socket456", username: "Bob", room: "room1" }
]
```
**Purpose:** Track which player is in which room

### Data Structure: rooms object
```javascript
{
  "room1": { engine, world, bodies: [...], nextBodyId: 5 },
  "room2": { engine, world, bodies: [...], nextBodyId: 2 }
}
```
**Purpose:** Isolate physics simulation per room

### Architecture Pattern: Room-Based Broadcasting
```javascript
io.emit()              // ❌ Sends to everyone (not what we want!)
io.to(room).emit()     // ✅ Sends only to players in that room
socket.emit()          // ✅ Sends only to one player
```

### Architecture Pattern: State Lookup
```javascript
// Always look up which room the player is in
const user = getCurrentUser(socket.id);
const room = rooms[user.room];
// Then operate on that room's data
```

---

## Common Issues & Solutions

**Problem:** "Cannot read property 'room' of undefined"
**Solution:** Player hasn't joined a room yet. Add `if (!user) return;` checks.

**Problem:** Players in different rooms see each other's objects
**Solution:** Make sure you're using `io.to(roomName).emit()` not `io.emit()`

**Problem:** Room physics world not deleted when empty
**Solution:** Check disconnect handler calls `deleteRoomPhysics()` when count hits 0

**Problem:** Body IDs conflict between rooms
**Solution:** This is fine! Each room has independent `nextBodyId` counter

---

## Extensions (If Time Permits)

1. **Add room list:** Show available rooms with player counts
2. **Player colors:** Assign each player a color, show their username on objects they spawn
3. **Room capacity setting:** Let room creator set max players (2-10)
4. **Spectator mode:** Allow 4th+ player to watch but not interact

---

## Summary

You've learned:
✅ How to track players in rooms using a simple array
✅ How to isolate game state per room using nested objects
✅ How Socket.IO rooms enable targeted broadcasting
✅ How to enforce player limits before joining
✅ How to clean up resources when rooms empty

**Key Takeaway:** The `rooms` object is the heart of the system - each key is a room name, each value contains that room's complete game state (engine, world, bodies, IDs).

Great work! 🎉
