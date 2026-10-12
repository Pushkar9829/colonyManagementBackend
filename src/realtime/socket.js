import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import env from '../config/env.js';
import logger from '../common/utils/logger.js';
import { loadPrincipal } from '../modules/users/principal.js';

// Socket.IO server. Clients authenticate with the same access token as the REST API and join:
//   user:<id>:<society>       personal events (notifications) for the society this session is in
//   society:<id>              everyone in the society
//   society:<id>:role:<role>  e.g. all guards (gate screens)
//   society:<id>:unit:<id>    one household
let io = null;

export function attachRealtime(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: env.allowAllOrigins ? true : env.corsOrigins, methods: ['GET', 'POST'] },
    path: '/socket.io',
  });

  io.use(async (socket, next) => {
    try {
      const payload = jwt.verify(socket.handshake.auth?.token || '', env.JWT_ACCESS_SECRET);
      const user = await loadPrincipal(payload.sub, payload.mid);
      if (!user.society) return next(new Error('no-society'));
      socket.data.user = user;
      return next();
    } catch {
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const { _id, society, role, unit } = socket.data.user;
    socket.join([`user:${_id}:${society}`, `society:${society}`, `society:${society}:role:${role}`]);
    if (unit) socket.join(`society:${society}:unit:${unit}`);
  });

  logger.info('realtime (socket.io) attached');
  return io;
}

const emit = (room, event, data) => io?.to(room).emit(event, data);

export const emitToUser = (userId, societyId, event, data) => emit(`user:${userId}:${societyId}`, event, data);

// Tells clients which cached lists to refetch, e.g. invalidate(societyId, ['visitors']).
// Targets narrow the audience: { roles: ['guard'], unit: unitId }; default is the whole society.
export function invalidate(societyId, keys, { roles, unit } = {}) {
  if (!io) return;
  const payload = { keys };
  if (!roles && !unit) return emit(`society:${societyId}`, 'invalidate', payload);
  for (const r of roles || []) emit(`society:${societyId}:role:${r}`, 'invalidate', payload);
  if (unit) emit(`society:${societyId}:unit:${unit}`, 'invalidate', payload);
  // admins and managers watch everything
  for (const r of ['admin', 'facility_manager']) if (!roles?.includes(r)) emit(`society:${societyId}:role:${r}`, 'invalidate', payload);
  return undefined;
}

export function closeRealtime() {
  return io ? new Promise((resolve) => io.close(() => resolve())) : Promise.resolve();
}
