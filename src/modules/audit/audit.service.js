import AuditLog from './audit.model.js';
import logger from '../../common/utils/logger.js';
import { paginate } from '../../common/utils/pagination.js';

// Fire-and-forget: an audit failure must never break the business action.
export function record(ctx, action, entity, entityId, meta) {
  // Inside a "Log in as" session the actor is the person being viewed; say who was really at the keyboard.
  const acting = ctx.user?.actingAs;
  if (acting) meta = { ...meta, actingAs: { by: acting.by, byName: acting.byName, sessionId: acting.sessionId } };
  AuditLog.create({ society: ctx.societyId, actor: ctx.userId, action, entity, entityId, meta, ip: ctx.ip }).catch((err) =>
    logger.error({ err, action }, 'audit write failed'),
  );
}

export function list(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.entity) filter.entity = filters.entity;
  if (filters.action) filter.action = filters.action;
  return paginate(AuditLog, filter, pagination, { populate: { path: 'actor', select: 'name role' } });
}
