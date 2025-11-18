'use strict';

const express = require('express');
const socketIO = require('socket.io');
const path = require('path');
const Matter = require('matter-js');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'index.html');

const server = express()
    .use((req, res) => res.sendFile(INDEX))
    .listen(PORT, () => console.log(`Listening on ${PORT}`));

const io = socketIO(server);

// ====== MATTER.JS PHYSICS ENGINE SETUP ======

const Engine = Matter.Engine;
const World = Matter.World;
const Bodies = Matter.Bodies;
const Body = Matter.Body;

// Create physics engine
const engine = Engine.create();
const world = engine.world;

// World settings
const WORLD_WIDTH = 800;
const WORLD_HEIGHT = 600;

// Disable gravity initially (we'll add it later)
engine.world.gravity.y = 1; // Matter.js units (1 = normal Earth gravity)

// Create static walls
const wallThickness = 50;
const walls = [
    Bodies.rectangle(WORLD_WIDTH / 2, -wallThickness / 2, WORLD_WIDTH, wallThickness, { isStatic: true }), // Top
    Bodies.rectangle(WORLD_WIDTH / 2, WORLD_HEIGHT + wallThickness / 2, WORLD_WIDTH, wallThickness, { isStatic: true }), // Bottom
    Bodies.rectangle(-wallThickness / 2, WORLD_HEIGHT / 2, wallThickness, WORLD_HEIGHT, { isStatic: true }), // Left
    Bodies.rectangle(WORLD_WIDTH + wallThickness / 2, WORLD_HEIGHT / 2, wallThickness, WORLD_HEIGHT, { isStatic: true }) // Right
];

World.add(world, walls);

// Track dynamic bodies (circles and boxes)
let bodies = [];
let nextBodyId = 0;

// ====== HELPER FUNCTIONS ======

function createCircle(x, y) {
    const radius = 15 + Math.random() * 25; // Random size 15-40
    const circle = Bodies.circle(x, y, radius, {
        restitution: 0.8, // Bounciness
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

function createBox(x, y) {
    const size = 20 + Math.random() * 40; // Random size 20-60
    const box = Bodies.rectangle(x, y, size, size, {
        restitution: 0.6,
        friction: 0.05,
        density: 0.001,
        render: {
            fillStyle: `rgb(${Math.floor(Math.random() * 256)}, ${Math.floor(Math.random() * 256)}, ${Math.floor(Math.random() * 256)})`
        }
    });

    const bodyData = {
        id: nextBodyId++,
        matterId: box.id,
        type: 'box',
        width: size,
        height: size,
        color: box.render.fillStyle
    };

    World.add(world, box);
    bodies.push({ matter: box, data: bodyData });

    return bodyData;
}

function applyForce(bodyId, forceX, forceY) {
    const body = bodies.find(b => b.data.id === bodyId);
    if (body) {
        Body.applyForce(body.matter, body.matter.position, { x: forceX, y: forceY });
    }
}

function clearAllBodies() {
    bodies.forEach(b => World.remove(world, b.matter));
    bodies = [];
}

// Serialize physics state for clients
function getPhysicsState() {
    return bodies.map(b => {
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

// ====== GAME LOOP ======

const TICK_RATE = 60; // 60 FPS physics simulation
const UPDATE_RATE = 20; // Send updates to clients at 20 Hz

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

// ====== SOCKET.IO HANDLERS ======

io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    // Send initial world state
    socket.emit('worldState', {
        width: WORLD_WIDTH,
        height: WORLD_HEIGHT,
        bodies: getPhysicsState()
    });

    // Spawn circle
    socket.on('spawnCircle', (data) => {
        const bodyData = createCircle(data.x, data.y);
        io.emit('bodySpawned', bodyData);
        console.log(`Circle ${bodyData.id} spawned at (${data.x}, ${data.y})`);
    });

    // Spawn box
    socket.on('spawnBox', (data) => {
        const bodyData = createBox(data.x, data.y);
        io.emit('bodySpawned', bodyData);
        console.log(`Box ${bodyData.id} spawned at (${data.x}, ${data.y})`);
    });

    // Apply explosion force
    socket.on('explode', (data) => {
        bodies.forEach(b => {
            const dx = b.matter.position.x - data.x;
            const dy = b.matter.position.y - data.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < data.radius) {
                const forceMagnitude = data.power / (distance + 1);
                const forceX = (dx / distance) * forceMagnitude;
                const forceY = (dy / distance) * forceMagnitude;
                Body.applyForce(b.matter, b.matter.position, { x: forceX, y: forceY });
            }
        });
        console.log(`Explosion at (${data.x}, ${data.y})`);
    });

    // Clear all bodies
    socket.on('clearBodies', () => {
        clearAllBodies();
        io.emit('bodiesCleared');
        console.log('All bodies cleared');
    });

    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
    });
});

console.log('Matter.js physics engine initialized');
console.log(`World: ${WORLD_WIDTH}x${WORLD_HEIGHT}`);
