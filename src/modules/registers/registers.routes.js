import { Router } from 'express';
import { authenticate, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { requireGovernance } from '../committee/committee.access.js';
import * as controller from './registers.controller.js';
import * as s from './registers.validation.js';

// Statutory registers are kept by the committee. Members read their own entries (/mine,
// and their own member / certificate records — the service checks ownership).
const router = Router();
router.use(authenticate, requireSociety);
const gov = requireGovernance;

router.get('/mine', controller.mine);

router.get('/members', gov, validate({ query: s.listMembers }), controller.listMembers);
router.post('/members', gov, validate({ body: s.createMember }), controller.createMember);
router.get('/members/:id', validate({ params: s.idParams }), controller.getMember);
router.patch('/members/:id', gov, validate({ params: s.idParams, body: s.updateMember }), controller.updateMember);
router.post('/members/:id/cease', gov, validate({ params: s.idParams, body: s.ceaseMember }), controller.ceaseMember);
router.get('/j-form', gov, controller.jForm);
router.get('/j-form/pdf', gov, controller.jFormPdf);

router.get('/certificates', gov, validate({ query: s.listCertificates }), controller.listCertificates);
router.post('/certificates', gov, validate({ body: s.issueCertificate }), controller.issueCertificate);
router.get('/certificates/:id', validate({ params: s.idParams }), controller.getCertificate);
router.get('/certificates/:id/pdf', validate({ params: s.idParams }), controller.certificatePdf);
router.post('/certificates/:id/cancel', gov, validate({ params: s.idParams, body: s.cancelCertificate }), controller.cancelCertificate);

router.get('/transfers', gov, validate({ query: s.listTransfers }), controller.listTransfers);
router.post('/transfers', gov, validate({ body: s.transfer }), controller.transfer);

router.get('/nominations', gov, validate({ query: s.listNominations }), controller.listNominations);
router.post('/nominations', gov, validate({ body: s.createNomination }), controller.createNomination);
router.post('/nominations/:id/revoke', gov, validate({ params: s.idParams }), controller.revokeNomination);

export default router;
