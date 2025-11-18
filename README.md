# p5.js + Matter.js Server-Authoritative Physics

A demonstration combining **Matter.js physics engine on the server** with **p5.js rendering on the client**. This gives you production-quality physics simulation with the ease of p5.js drawing syntax!

## What it does

🔵 **Circle Mode** - Click to spawn bouncing circles with random colors
🟧 **Box Mode** - Click to spawn rotating boxes
💥 **Explode Mode** - Click to create explosion force that pushes nearby objects
🗑️ **Clear All** - Remove all objects from the world

## Why This Combination?

| Component | Library | Runs On | Purpose |
|-----------|---------|---------|---------|
| **Physics** | Matter.js | Server | Industry-standard 2D physics |
| **Rendering** | p5.js | Client | Easy, intuitive drawing |
| **Networking** | Socket.IO | Both | Real-time sync |

### Benefits:

✅ **Matter.js is production-ready** - Used in real games (unlike simple custom physics)
✅ **Matter.js runs on Node.js** - No browser needed on server
✅ **p5.js is beginner-friendly** - Easy to learn, beautiful syntax
✅ **Server-authoritative** - Physics can't be hacked by clients
✅ **Perfect sync** - All clients see identical physics

## Running Locally

```bash
npm install
npm start
```

Open http://localhost:3000 in **multiple browser tabs** to see synchronized physics!

## Features

### Matter.js Physics (Server)

```javascript
// Create a bouncing circle with Matter.js
const circle = Bodies.circle(x, y, radius, {
    restitution: 0.8,  // Bounciness (0-1)
    friction: 0.01,    // Surface friction
    density: 0.001     // Mass per unit area
});

// Apply forces (explosions!)
Body.applyForce(body, position, { x: forceX, y: forceY });

// Update physics (60 FPS)
Engine.update(engine, 1000 / 60);
```

### p5.js Rendering (Client)

```javascript
// Draw circles with p5.js
fill(body.color);
ellipse(body.x, body.y, body.radius * 2);

// Draw boxes with rotation
push();
translate(body.x, body.y);
rotate(body.angle);  // Matter.js provides angle!
rect(0, 0, body.width, body.height);
pop();
```

## Architecture

### Server (server.js)

**Matter.js Setup:**
```javascript
const Matter = require('matter-js');
const Engine = Matter.Engine;
const World = Matter.World;
const Bodies = Matter.Bodies;

// Create physics world
const engine = Engine.create();
const world = engine.world;

// Add static walls
const walls = [
    Bodies.rectangle(400, 0, 800, 50, { isStatic: true }),
    // ... more walls
];
World.add(world, walls);
```

**Game Loop (Two Rates):**
```javascript
// Physics at 60 FPS (smooth simulation)
setInterval(() => {
    Engine.update(engine, 1000 / 60);
}, 1000 / 60);

// Network at 20 Hz (efficient bandwidth)
setInterval(() => {
    io.emit('physicsUpdate', getPhysicsState());
}, 1000 / 20);
```

**State Serialization:**
```javascript
function getPhysicsState() {
    return bodies.map(b => ({
        id: b.data.id,
        type: b.data.type,
        x: b.matter.position.x,      // Matter.js position
        y: b.matter.position.y,
        angle: b.matter.angle,        // Matter.js rotation
        vx: b.matter.velocity.x,      // Matter.js velocity
        vy: b.matter.velocity.y,
        // ... geometry and color
    }));
}
```

### Client (index.html)

**Receive Physics Updates:**
```javascript
socket.on('physicsUpdate', (bodiesData) => {
    bodies = {};
    bodiesData.forEach(bodyData => {
        bodies[bodyData.id] = bodyData;
    });
});
```

**Render with p5.js:**
```javascript
function draw() {
    background(20, 25, 40);

    Object.values(bodies).forEach(body => {
        push();
        translate(body.x, body.y);
        rotate(body.angle);  // Use Matter.js angle

        fill(body.color);

        if (body.type === 'circle') {
            ellipse(0, 0, body.radius * 2);
        } else if (body.type === 'box') {
            rectMode(CENTER);
            rect(0, 0, body.width, body.height);
        }

        pop();
    });
}
```

## Matter.js Key Concepts

### 1. Bodies

```javascript
// Static (walls, platforms)
Bodies.rectangle(x, y, width, height, { isStatic: true });

// Dynamic (circles, boxes)
Bodies.circle(x, y, radius, { restitution: 0.8 });
Bodies.rectangle(x, y, width, height, { friction: 0.1 });
```

### 2. Properties

- **restitution** (0-1) - Bounciness (0 = no bounce, 1 = perfect bounce)
- **friction** (0-1) - Surface friction
- **density** - Mass per unit area
- **isStatic** - Immovable object (walls)

### 3. Forces

```javascript
// Apply force at body's center
Body.applyForce(body, body.position, { x: 0.01, y: 0 });

// Apply force at specific point (creates torque)
Body.applyForce(body, { x: body.position.x, y: body.position.y + 10 }, { x: 0.01, y: 0 });
```

### 4. Velocity

