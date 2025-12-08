# p5.js + Matter.js Server-Authoritative Physics—AI Generated

A demonstration combining **Matter.js physics engine on the server** with **p5.js rendering on the client**. This gives you production-quality physics simulation with the ease of p5.js drawing syntax!

<!-- toc -->
<!-- tocstop -->

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

## Running in GitHub Codespaces

GitHub Codespaces provides a complete development environment in your browser. Follow these steps to get started:

### Step 1: Fork the Repository

1. Navigate to this repository on GitHub
2. Click the **"Fork"** button in the top-right corner of the page
3. Select your account as the destination for the fork
4. Wait for GitHub to create your copy of the repository

_[Screenshot placeholder: Show the Fork button location and the fork creation dialog]_

### Step 2: Open the Code Menu

1. On your forked repository page, click the green **"Code"** button
2. This will open a dropdown menu with several options

_[Screenshot placeholder: Show the Code button and opened dropdown menu]_

### Step 3: Switch to the Codespaces Tab

1. In the Code dropdown, click the **"Codespaces"** tab
2. If you don't see this tab, make sure you're signed into GitHub and have Codespaces access

_[Screenshot placeholder: Show the Codespaces tab in the Code dropdown]_

### Step 4: Create a Codespace

1. Click the **"Create codespace on main"** button (or whichever branch you want to use)
2. GitHub will start creating your development environment
3. Wait 30-60 seconds for the Codespace to initialize
4. A VS Code interface will appear in your browser

_[Screenshot placeholder: Show the "Create codespace" button and the loading screen]_

### Step 5: Install Dependencies

Once your Codespace opens:

1. A terminal should automatically open at the bottom
2. If not, open a new terminal: **Terminal → New Terminal** from the menu
3. Run the installation command:
   ```bash
   npm install
   ```
4. Wait for all dependencies to install (matter-js, express, socket.io)

_[Screenshot placeholder: Show terminal with npm install running]_

### Step 6: Start the Server

1. In the terminal, run:
   ```bash
   npm start
   ```
2. You should see output like:
   ```
   Listening on 3000
   Matter.js physics engine initialized
   World: 800x600
   ```

_[Screenshot placeholder: Show terminal with server running]_

### Step 7: Access the Application

1. A notification will appear saying **"Your application running on port 3000 is available"**
2. Click **"Open in Browser"** in the notification
   - If you miss the notification, look for the **"Ports"** tab at the bottom of VS Code
   - Find port 3000 and click the globe icon to open it in your browser
3. The application will open in a new browser tab

_[Screenshot placeholder: Show the port forwarding notification and the Ports tab]_

### Step 8: Test Multiplayer

1. With the application open, enter a username and room name, then click "Join Room"
2. Open 2-3 more browser tabs/windows with the same Codespace URL
3. Join the same room with different usernames
4. Try spawning objects in different tabs - they should appear synchronized across all tabs!

_[Screenshot placeholder: Show multiple browser tabs with the application running]_

### Branches

This repository has multiple branches for different use cases:

- **`main`** - Full Matter.js physics demo with explosions
- **`rooms-starter`** - Minimal starter with room management (max players per room)
- **`no-rooms-starter`** - Minimal starter without rooms (all players in one space)

To switch branches in your Codespace:
1. Click the branch name in the bottom-left corner of VS Code
2. Select a different branch from the list
3. Run `npm install` and `npm start` again

### Stopping and Restarting

- **To stop the server:** Press `Ctrl+C` in the terminal
- **To restart:** Run `npm start` again
- **To close your Codespace:** Close the browser tab (it will auto-sleep after inactivity)
- **To reopen your Codespace:** Go to github.com, click your profile → "Your codespaces" → select your codespace

### Troubleshooting

**Port not forwarding:**
- Check the "Ports" tab at the bottom of VS Code
- Make sure port 3000 shows "Visibility: Public"
- Click the globe icon next to port 3000 to open in browser

**Server won't start:**
- Make sure you ran `npm install` first
- Check for error messages in the terminal
- Try stopping (`Ctrl+C`) and restarting (`npm start`)

**Changes not showing:**
- After editing code files, stop the server (`Ctrl+C`) and restart it (`npm start`)
- Then hard refresh your browser: `Ctrl+Shift+R` (Windows/Linux) or `Cmd+Shift+R` (Mac)

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
