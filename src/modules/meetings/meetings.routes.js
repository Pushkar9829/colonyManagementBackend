import { Router } from 'express';
import { authenticate, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { requireGovernance } from '../committee/committee.access.js';
import * as controller from './meetings.controller.js';
import * as s from './meetings.validation.js';

// Reads are open to every member; the service limits them to meetings they are invited to.
// Writes need the managing committee (admins or sitting office-bearers).
const router = Router();
router.use(authenticate, requireSociety);
const gov = requireGovernance;

router.get('/', validate({ query: s.listMeetings }), controller.list);
router.post('/', gov, validate({ body: s.createMeeting }), controller.create);
router.get('/action-items', validate({ query: s.listActionItems }), controller.listActionItems);
router.get('/:id', validate({ params: s.idParams }), controller.getById);
router.patch('/:id', gov, validate({ params: s.idParams, body: s.updateMeeting }), controller.update);
router.get('/:id/minutes/pdf', validate({ params: s.idParams }), controller.minutesPdf);
router.post('/:id/notice', gov, validate({ params: s.idParams }), controller.sendNotice);
router.post('/:id/cancel', gov, validate({ params: s.idParams, body: s.cancel }), controller.cancel);
router.get('/:id/invitees', gov, validate({ params: s.idParams }), controller.invitees);

router.post('/:id/agenda', gov, validate({ params: s.idParams, body: s.addAgendaItem }), controller.addAgendaItem);
router.patch('/:id/agenda/:itemId', gov, validate({ params: s.itemParams, body: s.updateAgendaItem }), controller.updateAgendaItem);
router.delete('/:id/agenda/:itemId', gov, validate({ params: s.itemParams }), controller.removeAgendaItem);
router.patch('/:id/minutes', gov, validate({ params: s.idParams, body: s.minutes }), controller.updateMinutes);
router.post('/:id/minutes/approve', gov, validate({ params: s.idParams }), controller.approveMinutes);

router.post('/:id/attendance', gov, validate({ params: s.idParams, body: s.attendance }), controller.markAttendance);
router.delete('/:id/attendance/:membershipId', gov, validate({ params: s.memberParams }), controller.removeAttendance);

router.post('/:id/resolutions', gov, validate({ params: s.idParams, body: s.resolution }), controller.addResolution);
router.patch('/:id/resolutions/:resolutionId', gov, validate({ params: s.resolutionParams, body: s.updateResolution }), controller.updateResolution);
router.delete('/:id/resolutions/:resolutionId', gov, validate({ params: s.resolutionParams }), controller.removeResolution);

router.post('/:id/action-items', gov, validate({ params: s.idParams, body: s.actionItem }), controller.addActionItem);
// owners update their own items; the service checks
router.patch('/:id/action-items/:actionId', validate({ params: s.actionParams, body: s.updateActionItem }), controller.updateActionItem);
router.delete('/:id/action-items/:actionId', gov, validate({ params: s.actionParams }), controller.removeActionItem);

router.post('/:id/attachments', gov, validate({ params: s.idParams, body: s.attachments }), controller.addAttachments);
router.delete('/:id/attachments/:attachmentId', gov, validate({ params: s.attachmentParams }), controller.removeAttachment);

export default router;
