import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { GameRoom } from './GameRoom.js';
import { listMaps, DEFAULT_MAP_ID } from './maps.js';

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.get('/health', (req, res) => res.json({ ok: true, players: room?.players.size ?? 0 }));
app.get('/maps', (req, res) => res.json(listMaps()));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

const room = new GameRoom(io, DEFAULT_MAP_ID);
room.start();

io.on('connection', (socket) => {
  socket.on('join', (data) => {
    const player = room.addPlayer(socket.id, data?.name);
    socket.emit('init', {
      selfId: socket.id,
      map: room.serializeMap(),
      players: room.serializeAll()
    });
    socket.broadcast.emit('playerJoined', room.serializePlayer(player));
  });

  socket.on('move', (data) => {
    room.updateFromClient(socket.id, data);
  });

  socket.on('shove', () => {
    room.handleShove(socket.id);
  });

  socket.on('disconnect', () => {
    if (room.players.has(socket.id)) {
      room.removePlayer(socket.id);
      io.emit('playerLeft', { id: socket.id });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Sumo Arena server listening on http://localhost:${PORT}`);
});
