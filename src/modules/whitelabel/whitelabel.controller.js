import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './whitelabel.service.js';

const listed = (res, { items, meta }) => ok(res, items, meta);

// public / society
export const branding = asyncHandler(async (req, res) => ok(res, await service.brandingLookup(query(req))));
export const societyBranding = asyncHandler(async (req, res) => ok(res, await service.brandForSociety(req.user.society)));
export const applyKey = asyncHandler(async (req, res) => ok(res, await service.activateKey(ctx(req), req.body.key)));

// platform console
export const listResellers = asyncHandler(async (req, res) => {
  const q = query(req);
  listed(res, await service.listResellers(q, getPagination(q)));
});
export const createReseller = asyncHandler(async (req, res) => created(res, await service.createReseller(req.user, req.body)));
export const getReseller = asyncHandler(async (req, res) => ok(res, await service.getReseller(req.params.id)));
export const updateReseller = asyncHandler(async (req, res) => ok(res, await service.updateReseller(req.user, req.params.id, req.body)));
export const uploadLogo = asyncHandler(async (req, res) => ok(res, await service.uploadLogo(req.params.id, req.file)));
export const addAdmin = asyncHandler(async (req, res) => ok(res, await service.addAdmin(req.user, req.params.id, req.body)));
export const removeAdmin = asyncHandler(async (req, res) => ok(res, await service.removeAdmin(req.user, req.params.id, req.params.userId)));
export const generateKeys = asyncHandler(async (req, res) => {
  // The only response that ever carries full keys: never cache it.
  res.set('Cache-Control', 'no-store');
  created(res, await service.generateKeys(req.user, req.params.id, req.body));
});
export const listKeys = asyncHandler(async (req, res) => {
  const q = query(req);
  listed(res, await service.listKeys(req.params.id, q, getPagination(q)));
});
export const revokeKey = asyncHandler(async (req, res) => ok(res, await service.revokeKey(req.user, req.params.id, req.params.keyId)));
export const listInvoices = asyncHandler(async (req, res) => {
  const q = query(req);
  listed(res, await service.listInvoices(req.params.id, getPagination(q)));
});
export const markInvoicePaid = asyncHandler(async (req, res) => ok(res, await service.markInvoicePaid(req.user, req.params.invoiceId, req.body)));

// reseller console: always the signed-in admin's own reseller
export const myHome = asyncHandler(async (req, res) => ok(res, await service.resellerHome(req.user.reseller)));
export const myKeys = asyncHandler(async (req, res) => {
  const q = query(req);
  listed(res, await service.listKeys(req.user.reseller, q, getPagination(q)));
});
export const revokeMyKey = asyncHandler(async (req, res) => ok(res, await service.revokeKey(req.user, req.user.reseller, req.params.keyId)));
export const mySocieties = asyncHandler(async (req, res) => {
  const q = query(req);
  listed(res, await service.resellerSocieties(req.user.reseller, getPagination(q)));
});
export const myInvoices = asyncHandler(async (req, res) => {
  const q = query(req);
  listed(res, await service.listInvoices(req.user.reseller, getPagination(q)));
});
