# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Server-authoritative multiplayer physics demo combining Matter.js (physics engine on Node.js server) with p5.js (rendering on browser client). Physics simulation runs on the server at 60 FPS, state is broadcast to all connected clients at 20 Hz, and clients render at 60 FPS using p5.js.

**Room System**: Players join named rooms (max 3 players per room). Each room has its own independent physics world. Players in different rooms never see each other's objects.

## Commands

### Development
```bash
npm install       # Install dependencies (express, matter-js, socket.io)
npm start         # Start server on port 3000
```

### Testing Multiplayer
1. Open http://localhost:3000 in multiple browser tabs
2. Enter a username and room name (e.g., "Alice" and "room1")
3. In another tab, join the same room with a different username
4. Open a 3rd tab and join the same room - all 3 players share physics
5. Try opening a 4th tab - it will be rejected with "Room full" message
6. Open a tab with a different room name to create a separate physics world

## Architecture

### Room System (server.js)

Each room is completely isolated with its own physics world:

```javascript
const rooms = {}; // { roomName: { engine, world, bodies, nextBodyId } }
```

**Player Management** (all in server.js):
- `users` array tracks all connected players
- `userJoin(id, username, room)` - Adds player to room
- `getCurrentUser(id)` - Gets player by socket ID
- `userLeave(id)` - Removes player and returns their info
- `getRoomUsers(room)` - Returns all players in a room

**Physics World Per Room**:
- `createRoomPhysics(roomName)` - Creates new engine, world, and walls for a room
- `getRoomPhysics(roomName)` - Gets existing room or creates new one
- `deleteRoomPhysics(roomName)` - Cleans up empty room

When a room becomes empty (all players disconnect), its physics world is deleted to free memory.

### Two-Loop Game Server Pattern (server.js)

The server runs **two independent setInterval loops** that update **all active rooms**:

1. **Physics Loop (60 FPS)** - Updates Matter.js physics for every room
   ```javascript
   setInterval(() => {
       Object.keys(rooms).forEach(roomName => {
           const room = rooms[roomName];
           Engine.update(room.engine, 1000 / TICK_RATE);
       });
   }, 1000 / 60);
   ```

2. **Network Loop (20 Hz)** - Broadcasts each room's state to its players only
   ```javascript
   setInterval(() => {
       Object.keys(rooms).forEach(roomName => {
           const room = rooms[roomName];
           if (room.bodies.length > 0) {
               io.to(roomName).emit('physicsUpdate', getPhysicsState(roomName));
           }
       });
   }, 1000 / 20);
   ```

This separation allows smooth physics simulation (60 FPS) while keeping network bandwidth reasonable (20 updates/sec). Note that `io.to(roomName)` ensures updates only go to players in that specific room.

### State Serialization

Each room maintains its own `bodies` array where each element contains:
- `matter` - The Matter.js Body object (server-side physics)
- `data` - Metadata (id, type, color, dimensions)

`getPhysicsState(roomName)` serializes the room's bodies to plain objects sent to clients:
```javascript
{
    id: b.data.id,
    type: b.data.type,
    x: matter.position.x,      // Matter.js provides position
    y: matter.position.y,
    angle: matter.angle,        // Matter.js provides rotation
    vx: matter.velocity.x,
    vy: matter.velocity.y,
    // ... plus color, radius/width/height
}
```

### Client-Side Rendering (index.html)

Client stores bodies as plain objects (not Matter.js objects) and renders them with p5.js:

```javascript
socket.on('physicsUpdate', (bodiesData) => {
    bodies = {};  // Replace entire state
    bodiesData.forEach(bodyData => {
        bodies[bodyData.id] = bodyData;
    });
});

function draw() {
    Object.values(bodies).forEach(body => {
        push();
        translate(body.x, body.y);
        rotate(body.angle);  // Use angle from server
        // ... render circle or box
        pop();
    });
}
```

**Important**: Client has no physics engine. All position, velocity, and rotation data comes from server.

### Socket.IO Event Flow

