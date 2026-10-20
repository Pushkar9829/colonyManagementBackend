import { Router } from 'express';
import multer from 'multer';
import { authenticate, authorize, requirePlatform, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { audited } from '../platformTeam/platformAudit.js';
import ApiError from '../../common/errors/ApiError.js';
import * as controller from './whitelabel.controller.js';
import * as schema from './whitelabel.validation.js';

// /api/v1/branding — public login-page branding (custom domain host or ?brand=<slug>) and the open society's.
export const brandingRouter = Router();
brandingRouter.get('/', validate({ query: schema.brandingQuery }), controller.branding);
brandingRouter.get('/society', authenticate, requireSociety, controller.societyBranding);

// /api/v1/licence — a society admin applies a licence key (Subscription page).
export const licenceRouter = Router();
licenceRouter.post('/apply', authenticate, requireSociety, authorize(), validate({ body: schema.applyKey }), controller.applyKey);

// /api/v1/reseller — the white-label partner's own console. Everything is scoped to req.user.reseller.
const requireReseller = (req, _res, next) => (req.user?.role === 'reseller_admin' && req.user.reseller ? next() : next(ApiError.forbidden('Reseller console only')));
export const resellerRouter = Router();
resellerRouter.use(authenticate, requireReseller);
resellerRouter.get('/', controller.myHome);
resellerRouter.get('/keys', validate({ query: schema.listKeys }), controller.myKeys);
resellerRouter.post('/keys/:keyId/revoke', validate({ params: schema.ownKeyParams }), controller.revokeMyKey);
resellerRouter.get('/societies', validate({ query: schema.listKeys.pick({ page: true, limit: true }) }), controller.mySocieties);
resellerRouter.get('/invoices', controller.myInvoices);

// /api/v1/platform/resellers — platform team with whitelabel.manage.
const logo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1 } }).single('file');
const receiveLogo = (req, res, next) => logo(req, res, (err) => (err ? next(ApiError.badRequest(err.code === 'LIMIT_FILE_SIZE' ? 'The logo must be under 1 MB' : err.message)) : next()));
const target = { targetType: 'Reseller' };

export const platformRouter = Router();
platformRouter.use(authenticate, requirePlatform('whitelabel.manage'));
platformRouter.post('/invoices/:invoiceId/mark-paid', validate({ params: schema.invoiceParams, body: schema.markPaid }),
  audited('reseller.invoice_paid', { targetType: 'ResellerInvoice', targetId: (req) => req.params.invoiceId }), controller.markInvoicePaid);
platformRouter.get('/', validate({ query: schema.listResellers }), controller.listResellers);
platformRouter.post('/', validate({ body: schema.createReseller }), audited('reseller.created', { ...target, targetId: (_req, data) => data?._id }), controller.createReseller);
platformRouter.get('/:id', validate({ params: schema.idParams }), controller.getReseller);
platformRouter.patch('/:id', validate({ params: schema.idParams, body: schema.updateReseller }), audited('reseller.updated', target), controller.updateReseller);
platformRouter.post('/:id/logo', validate({ params: schema.idParams }), receiveLogo, audited('reseller.logo_uploaded', target), controller.uploadLogo);
platformRouter.post('/:id/admins', validate({ params: schema.idParams, body: schema.addAdmin }), audited('reseller.admin_added', target), controller.addAdmin);
platformRouter.delete('/:id/admins/:userId', validate({ params: schema.adminParams }), audited('reseller.admin_removed', target), controller.removeAdmin);
platformRouter.post('/:id/keys', validate({ params: schema.idParams, body: schema.generateKeys }),
  audited('reseller.keys_generated', { ...target, details: (req, data) => ({ ...req.body, batch: data?.batch }) }), controller.generateKeys);
platformRouter.get('/:id/keys', validate({ params: schema.idParams, query: schema.listKeys }), controller.listKeys);
platformRouter.post('/:id/keys/:keyId/revoke', validate({ params: schema.keyParams }), audited('reseller.key_revoked', target), controller.revokeKey);
platformRouter.get('/:id/invoices', validate({ params: schema.idParams }), controller.listInvoices);
