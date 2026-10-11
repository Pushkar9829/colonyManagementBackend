import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { ROLES } from '../../common/constants/index.js';
import * as controller from './marketplace.controller.js';
import * as schema from './marketplace.validation.js';

const { RESIDENT, FACILITY_MANAGER, ACCOUNTANT } = ROLES;
const router = Router();
router.use(authenticate, requireSociety, authorize(RESIDENT, FACILITY_MANAGER, ACCOUNTANT));

const moderator = authorize(FACILITY_MANAGER);
const adminOnly = authorize(); // society admin always passes authorize()

router.get('/reports', moderator, validate({ query: schema.listReports }), controller.listReports);
router.post('/reports/:id/resolve', moderator, validate({ params: schema.idParams, body: schema.resolveReport }), controller.resolveReport);

router.get('/businesses', validate({ query: schema.listBusinesses }), controller.listBusinesses);
router.post('/businesses', validate({ body: schema.createBusiness }), controller.createBusiness);
router.patch('/businesses/:id', validate({ params: schema.idParams, body: schema.updateBusiness }), controller.updateBusiness);
router.post('/businesses/:id/review', adminOnly, validate({ params: schema.idParams, body: schema.reviewBusiness }), controller.reviewBusiness);
router.post('/businesses/:id/contact', validate({ params: schema.idParams, body: schema.contact }), controller.contactBusiness);
router.delete('/businesses/:id', validate({ params: schema.idParams }), controller.deleteBusiness);

router.get('/listings', validate({ query: schema.listListings }), controller.listListings);
router.post('/listings', validate({ body: schema.createListing }), controller.createListing);
router.get('/listings/:id', validate({ params: schema.idParams }), controller.getListing);
router.patch('/listings/:id', validate({ params: schema.idParams, body: schema.updateListing }), controller.updateListing);
router.post('/listings/:id/status', validate({ params: schema.idParams, body: schema.listingStatus }), controller.setListingStatus);
router.delete('/listings/:id', validate({ params: schema.idParams, body: schema.removeListing }), controller.deleteListing);
router.post('/listings/:id/report', validate({ params: schema.idParams, body: schema.report }), controller.reportListing);
router.post('/listings/:id/contact', validate({ params: schema.idParams, body: schema.contact }), controller.contactSeller);

export default router;
