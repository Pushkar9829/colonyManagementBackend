import env from '../../config/env.js';
import { pushEnabled } from '../../integrations/webPush.js';
import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './notifications.service.js';

export const list = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.listMine(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const markRead = asyncHandler(async (req, res) => {
  await service.markRead(ctx(req), req.params.id);
  ok(res, { read: true });
});
export const markAllRead = asyncHandler(async (req, res) => {
  await service.markAllRead(ctx(req));
  ok(res, { read: true });
});

export const pushConfig = (_req, res) => ok(res, { enabled: pushEnabled, publicKey: pushEnabled ? env.VAPID_PUBLIC_KEY : null });
export const subscribePush = asyncHandler(async (req, res) => {
  await service.subscribePush(ctx(req), req.body, req.headers['user-agent']);
  ok(res, { subscribed: true });
});
export const unsubscribePush = asyncHandler(async (req, res) => {
  await service.unsubscribePush(ctx(req), req.body.endpoint);
  ok(res, { subscribed: false });
});
