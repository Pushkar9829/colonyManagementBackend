import { Router } from 'express';
import multer from 'multer';
import { authenticate, authorize, requirePlatform, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import ApiError from '../../common/errors/ApiError.js';
import { ROLES } from '../../common/constants/index.js';
import { audited } from '../platformTeam/platformAudit.js';
import { MAX_VIDEO_BYTES } from './ads.service.js';
import * as controller from './ads.controller.js';
import * as schema from './ads.validation.js';

const parser = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_VIDEO_BYTES, files: 1 } }).single('file');
const receive = (req, res, next) =>
  parser(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(ApiError.badRequest(`The file is larger than ${MAX_VIDEO_BYTES / 1024 / 1024} MB`));
    return next(ApiError.badRequest(err.message));
  });

const router = Router();
router.use(authenticate);

// Delivery: banner + pop-up for whoever is signed in (society members, and the platform console).
router.get('/active', controller.active);

// Society ads: the society admin and facility manager ("colony owner / manager"), own society only.
const society = Router();
society.use(requireSociety, authorize(ROLES.FACILITY_MANAGER));
society.get('/settings', controller.societySettings);
society.post('/media', receive, controller.media('society'));
society.get('/', validate({ query: schema.listAds.omit({ society: true }) }), controller.list('society'));
society.post('/', validate({ body: schema.createAd }), controller.create('society'));
society.get('/:id/stats', validate({ params: schema.idParams, query: schema.statsQuery }), controller.stats('society'));
society.patch('/:id', validate({ params: schema.idParams, body: schema.updateAd }), controller.update('society'));
society.delete('/:id', validate({ params: schema.idParams }), controller.remove('society'));
router.use('/society', society);

// Platform ads: platform team with ads.manage.
const platform = Router();
platform.use(requirePlatform('ads.manage'));
platform.post('/media', receive, controller.media('platform'));
platform.get('/societies', validate({ query: schema.societiesQuery }), controller.platformSocieties);
platform.put('/societies/:id/settings', validate({ params: schema.idParams, body: schema.societySetting }), audited('ads.society_setting_changed', { targetType: 'Society' }), controller.setSocietySetting);
platform.get('/', validate({ query: schema.listAds }), controller.list('platform'));
platform.post('/', validate({ body: schema.createAd }), audited('ad.created', { targetType: 'Ad', targetId: (_req, data) => data?._id }), controller.create('platform'));
platform.get('/:id/stats', validate({ params: schema.idParams, query: schema.statsQuery }), controller.stats('platform'));
platform.patch('/:id', validate({ params: schema.idParams, body: schema.updateAd }), audited('ad.updated', { targetType: 'Ad' }), controller.update('platform'));
platform.delete('/:id', validate({ params: schema.idParams }), audited('ad.deleted', { targetType: 'Ad' }), controller.remove('platform'));
router.use('/platform', platform);

// Counters. Registered last so /society and /platform paths are never read as an ad id.
router.post('/:id/impression', validate({ params: schema.idParams, body: schema.eventBody }), controller.event('impression'));
router.post('/:id/click', validate({ params: schema.idParams, body: schema.eventBody }), controller.event('click'));
router.post('/:id/dismiss', validate({ params: schema.idParams, body: schema.eventBody }), controller.event('dismiss'));

export default router;