```javascript
// Set velocity directly
Body.setVelocity(body, { x: 5, y: -10 });

// Set angular velocity (rotation speed)
Body.setAngularVelocity(body, 0.1);
```

## Implementation Details

### Explosion System

```javascript
// Server receives explosion request
socket.on('explode', (data) => {
    bodies.forEach(b => {
        const dx = b.matter.position.x - data.x;
        const dy = b.matter.position.y - data.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < data.radius) {
            // Force decreases with distance
            const forceMagnitude = data.power / (distance + 1);
            const forceX = (dx / distance) * forceMagnitude;
            const forceY = (dy / distance) * forceMagnitude;

            Body.applyForce(b.matter, b.matter.position, { x: forceX, y: forceY });
        }
    });
});
```

### Random Object Properties

```javascript
// Random size
const radius = 15 + Math.random() * 25; // 15-40

// Random color
const color = `rgb(${Math.floor(Math.random() * 256)}, ${Math.floor(Math.random() * 256)}, ${Math.floor(Math.random() * 256)})`;

// Random initial velocity (optional)
Body.setVelocity(body, {
    x: (Math.random() - 0.5) * 10,
    y: (Math.random() - 0.5) * 10
});
```

## Files

- `server.js` - Matter.js physics engine + Socket.IO server (197 lines)
- `index.html` - p5.js rendering client (208 lines)
- `package.json` - Dependencies including matter-js

## Performance

- **Server:** 60 FPS physics simulation
- **Network:** 20 Hz updates (40 KB/sec with 100 objects)
- **Client:** 60 FPS rendering
- **Latency:** ~50ms (20 Hz update rate)

## Testing Multiplayer

1. `npm start`
2. Open http://localhost:3000 in 3-4 tabs
3. Switch modes and click in different tabs
4. Watch objects spawn and interact synchronously
5. Try explosions to see force propagation
6. Note: All tabs show IDENTICAL physics!

## Deploying to CodeSandbox

1. Go to https://codesandbox.io
2. Create Node.js sandbox
3. Upload `server.js`, `index.html`, `package.json`
4. Click "Run"
5. Open preview in multiple tabs

CodeSandbox will automatically:
- Install `matter-js` dependency
- Set `process.env.PORT`
- Run the physics server

## Advantages Over Custom Physics

| Feature | Custom Physics | Matter.js |
|---------|---------------|-----------|
| Collision detection | Manual (error-prone) | Built-in (accurate) |
| Rotation physics | Complex math | Automatic |
| Constraints/joints | Very hard | Easy (chains, springs) |
| Performance | Varies | Optimized |
| Stability | Can explode | Stable |
| Development time | Days/weeks | Minutes |

## Possible Enhancements

Try adding:

- **Player-controlled objects** - Arrow keys to move a specific body
- **Constraints** - Springs, chains connecting objects
- **Sensors** - Trigger zones that detect overlaps
- **Collision events** - Server tracks collisions, emits to clients
- **Different shapes** - Polygons, compound bodies
- **Gravity toggle** - Button to enable/disable gravity
- **Body properties UI** - Sliders for restitution, friction, density
- **Composite bodies** - Ragdolls, cars with wheels

## Matter.js Advanced Features

### Constraints (not implemented, but possible)

```javascript
// Spring between two bodies
const spring = Constraint.create({
    bodyA: circleA,
    bodyB: circleB,
    stiffness: 0.1,
    damping: 0.01
});

// Chain (rope)
const chain = Composites.chain(group, 0.5, 0, -0.5, 0, {
    stiffness: 0.8,
    length: 2
});
```

### Collision Events

```javascript
Events.on(engine, 'collisionStart', (event) => {
    event.pairs.forEach(pair => {
        console.log('Collision between:', pair.bodyA.id, pair.bodyB.id);
        // Emit to clients, play sounds, etc.
    });
});
```

### Sensors (non-solid trigger zones)

```javascript
const sensor = Bodies.circle(x, y, 50, { isSensor: true });
// isSensor = detects collisions but doesn't physically interact
```

## Why Not p5.play?

p5.play includes physics, but:
- ❌ Requires browser (can't run on Node.js server)
- ❌ Less powerful than Matter.js
- ❌ Would require headless browser on server (slow, complex)

Matter.js:
- ✅ Runs natively on Node.js
- ✅ Production-quality physics
- ✅ Used in real games
- ✅ Active development

## Related Examples

- `../p5-physics-server/` - Custom physics (educational)
- `../p5-drawing/` - Collaborative drawing (no physics)
- `../chat/` - Simple Socket.IO messaging
- Parent repo's `VSCode-Networking-Test/` - p5.play with host authority

## Learning Resources

- Matter.js Documentation: https://brm.io/matter-js/docs/
- Matter.js Examples: https://brm.io/matter-js/demo/
- p5.js Reference: https://p5js.org/reference/
- Socket.IO Documentation: https://socket.io/docs/

## Credits

- **Matter.js** by Liam Brummitt - 2D physics engine
- **p5.js** by Processing Foundation - Creative coding library
- **Socket.IO** - Real-time communication