**Client → Server:**
- `joinRoom` - Request to join a room with `{ username, room }`
- `spawnCircle` / `spawnBox` - Click to spawn objects (sent to user's room)
- `explode` - Apply radial force to nearby bodies in user's room
- `clearBodies` - Remove all dynamic bodies in user's room

**Server → Client:**
- `roomFull` - Sent if room has 3 players already (client stays on join screen)
- `worldState` - Sent after successful join (dimensions + initial bodies for that room)
- `roomInfo` - Sent when players join/leave (player count and list of names)
- `physicsUpdate` - Broadcast every 50ms (20 Hz) to room with body states
- `bodySpawned` - Immediate notification when body created in room
- `bodiesCleared` - Notification that all bodies removed from room

**Important**: All game events use `io.to(roomName)` to ensure they only go to players in that specific room. The server looks up the user's room via `getCurrentUser(socket.id)`.

## Matter.js Integration Notes

### Creating Bodies

Always use `Bodies.circle()` and `Bodies.rectangle()` factory functions, not constructors:

```javascript
const circle = Bodies.circle(x, y, radius, {
    restitution: 0.8,   // Bounciness (0-1)
    friction: 0.01,     // Surface friction
    density: 0.001      // Mass per unit area
});
```

### Adding to World

All bodies (static walls and dynamic objects) must be added to the world:
```javascript
World.add(world, bodies);
```

### Applying Forces

Use `Body.applyForce()` for explosions or impulses:
```javascript
Body.applyForce(body, body.position, { x: forceX, y: forceY });
```

The explosion system calculates force magnitude inversely proportional to distance:
```javascript
const forceMagnitude = data.power / (distance + 1);
```

### Static vs Dynamic Bodies

- **Static** (`isStatic: true`): Walls, platforms - never move, infinite mass
- **Dynamic** (default): Circles, boxes - affected by forces and collisions

Static walls are created at initialization and stored in `walls` array but not included in `getPhysicsState()` since they never change.

## Key Implementation Details

### Body ID Management

Each room has its own ID counter:
- `room.nextBodyId` - Sequential ID for game logic within that room (0, 1, 2...)
- `body.id` - Matter.js internal ID (not used for client communication)

Always use `data.id` (not `matter.id`) when referencing bodies in Socket.IO events. Body IDs are room-specific, so two different rooms can both have a body with ID 0.

### Coordinate System

- Origin (0, 0) is top-left
- Positive Y is down (standard canvas coordinates)
- World dimensions: 800x600 pixels
- Gravity: `engine.world.gravity.y = 1` (Matter.js units)

### Random Properties

Objects spawn with random size and color:
```javascript
const radius = 15 + Math.random() * 25;  // 15-40
const color = `rgb(${Math.floor(Math.random() * 256)}, ...)`;
```

Color is stored in `render.fillStyle` property and sent to clients.

## Common Modifications

### Adding New Body Types

1. Create factory function (like `createCircle`) that takes `roomName` as first parameter
2. Use `getRoomPhysics(roomName)` to get the room's physics world
3. Use Matter.js `Bodies.*` to create physics body
4. Store in `room.bodies` array with metadata
5. Add Socket.IO handler that gets user's room via `getCurrentUser(socket.id)`
6. Update client rendering in `draw()` function

### Changing Physics Parameters

- **Bounciness**: Adjust `restitution` (0-1)
- **Friction**: Adjust `friction` (0-1)
- **Mass**: Adjust `density` (affects collision response)
- **Gravity**: Modify `engine.world.gravity.y`

### Adjusting Update Rates

- Physics: Change `TICK_RATE` (currently 60)
- Network: Change `UPDATE_RATE` (currently 20)
- Client render: Modify `frameRate(60)` in setup()

Higher network rates increase bandwidth; lower rates increase latency.

### Changing Room Size

Change `MAX_PLAYERS_PER_ROOM` constant in server.js (currently 3). The server checks `getRoomUsers(room).length >= MAX_PLAYERS_PER_ROOM` before allowing joins.

## Debugging Tips

### Server Console
- Shows room join attempts and rejections
- Shows which room each player is in (e.g., "Alice joined room room1. Players: 2/3")
- Shows physics world creation/deletion for rooms
- Logs spawn and explosion events with room names
- Check if `rooms` object is growing (might indicate rooms not being cleaned up)

### Client Console (Browser DevTools)
- `bodies` object shows current state
- Check Socket.IO connection status
- Monitor frameRate if rendering is slow
- Check if `roomInfo` events are being received with player list

### Common Issues

**"Room full" error**: Room has 3 players. Try different room name or wait for someone to leave
**Objects not appearing**: Check that server is adding to correct room's world AND broadcasting to that room
**Seeing other players' objects**: Bug - check that `io.to(roomName)` is being used, not `io.emit()`
**Desynchronization**: Ensure client is replacing entire `bodies` object (not merging)
**Performance issues**: Reduce UPDATE_RATE or limit max body count per room
**Explosion too weak/strong**: Adjust `data.power` in explosion event (currently 5)
**Memory leak**: Check that `deleteRoomPhysics()` is called when last player leaves room

## File Structure

- `server.js` (~343 lines) - Express server + Room management + Matter.js physics + Socket.IO
  - Room management helper functions (lines 17-45)
  - Physics world creation per room (lines 47-107)
  - Room-specific helper functions (lines 109-196)
  - Game loops for all rooms (lines 198-219)
  - Socket.IO handlers with room logic (lines 221-340)
- `index.html` (~412 lines) - Join screen + p5.js client + Socket.IO client + HTML/CSS UI
  - Join screen UI and logic
  - Room info display
  - p5.js rendering for physics bodies
- `package.json` - Dependencies (express, matter-js, socket.io)

All logic is contained in these two files - no build system, bundler, or separate utility files required. This makes it easier for students to understand the complete flow.
