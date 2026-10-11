import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './emergency.service.js';

const paged = (fn) =>
  asyncHandler(async (req, res) => {
    const q = query(req);
    const { items, meta } = await fn(ctx(req), q, getPagination(q));
    ok(res, items, meta);
  });
const gone = (fn) =>
  asyncHandler(async (req, res) => {
    await fn(ctx(req), req.params.id);
    noContent(res);
  });

export const listContacts = asyncHandler(async (req, res) => ok(res, await service.listContacts(ctx(req), query(req))));
export const createContact = asyncHandler(async (req, res) => created(res, await service.createContact(ctx(req), req.body)));
export const updateContact = asyncHandler(async (req, res) => ok(res, await service.updateContact(ctx(req), req.params.id, req.body)));
export const removeContact = gone(service.removeContact);
export const reorderContacts = asyncHandler(async (req, res) => ok(res, await service.reorderContacts(ctx(req), req.body.ids)));

export const listChildren = paged(service.listChildren);
export const createChild = asyncHandler(async (req, res) => created(res, await service.createChild(ctx(req), req.body)));
export const updateChild = asyncHandler(async (req, res) => ok(res, await service.updateChild(ctx(req), req.params.id, req.body)));
export const removeChild = gone(service.removeChild);

export const raiseExit = asyncHandler(async (req, res) => created(res, await service.raiseChildExit(ctx(req), req.params.id, req.body)));
export const listAlerts = paged(service.listAlerts);
export const acknowledge = asyncHandler(async (req, res) => ok(res, await service.acknowledgeAlert(ctx(req), req.params.id, req.body)));
