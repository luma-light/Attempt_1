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

// ====== MATTER.JS PHYSICS ENGINE SETUP ======

const Engine = Matter.Engine;
const World = Matter.World;
const Bodies = Matter.Bodies;
const Body = Matter.Body;

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

    // Create room object
    rooms[roomName] = {
        engine: engine,
        world: world,
        bodies: [], // Track dynamic bodies (circles and boxes)
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

// ====== HELPER FUNCTIONS (Room-Specific) ======

function createCircle(roomName, x, y) {
    const room = getRoomPhysics(roomName);

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

function createBox(roomName, x, y) {
    const room = getRoomPhysics(roomName);

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
        id: room.nextBodyId++,
        matterId: box.id,
        type: 'box',
        width: size,
        height: size,
        color: box.render.fillStyle
    };

    World.add(room.world, box);
    room.bodies.push({ matter: box, data: bodyData });

    return bodyData;
}

function clearAllBodies(roomName) {
    const room = rooms[roomName];
    if (room) {
        room.bodies.forEach(b => World.remove(room.world, b.matter));
        room.bodies = [];
    }
}

// Serialize physics state for clients
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

// ====== GAME LOOP (All Rooms) ======

const TICK_RATE = 60; // 60 FPS physics simulation
const UPDATE_RATE = 20; // Send updates to clients at 20 Hz

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

// ====== SOCKET.IO HANDLERS ======

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

    // Spawn circle
    socket.on('spawnCircle', (data) => {
        const user = getCurrentUser(socket.id);
        if (!user) return;

        const bodyData = createCircle(user.room, data.x, data.y);
        io.to(user.room).emit('bodySpawned', bodyData);
        console.log(`Circle ${bodyData.id} spawned in room ${user.room} at (${data.x}, ${data.y})`);
    });

    // Spawn box
    socket.on('spawnBox', (data) => {
        const user = getCurrentUser(socket.id);
        if (!user) return;

        const bodyData = createBox(user.room, data.x, data.y);
        io.to(user.room).emit('bodySpawned', bodyData);
        console.log(`Box ${bodyData.id} spawned in room ${user.room} at (${data.x}, ${data.y})`);
    });

    // Apply explosion force
    socket.on('explode', (data) => {
        const user = getCurrentUser(socket.id);
        if (!user) return;

        const room = rooms[user.room];
        if (!room) return;

        room.bodies.forEach(b => {
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
        console.log(`Explosion in room ${user.room} at (${data.x}, ${data.y})`);
    });

    // Clear all bodies
    socket.on('clearBodies', () => {
        const user = getCurrentUser(socket.id);
        if (!user) return;

        clearAllBodies(user.room);
        io.to(user.room).emit('bodiesCleared');
        console.log(`All bodies cleared in room ${user.room}`);
    });

    // Handle disconnect
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
});

console.log('Matter.js physics engine initialized');
console.log(`World: ${WORLD_WIDTH}x${WORLD_HEIGHT}`);
