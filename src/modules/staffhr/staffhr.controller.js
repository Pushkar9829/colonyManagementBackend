import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import { sendFile, sendXlsx } from '../assets/facility.shared.js';
import * as employees from './employees.service.js';
import * as attendance from './attendance.service.js';
import * as leave from './leave.service.js';
import * as payroll from './payroll.service.js';

const paged = (fn) =>
  asyncHandler(async (req, res) => {
    const q = query(req);
    const { items, meta } = await fn(ctx(req), q, getPagination(q), req);
    ok(res, items, meta);
  });
const one = (fn, make = ok) => asyncHandler(async (req, res) => make(res, await fn(ctx(req), req)));

// settings
export const getSettings = one((c) => employees.getSettings(c));
export const updateSettings = one((c, req) => employees.updateSettings(c, req.body));

// employees
export const listEmployees = paged((c, q, p) => employees.list(c, q, p));
export const candidates = one((c) => employees.candidates(c));
export const createEmployee = one((c, req) => employees.create(c, req.body), created);
export const myEmployee = one((c) => employees.findMine(c));
export const getEmployee = one((c, req) => employees.getById(c, req.params.id));
export const updateEmployee = one((c, req) => employees.update(c, req.params.id, req.body));
export const removeEmployeeDocument = one((c, req) => employees.removeDocument(c, req.params.id, req.body.url));
export const bankDetails = one((c, req) => employees.bankDetails(c, req.params.id));

// shifts & roster
export const listShifts = one((c) => employees.listShifts(c));
export const createShift = one((c, req) => employees.createShift(c, req.body), created);
export const updateShift = one((c, req) => employees.updateShift(c, req.params.id, req.body));
export const getRoster = one((c, req) => attendance.getRoster(c, query(req)));
export const saveRoster = one((c, req) => attendance.saveRoster(c, req.body));

// attendance
export const checkIn = one((c, req) => attendance.checkIn(c, req.body), created);
export const checkOut = one((c, req) => attendance.checkOut(c, req.body));
export const myToday = one((c) => attendance.myToday(c));
export const myAttendance = one((c, req) => attendance.myAttendance(c, query(req)));
export const markAttendance = one((c, req) => attendance.markManual(c, req.body));
export const listAttendance = paged((c, q, p) => attendance.list(c, q, p));
export const daySheet = one((c, req) => attendance.daySheet(c, query(req).date));
export const register = one((c, req) => attendance.register(c, query(req)));
export const registerXlsx = asyncHandler(async (req, res) => {
  const q = query(req);
  sendXlsx(res, await attendance.registerXlsx(ctx(req), q), `attendance-${q.period}.xlsx`);
});
export const devicePunches = asyncHandler(async (req, res) => ok(res, await attendance.devicePunches(ctx(req), req.body, req.device)));

// leave
export const applyLeave = one((c, req) => leave.apply(c, req.body), created);
export const listLeaves = paged((c, q, p) => leave.list(c, q, p));
export const decideLeave = one((c, req) => leave.decide(c, req.params.id, req.body));
export const cancelLeave = one((c, req) => leave.cancel(c, req.params.id));
export const leaveCalendar = one((c, req) => leave.calendar(c, query(req)));
export const leaveBalances = one((c, req) => leave.myBalances(c, query(req)));
export const setLeaveBalance = one((c, req) => leave.setBalance(c, req.body));

// advances
export const listAdvances = one((c, req) => payroll.listAdvances(c, query(req)));
export const createAdvance = one((c, req) => payroll.createAdvance(c, req.body), created);

// payroll
export const listRuns = paged((c, q, p) => payroll.listRuns(c, p));
export const createRun = one((c, req) => payroll.createRun(c, req.body), created);
export const getRun = one((c, req) => payroll.getRun(c, req.params.id));
export const recomputeRun = one((c, req) => payroll.recompute(c, req.params.id));
export const approveRun = one((c, req) => payroll.approve(c, req.params.id));
export const payRun = one((c, req) => payroll.payRun(c, req.params.id, req.body));
export const discardRun = asyncHandler(async (req, res) => {
  await payroll.discard(ctx(req), req.params.id);
  noContent(res);
});
export const runXlsx = asyncHandler(async (req, res) => {
  const { filename, buffer } = await payroll.runXlsx(ctx(req), req.params.id);
  sendXlsx(res, buffer, filename);
});
export const listPayslips = paged((c, q, p) => payroll.listPayslips(c, q, p));
export const getPayslip = one((c, req) => payroll.getPayslip(c, req.params.id));
export const adjustPayslip = one((c, req) => payroll.adjustPayslip(c, req.params.id, req.body));
export const payPayslip = one((c, req) => payroll.pay(c, req.params.id, req.body));
export const payslipPdf = asyncHandler(async (req, res) => {
  const { filename, buffer } = await payroll.payslipPdf(ctx(req), req.params.id);
  sendFile(res, buffer, filename, 'application/pdf');
});
