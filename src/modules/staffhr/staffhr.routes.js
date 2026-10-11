import { Router } from 'express';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { authenticateDevice } from '../../common/middleware/device.js';
import { validate } from '../../common/middleware/validate.js';
import { pageQuery } from '../../common/utils/schemas.js';
import { ROLES } from '../../common/constants/index.js';
import * as c from './staffhr.controller.js';
import * as schema from './staffhr.validation.js';

const { FACILITY_MANAGER: FM, ACCOUNTANT: ACC, STAFF, GUARD } = ROLES;
const EMPLOYEES = [FM, ACC, STAFF, GUARD]; // anyone who can hold an employee profile (admin always passes)
const id = { params: schema.idParams };

const router = Router();

// Biometric / RFID attendance terminals authenticate with a device key, not a user session.
router.post('/device-punches', authenticateDevice('attendance:write'), validate({ body: schema.devicePunches }), c.devicePunches);

router.use(authenticate, requireSociety);

router.get('/settings', authorize(FM), c.getSettings);
router.patch('/settings', authorize(FM), validate({ body: schema.updateSettings }), c.updateSettings);

// employees
router.get('/employees', authorize(FM, ACC), validate({ query: schema.listEmployees }), c.listEmployees);
router.get('/employees/candidates', authorize(FM), c.candidates);
router.get('/employees/me', authorize(...EMPLOYEES), c.myEmployee);
router.post('/employees', authorize(FM), validate({ body: schema.createEmployee }), c.createEmployee);
router.get('/employees/:id', authorize(FM, ACC), validate(id), c.getEmployee);
router.patch('/employees/:id', authorize(FM), validate({ ...id, body: schema.updateEmployee }), c.updateEmployee);
router.post('/employees/:id/documents/remove', authorize(FM), validate({ ...id, body: schema.removeDocument }), c.removeEmployeeDocument);
router.get('/employees/:id/bank', authorize(ACC), validate(id), c.bankDetails);

// shifts & roster
router.get('/shifts', authorize(...EMPLOYEES), c.listShifts);
router.post('/shifts', authorize(FM), validate({ body: schema.createShift }), c.createShift);
router.patch('/shifts/:id', authorize(FM), validate({ ...id, body: schema.updateShift }), c.updateShift);
router.get('/roster', authorize(FM), validate({ query: schema.rosterQuery }), c.getRoster);
router.put('/roster', authorize(FM), validate({ body: schema.saveRoster }), c.saveRoster);

// attendance
router.post('/attendance/check-in', authorize(...EMPLOYEES), validate({ body: schema.punch }), c.checkIn);
router.post('/attendance/check-out', authorize(...EMPLOYEES), validate({ body: schema.punch }), c.checkOut);
router.get('/attendance/today', authorize(...EMPLOYEES), c.myToday);
router.get('/attendance/me', authorize(...EMPLOYEES), validate({ query: schema.myAttendanceQuery }), c.myAttendance);
router.post('/attendance/mark', authorize(FM), validate({ body: schema.markAttendance }), c.markAttendance);
router.get('/attendance', authorize(FM), validate({ query: schema.listAttendance }), c.listAttendance);
router.get('/attendance/day', authorize(FM), validate({ query: schema.listAttendance.pick({ date: true }) }), c.daySheet);
router.get('/attendance/register', authorize(FM, ACC), validate({ query: schema.registerQuery }), c.register);
router.get('/attendance/register/export', authorize(FM, ACC), validate({ query: schema.registerQuery }), c.registerXlsx);

// leave
router.get('/leaves', authorize(...EMPLOYEES), validate({ query: schema.listLeaves }), c.listLeaves);
router.post('/leaves', authorize(...EMPLOYEES), validate({ body: schema.applyLeave }), c.applyLeave);
router.get('/leaves/calendar', authorize(...EMPLOYEES), validate({ query: schema.leaveCalendar }), c.leaveCalendar);
router.get('/leaves/balances', authorize(...EMPLOYEES), validate({ query: schema.balanceQuery }), c.leaveBalances);
router.put('/leaves/balances', authorize(FM), validate({ body: schema.setBalance }), c.setLeaveBalance);
router.post('/leaves/:id/decide', authorize(FM), validate({ ...id, body: schema.decideLeave }), c.decideLeave);
router.post('/leaves/:id/cancel', authorize(...EMPLOYEES), validate(id), c.cancelLeave);

// salary advances
router.get('/advances', authorize(FM, ACC), validate({ query: schema.listAdvances }), c.listAdvances);
router.post('/advances', authorize(FM), validate({ body: schema.createAdvance }), c.createAdvance);

// payroll (accountants view and pay; managers prepare and approve)
router.get('/payroll-runs', authorize(FM, ACC), validate({ query: pageQuery }), c.listRuns);
router.post('/payroll-runs', authorize(FM), validate({ body: schema.createRun }), c.createRun);
router.get('/payroll-runs/:id', authorize(FM, ACC), validate(id), c.getRun);
router.get('/payroll-runs/:id/export', authorize(FM, ACC), validate(id), c.runXlsx);
router.post('/payroll-runs/:id/recompute', authorize(FM), validate(id), c.recomputeRun);
router.post('/payroll-runs/:id/approve', authorize(FM), validate(id), c.approveRun);
router.post('/payroll-runs/:id/pay', authorize(FM, ACC), validate({ ...id, body: schema.payRun }), c.payRun);
router.delete('/payroll-runs/:id', authorize(FM), validate(id), c.discardRun);

router.get('/payslips', authorize(...EMPLOYEES), validate({ query: schema.listPayslips }), c.listPayslips);
router.get('/payslips/:id', authorize(...EMPLOYEES), validate(id), c.getPayslip);
router.get('/payslips/:id/pdf', authorize(...EMPLOYEES), validate(id), c.payslipPdf);
router.patch('/payslips/:id/adjustments', authorize(FM), validate({ ...id, body: schema.adjustPayslip }), c.adjustPayslip);
router.post('/payslips/:id/pay', authorize(FM, ACC), validate({ ...id, body: schema.payPayslip }), c.payPayslip);

export default router;
