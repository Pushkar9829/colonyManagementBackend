import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './chat.service.js';

export const listConversations = asyncHandler(async (req, res) => {
  const { items, meta } = await service.listConversations(ctx(req), getPagination(query(req)));
  ok(res, items, meta);
});
export const getConversation = asyncHandler(async (req, res) => ok(res, await service.getConversation(ctx(req), req.params.id)));
export const openDirect = asyncHandler(async (req, res) => ok(res, await service.openDirect(ctx(req), req.body.userId)));
export const openDesk = asyncHandler(async (req, res) => ok(res, await service.openDesk(ctx(req), req.body)));
export const listMessages = asyncHandler(async (req, res) => {
  const { items, meta } = await service.listMessages(ctx(req), req.params.id, query(req));
  ok(res, items, meta);
});
export const sendMessage = asyncHandler(async (req, res) => created(res, await service.sendMessage(ctx(req), req.params.id, req.body)));
export const markRead = asyncHandler(async (req, res) => ok(res, await service.markRead(ctx(req), req.params.id)));
export const typing = asyncHandler(async (req, res) => ok(res, await service.typing(ctx(req), req.params.id)));
export const unread = asyncHandler(async (req, res) => ok(res, await service.unreadCount(ctx(req))));
export const contacts = asyncHandler(async (req, res) => ok(res, await service.contacts(ctx(req), query(req))));
export const listBlocks = asyncHandler(async (req, res) => ok(res, await service.listBlocks(ctx(req))));
export const block = asyncHandler(async (req, res) => ok(res, await service.block(ctx(req), req.body.userId)));
export const unblock = asyncHandler(async (req, res) => ok(res, await service.unblock(ctx(req), req.params.userId)));
