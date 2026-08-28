import { io } from 'socket.io-client';
import { SERVER_URL } from './constants.js';

// Thin wrapper around the socket.io connection. Keeps event names in one
// place and exposes a small callback-based API to the rest of the client.
export class Network {
  constructor() {
    this.socket = null;
    this.selfId = null;
  }

  connect(name, handlers) {
    this.socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });
    this.handlers = handlers;

    this.socket.on('connect', () => {
      this.socket.emit('join', { name });
    });

    this.socket.on('init', (data) => {
      this.selfId = data.selfId;
      handlers.onInit?.(data);
    });

    this.socket.on('playerJoined', (p) => handlers.onPlayerJoined?.(p));
    this.socket.on('playerLeft', ({ id }) => handlers.onPlayerLeft?.(id));
    this.socket.on('state', ({ players }) => handlers.onState?.(players));
    this.socket.on('shoveAction', ({ playerId }) => handlers.onShoveAction?.(playerId));
    this.socket.on('shoveHit', (data) => handlers.onShoveHit?.(data));
    this.socket.on('playerEliminated', ({ id }) => handlers.onEliminated?.(id));
    this.socket.on('roundOver', (data) => handlers.onRoundOver?.(data));
    this.socket.on('roundStart', (data) => handlers.onRoundStart?.(data));
    this.socket.on('disconnect', () => handlers.onDisconnect?.());
  }

  sendMove(transform) {
    if (!this.socket?.connected) return;
    this.socket.emit('move', transform);
  }

  sendShove() {
    if (!this.socket?.connected) return;
    this.socket.emit('shove');
  }
}
