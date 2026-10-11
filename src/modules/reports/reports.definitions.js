import Membership from '../users/membership.model.js';
import Unit from '../units/unit.model.js';
import Visitor from '../visitors/visitor.model.js';
import Complaint from '../complaints/complaint.model.js';
import Bill from '../billing/bill.model.js';
import Payment from '../payments/payment.model.js';
import Booking from '../amenities/booking.model.js';
import AuditLog from '../audit/audit.model.js';
import HelpAttendance from '../dailyHelp/helpAttendance.model.js';
import { ROLES } from '../../common/constants/index.js';

const { ADMIN, ACCOUNTANT, FACILITY_MANAGER } = ROLES;
const OPS = [ADMIN, FACILITY_MANAGER];
const FIN = [ADMIN, ACCOUNTANT];
const ACTIVE_COMPLAINT = ['open', 'assigned', 'in_progress', 'on_hold', 'reopened'];
const BATCH = 500;

const hours = (from, to) => (from && to ? Math.round(((new Date(to) - new Date(from)) / 3600000) * 10) / 10 : null);
const range = (field, { from, to }) => (from || to ? { [field]: { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) } } : {});

async function* mapCursor(cursor, fn) {
  for await (const doc of cursor) yield fn(doc);
}

// Each report: who may run it, which filters it takes, its columns, and an async row generator.
// Every query is scoped to ctx.societyId. Rows stream from a Mongo cursor so large societies don't
// load everything into memory.
export const REPORTS = [
  {
    key: 'members',
    label: 'Members',
    description: 'Everyone with a role in the society, with contact details and unit.',
    roles: OPS,
    params: ['status'],
    columns: [
      { key: 'name', header: 'Name', width: 22 },
      { key: 'email', header: 'Email', width: 26 },
      { key: 'phone', header: 'Phone', width: 14 },
      { key: 'role', header: 'Role', width: 14 },
      { key: 'residentType', header: 'Resident type', width: 12 },
      { key: 'unit', header: 'Unit', width: 10 },
      { key: 'designation', header: 'Designation', width: 16 },
      { key: 'status', header: 'Status', width: 10 },
      { key: 'joinedAt', header: 'Joined', format: 'datetime', width: 18 },
    ],
    rows: (ctx, p) =>
      mapCursor(
        Membership.find({ society: ctx.societyId, ...(p.status ? { status: p.status } : {}) })
          .sort({ role: 1, createdAt: 1 })
          .populate('user', 'name email phone')
          .populate('unit', 'label')
          .lean()
          .cursor({ batchSize: BATCH }),
        (m) => ({ name: m.user?.name, email: m.user?.email, phone: m.user?.phone, role: m.role, residentType: m.residentType, unit: m.unit?.label, designation: m.designation, status: m.status, joinedAt: m.createdAt }),
      ),
  },
  {
    key: 'units',
    label: 'Units & occupancy',
    description: 'Every unit with area, occupancy and the number of active residents.',
    roles: OPS,
    params: [],
    columns: [
      { key: 'label', header: 'Unit', width: 10 },
      { key: 'floor', header: 'Floor', width: 7 },
      { key: 'type', header: 'Type', width: 9 },
      { key: 'areaSqft', header: 'Area (sq.ft)', width: 11 },
      { key: 'occupancy', header: 'Occupancy', width: 15 },
      { key: 'owners', header: 'Owners', width: 8 },
      { key: 'tenants', header: 'Tenants', width: 8 },
      { key: 'residents', header: 'Residents', width: 9 },
    ],
    async *rows(ctx) {
      const counts = await Membership.aggregate([
        { $match: { society: ctx.societyId, role: ROLES.RESIDENT, status: 'active', unit: { $ne: null } } },
        { $group: { _id: '$unit', residents: { $sum: 1 }, owners: { $sum: { $cond: [{ $eq: ['$residentType', 'owner'] }, 1, 0] } }, tenants: { $sum: { $cond: [{ $eq: ['$residentType', 'tenant'] }, 1, 0] } } } },
      ]);
      const byUnit = new Map(counts.map((c) => [String(c._id), c]));
      for await (const u of Unit.find({ society: ctx.societyId }).sort({ label: 1 }).lean().cursor({ batchSize: BATCH })) {
        const c = byUnit.get(String(u._id)) || {};
        yield { label: u.label, floor: u.floor, type: u.type, areaSqft: u.areaSqft, occupancy: u.occupancy, owners: c.owners || 0, tenants: c.tenants || 0, residents: c.residents || 0 };
      }
    },
  },
  {
    key: 'visitors',
    label: 'Visitors',
    description: 'Gate log for a date range.',
    roles: OPS,
    params: ['from', 'to'],
    columns: [
      { key: 'createdAt', header: 'Logged', format: 'datetime', width: 18 },
      { key: 'name', header: 'Visitor', width: 20 },
      { key: 'phone', header: 'Phone', width: 13 },
      { key: 'purpose', header: 'Purpose', width: 10 },
      { key: 'company', header: 'Company', width: 12 },
      { key: 'unit', header: 'Unit', width: 9 },
      { key: 'vehicleNumber', header: 'Vehicle', width: 12 },
      { key: 'status', header: 'Status', width: 11 },
      { key: 'checkInAt', header: 'In', format: 'datetime', width: 18 },
      { key: 'checkOutAt', header: 'Out', format: 'datetime', width: 18 },
    ],
    rows: (ctx, p) =>
      mapCursor(
        Visitor.find({ society: ctx.societyId, ...range('createdAt', p) }).sort({ createdAt: -1 }).populate('unit', 'label').lean().cursor({ batchSize: BATCH }),
        (v) => ({ ...v, unit: v.unit?.label }),
      ),
  },
  {
    key: 'complaints',
    label: 'Complaints & SLA',
    description: 'Helpdesk tickets raised in a date range, with SLA outcome and resolution time.',
    roles: OPS,
    params: ['from', 'to', 'status'],
    columns: [
      { key: 'ticketNumber', header: 'Ticket', width: 12 },
      { key: 'createdAt', header: 'Raised', format: 'datetime', width: 18 },
      { key: 'unit', header: 'Unit', width: 9 },
      { key: 'category', header: 'Category', width: 11 },
      { key: 'priority', header: 'Priority', width: 9 },
      { key: 'title', header: 'Title', width: 28 },
      { key: 'status', header: 'Status', width: 11 },
      { key: 'assignedTo', header: 'Assigned to', width: 16 },
      { key: 'slaDueAt', header: 'SLA due', format: 'datetime', width: 18 },
      { key: 'sla', header: 'SLA', width: 10 },
      { key: 'resolutionHours', header: 'Hours to resolve', width: 10 },
      { key: 'rating', header: 'Rating', width: 7 },
    ],
    rows: (ctx, p) =>
      mapCursor(
        Complaint.find({ society: ctx.societyId, ...range('createdAt', p), ...(p.status ? { status: p.status } : {}) })
          .select('-comments -history')
          .sort({ createdAt: -1 })
          .populate('unit', 'label')
          .populate('assignedTo', 'name')
          .lean()
          .cursor({ batchSize: BATCH }),
        (c) => {
          const doneAt = c.resolvedAt || c.closedAt;
          let sla = '';
          if (c.slaDueAt) {
            if (doneAt) sla = doneAt <= c.slaDueAt ? 'Met' : 'Breached';
            else sla = ACTIVE_COMPLAINT.includes(c.status) && c.slaDueAt < new Date() ? 'Breached' : 'Open';
          }
          return { ...c, unit: c.unit?.label, assignedTo: c.assignedTo?.name, sla, resolutionHours: hours(c.createdAt, doneAt) };
        },
      ),
  },
  {
    key: 'bills',
    label: 'Bills',
    description: 'Maintenance bills, optionally for one month.',
    roles: FIN,
    params: ['period', 'status'],
    columns: [
      { key: 'billNumber', header: 'Bill', width: 16 },
      { key: 'period', header: 'Month', width: 9 },
      { key: 'unit', header: 'Unit', width: 9 },
      { key: 'amount', header: 'Amount', format: 'money', width: 11 },
      { key: 'lateFee', header: 'Late fee', format: 'money', width: 10 },
      { key: 'total', header: 'Total', format: 'money', width: 11 },
      { key: 'paid', header: 'Paid', format: 'money', width: 11 },
      { key: 'balance', header: 'Balance', format: 'money', width: 11 },
      { key: 'dueDate', header: 'Due', format: 'date', width: 11 },
      { key: 'status', header: 'Status', width: 9 },
    ],
    rows: (ctx, p) =>
      mapCursor(
        Bill.find({ society: ctx.societyId, ...(p.period ? { period: p.period } : {}), ...(p.status ? { status: p.status } : {}) })
          .sort({ period: -1, billNumber: 1 })
          .populate('unit', 'label')
          .lean()
          .cursor({ batchSize: BATCH }),
        (b) => ({ ...b, unit: b.unit?.label, balance: Math.max(0, b.total - b.paid) }),
      ),
  },
  {
    key: 'payments',
    label: 'Payments & collections',
    description: 'Successful payments received in a date range.',
    roles: FIN,
    params: ['from', 'to'],
    columns: [
      { key: 'receiptNumber', header: 'Receipt', width: 12 },
      { key: 'paidAt', header: 'Paid on', format: 'datetime', width: 18 },
      { key: 'unit', header: 'Unit', width: 9 },
      { key: 'bill', header: 'Bill', width: 16 },
      { key: 'period', header: 'Month', width: 9 },
      { key: 'amount', header: 'Amount', format: 'money', width: 11 },
      { key: 'method', header: 'Method', width: 9 },
      { key: 'reference', header: 'Reference', width: 16 },
    ],
    rows: (ctx, p) =>
      mapCursor(
        Payment.find({ society: ctx.societyId, status: 'success', ...range('paidAt', p) })
          .sort({ paidAt: -1 })
          .populate('unit', 'label')
          .populate('bill', 'billNumber period')
          .lean()
          .cursor({ batchSize: BATCH }),
        (x) => ({ ...x, unit: x.unit?.label, bill: x.bill?.billNumber, period: x.bill?.period }),
      ),
  },
  {
    key: 'defaulters',
    label: 'Defaulters',
    description: 'Units with overdue dues, oldest first.',
    roles: FIN,
    params: [],
    columns: [
      { key: 'unit', header: 'Unit', width: 9 },
      { key: 'residents', header: 'Residents', width: 26 },
      { key: 'bills', header: 'Overdue bills', width: 10 },
      { key: 'outstanding', header: 'Outstanding', format: 'money', width: 12 },
      { key: 'oldestDue', header: 'Oldest due', format: 'date', width: 11 },
      { key: 'daysOverdue', header: 'Days overdue', width: 10 },
    ],
    async *rows(ctx) {
      const now = new Date();
      const groups = await Bill.aggregate([
        { $match: { society: ctx.societyId, status: { $in: ['unpaid', 'partial'] }, dueDate: { $lt: now } } },
        { $group: { _id: '$unit', bills: { $sum: 1 }, outstanding: { $sum: { $subtract: ['$total', '$paid'] } }, oldestDue: { $min: '$dueDate' } } },
        { $sort: { oldestDue: 1 } },
        { $limit: 20000 },
      ]);
      const ids = groups.map((g) => g._id);
      const [units, members] = await Promise.all([
        Unit.find({ _id: { $in: ids }, society: ctx.societyId }).select('label').lean(),
        Membership.find({ society: ctx.societyId, unit: { $in: ids }, role: ROLES.RESIDENT, status: 'active' }).populate('user', 'name').select('unit user').lean(),
      ]);
      const label = new Map(units.map((u) => [String(u._id), u.label]));
      const names = new Map();
      for (const m of members) names.set(String(m.unit), [...(names.get(String(m.unit)) || []), m.user?.name].filter(Boolean));
      for (const g of groups) {
        yield { unit: label.get(String(g._id)), residents: names.get(String(g._id)) || [], bills: g.bills, outstanding: g.outstanding, oldestDue: g.oldestDue, daysOverdue: Math.floor((now - g.oldestDue) / 86400000) };
      }
    },
  },
  {
    key: 'bookings',
    label: 'Amenity bookings',
    description: 'Bookings for dates in a range.',
    roles: OPS,
    params: ['from', 'to', 'status'],
    columns: [
      { key: 'date', header: 'Date', width: 11 },
      { key: 'startTime', header: 'From', width: 7 },
      { key: 'endTime', header: 'To', width: 7 },
      { key: 'amenity', header: 'Amenity', width: 18 },
      { key: 'unit', header: 'Unit', width: 9 },
      { key: 'user', header: 'Booked by', width: 18 },
      { key: 'guests', header: 'Guests', width: 7 },
      { key: 'fee', header: 'Fee', format: 'money', width: 10 },
      { key: 'status', header: 'Status', width: 10 },
    ],
    rows: (ctx, p) => {
      const filter = { society: ctx.societyId, ...(p.status ? { status: p.status } : {}) };
      if (p.fromDate || p.toDate) filter.date = { ...(p.fromDate ? { $gte: p.fromDate } : {}), ...(p.toDate ? { $lte: p.toDate } : {}) };
      return mapCursor(
        Booking.find(filter).sort({ date: -1, startTime: 1 }).populate('amenity', 'name').populate('unit', 'label').populate('user', 'name').lean().cursor({ batchSize: BATCH }),
        (b) => ({ ...b, amenity: b.amenity?.name, unit: b.unit?.label, user: b.user?.name }),
      );
    },
  },
  {
    key: 'audit',
    label: 'Audit log',
    description: 'Admin and financial actions in a date range.',
    roles: [ADMIN],
    params: ['from', 'to'],
    columns: [
      { key: 'createdAt', header: 'When', format: 'datetime', width: 18 },
      { key: 'actor', header: 'By', width: 18 },
      { key: 'action', header: 'Action', width: 26 },
      { key: 'entity', header: 'Entity', width: 14 },
      { key: 'entityId', header: 'Entity id', width: 24 },
      { key: 'ip', header: 'IP', width: 14 },
    ],
    rows: (ctx, p) =>
      mapCursor(
        AuditLog.find({ society: ctx.societyId, ...range('createdAt', p) }).sort({ createdAt: -1 }).populate('actor', 'name').lean().cursor({ batchSize: BATCH }),
        (a) => ({ ...a, actor: a.actor?.name || 'System', entityId: a.entityId ? String(a.entityId) : '' }),
      ),
  },
  {
    key: 'attendance',
    label: 'Daily-help attendance',
    description: 'Gate check-ins and check-outs of maids, drivers and other daily help.',
    roles: OPS,
    params: ['from', 'to'],
    columns: [
      { key: 'name', header: 'Name', width: 20 },
      { key: 'type', header: 'Type', width: 10 },
      { key: 'inAt', header: 'In', format: 'datetime', width: 18 },
      { key: 'outAt', header: 'Out', format: 'datetime', width: 18 },
      { key: 'hours', header: 'Hours', width: 7 },
    ],
    rows: (ctx, p) =>
      mapCursor(
        HelpAttendance.find({ society: ctx.societyId, ...range('inAt', p) }).sort({ inAt: -1 }).populate('help', 'name type').lean().cursor({ batchSize: BATCH }),
        (a) => ({ name: a.help?.name, type: a.help?.type, inAt: a.inAt, outAt: a.outAt, hours: hours(a.inAt, a.outAt) }),
      ),
  },
];

export const REPORT_KEYS = REPORTS.map((r) => r.key);
export const reportByKey = (key) => REPORTS.find((r) => r.key === key);
