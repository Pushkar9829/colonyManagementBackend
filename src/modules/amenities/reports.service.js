import mongoose from 'mongoose';
import ExcelJS from 'exceljs';
import Amenity from './amenity.model.js';
import Booking from './booking.model.js';
import AmenityPass from './amenityPass.model.js';
import AmenityPayment from './amenityPayment.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { localDateString, toMinutes } from '../../common/utils/dates.js';

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const daysInclusive = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;

// Default range: this month so far.
function range({ from, to }) {
  const today = localDateString();
  const f = from || `${today.slice(0, 7)}-01`;
  const t = to || today;
  if (t < f) throw ApiError.badRequest('"to" must be on or after "from"');
  if (daysInclusive(f, t) > 366) throw ApiError.badRequest('Pick a range of at most one year');
  return { from: f, to: t, days: daysInclusive(f, t) };
}

// Per amenity: bookings, cancellations, no-shows, utilisation (booked slot-minutes / open slot-minutes
// × capacity) and money: net fees by booking date, pass sales by payment date, deposits still held.
export async function usage(ctx, filters) {
  const { from, to, days } = range(filters);
  const amenityFilter = { society: ctx.societyId };
  if (filters.amenity) amenityFilter._id = filters.amenity;
  const amenities = await Amenity.find(amenityFilter).sort({ name: 1 }).lean();
  const ids = amenities.map((a) => a._id);
  const society = oid(ctx.societyId);

  const [bookingRows, feeRows, depositRows, passRows] = await Promise.all([
    Booking.find({ society, amenity: { $in: ids }, date: { $gte: from, $lte: to } }).select('amenity status startTime endTime attendance').lean(),
    AmenityPayment.aggregate([
      { $match: { society, kind: 'fee', booking: { $ne: null }, amenity: { $in: ids }, status: { $in: ['success', 'refunded'] } } },
      { $lookup: { from: 'bookings', localField: 'booking', foreignField: '_id', as: 'b', pipeline: [{ $project: { date: 1 } }] } },
      { $unwind: '$b' },
      { $match: { 'b.date': { $gte: from, $lte: to } } },
      { $group: { _id: '$amenity', gross: { $sum: '$amount' }, refunded: { $sum: '$refundedAmount' } } },
    ]),
    AmenityPayment.aggregate([
      { $match: { society, kind: 'deposit', amenity: { $in: ids }, status: { $in: ['success', 'refunded'] } } },
      { $group: { _id: '$amenity', held: { $sum: { $subtract: ['$amount', '$refundedAmount'] } } } },
    ]),
    AmenityPayment.aggregate([
      {
        $match: {
          society,
          kind: 'fee',
          pass: { $ne: null },
          amenity: { $in: ids },
          status: { $in: ['success', 'refunded'] },
          paidAt: { $gte: new Date(`${from}T00:00:00+05:30`), $lt: new Date(Date.parse(`${to}T00:00:00+05:30`) + 86400000) },
        },
      },
      { $group: { _id: '$amenity', sales: { $sum: { $subtract: ['$amount', '$refundedAmount'] } }, count: { $sum: 1 } } },
    ]),
  ]);
  const activePasses = await AmenityPass.aggregate([
    { $match: { society, amenity: { $in: ids }, status: 'active', validTo: { $gte: localDateString() } } },
    { $group: { _id: '$amenity', n: { $sum: 1 } } },
  ]);
  const byId = (rows) => new Map(rows.map((r) => [String(r._id), r]));
  const [fees, deposits, passes, active] = [byId(feeRows), byId(depositRows), byId(passRows), byId(activePasses)];

  const rows = amenities.map((a) => {
    const mine = bookingRows.filter((b) => String(b.amenity) === String(a._id));
    const confirmed = mine.filter((b) => b.status === 'confirmed');
    const bookedMinutes = confirmed.reduce((s, b) => s + (toMinutes(b.endTime) - toMinutes(b.startTime)), 0);
    const openMinutes = Math.max(0, toMinutes(a.closeTime) - toMinutes(a.openTime)) * (a.capacity || 1) * days;
    const fee = fees.get(String(a._id));
    const noShows = confirmed.filter((b) => b.attendance === 'no_show').length;
    return {
      amenity: { _id: a._id, name: a.name, capacity: a.capacity },
      requests: mine.length,
      bookings: confirmed.length,
      cancelled: mine.filter((b) => b.status === 'cancelled').length,
      rejected: mine.filter((b) => b.status === 'rejected').length,
      attended: confirmed.filter((b) => b.attendance === 'attended').length,
      noShows,
      noShowPercent: confirmed.length ? Math.round((noShows / confirmed.length) * 1000) / 10 : 0,
      bookedHours: Math.round((bookedMinutes / 60) * 10) / 10,
      utilisationPercent: openMinutes ? Math.round((bookedMinutes / openMinutes) * 1000) / 10 : 0,
      feeRevenue: fee ? fee.gross - fee.refunded : 0,
      feeRefunded: fee?.refunded || 0,
      passSales: passes.get(String(a._id))?.sales || 0,
      passesSold: passes.get(String(a._id))?.count || 0,
      activePasses: active.get(String(a._id))?.n || 0,
      depositsHeld: deposits.get(String(a._id))?.held || 0,
    };
  });
  const totals = rows.reduce(
    (t, r) => ({
      bookings: t.bookings + r.bookings,
      cancelled: t.cancelled + r.cancelled,
      noShows: t.noShows + r.noShows,
      revenue: t.revenue + r.feeRevenue + r.passSales,
      depositsHeld: t.depositsHeld + r.depositsHeld,
    }),
    { bookings: 0, cancelled: 0, noShows: 0, revenue: 0, depositsHeld: 0 },
  );
  return { from, to, days, rows, totals };
}

const rupees = (p) => Math.round(p) / 100;

export async function usageWorkbook(ctx, filters) {
  const report = await usage(ctx, filters);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ColonyHub';
  const ws = wb.addWorksheet('Amenity usage');
  ws.addRow([`Amenity usage & revenue ${report.from} to ${report.to}`]).font = { bold: true, size: 13 };
  ws.addRow([]);
  const header = ws.addRow([
    'Amenity', 'Requests', 'Confirmed', 'Cancelled', 'Rejected', 'Attended', 'No-shows', 'No-show %',
    'Booked hours', 'Utilisation %', 'Fee revenue (₹)', 'Fees refunded (₹)', 'Passes sold', 'Pass sales (₹)', 'Active passes', 'Deposits held (₹)',
  ]);
  header.font = { bold: true };
  for (const r of report.rows) {
    ws.addRow([
      r.amenity.name, r.requests, r.bookings, r.cancelled, r.rejected, r.attended, r.noShows, r.noShowPercent,
      r.bookedHours, r.utilisationPercent, rupees(r.feeRevenue), rupees(r.feeRefunded), r.passesSold, rupees(r.passSales), r.activePasses, rupees(r.depositsHeld),
    ]);
  }
  const t = report.totals;
  ws.addRow(['Total', '', t.bookings, t.cancelled, '', '', t.noShows, '', '', '', '', '', '', '', '', rupees(t.depositsHeld)]).font = { bold: true };
  ws.addRow(['Total revenue (₹)', rupees(t.revenue)]).font = { bold: true };
  ws.columns.forEach((c, i) => {
    c.width = i === 0 ? 24 : 14;
  });
  return { buffer: await wb.xlsx.writeBuffer(), filename: `amenity-usage-${report.from}-to-${report.to}.xlsx` };
}
