import UtilityPoint, { DEFAULT_PARAMETERS } from './utilityPoint.model.js';
import UtilityReading from './utilityReading.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { ROLES } from '../../common/constants/index.js';
import * as audit from '../audit/audit.service.js';
import * as assets from '../assets/assets.service.js';
import { notifyRoles } from '../notifications/notifications.service.js';
import { addDaysStr, round3, today, workbookBuffer } from '../assets/facility.shared.js';
import { toMinutes } from '../../common/utils/dates.js';

const MANAGERS = [ROLES.ADMIN, ROLES.FACILITY_MANAGER];
const KIND_LABEL = { dg: 'DG set', tank: 'Water tank', stp: 'STP', wtp: 'WTP', meter: 'Electricity meter', pump: 'Pump' };

// ---- points ----
export async function createPoint(ctx, { openingDieselStock, openingHours, openingMeterReading, ...data }) {
  if (data.asset) await assets.findForSociety(ctx, data.asset);
  const parameters = data.parameters?.length ? data.parameters : DEFAULT_PARAMETERS[data.kind] || [];
  const point = await UtilityPoint.create({
    ...data,
    parameters: ['stp', 'wtp'].includes(data.kind) ? parameters : [],
    society: ctx.societyId,
    dieselStock: data.kind === 'dg' ? openingDieselStock || 0 : 0,
    lastHours: openingHours,
    lastMeterReading: openingMeterReading,
  });
  audit.record(ctx, 'utility.point_created', 'UtilityPoint', point._id, { kind: point.kind, name: point.name });
  return point.toObject();
}

export function listPoints(ctx, { kind, active }) {
  const filter = { society: ctx.societyId };
  if (kind) filter.kind = kind;
  if (active !== undefined) filter.active = active;
  return UtilityPoint.find(filter).sort({ kind: 1, name: 1 }).populate({ path: 'asset', select: 'name code' }).lean();
}

export async function updatePoint(ctx, id, data) {
  if (data.asset) await assets.findForSociety(ctx, data.asset);
  const point = await UtilityPoint.findOneAndUpdate({ _id: id, society: ctx.societyId }, { $set: data }, { returnDocument: 'after', runValidators: true }).lean();
  if (!point) throw ApiError.notFound('Log point not found');
  return point;
}

// ---- readings ----
const minutesBetween = (start, end) => {
  const diff = toMinutes(end) - toMinutes(start);
  return diff >= 0 ? diff : diff + 24 * 60; // ran past midnight
};

function hourMeter(point, data) {
  let { hoursStart, hoursEnd, runHours } = data;
  if (hoursEnd !== undefined && hoursStart === undefined && point.lastHours !== undefined && point.lastHours !== null) hoursStart = point.lastHours;
  if (hoursEnd !== undefined && hoursStart !== undefined) {
    if (hoursEnd < hoursStart) throw ApiError.badRequest('Closing hours ({closing}) cannot be below opening hours ({opening})', { params: { closing: hoursEnd, opening: hoursStart } });
    runHours = round3(hoursEnd - hoursStart);
  }
  return { hoursStart, hoursEnd, runHours };
}

export async function createReading(ctx, data) {
  const point = await UtilityPoint.findOne({ _id: data.point, society: ctx.societyId, active: true }).lean();
  if (!point) throw ApiError.notFound('Log point not found');
  const base = { society: ctx.societyId, point: point._id, kind: point.kind, date: data.date || today(), shift: data.shift, notes: data.notes, recordedBy: ctx.userId, at: new Date() };
  if (base.date > today()) throw ApiError.badRequest('Readings cannot be dated in the future');
  const pointUpdate = { lastReadingAt: base.at };
  let reading;
  let alert = null;

  switch (point.kind) {
    case 'dg': {
      const hm = hourMeter(point, data);
      const filled = round3(data.dieselFilled || 0);
      const consumed = round3(data.dieselConsumed || 0);
      if (hm.runHours === undefined && !filled && !consumed) throw ApiError.badRequest('Enter run hours or a diesel fill / consumption');
      // Stock can never go negative, checked in the same atomic update.
      const updated = await UtilityPoint.findOneAndUpdate(
        { _id: point._id, $expr: { $gte: [{ $add: ['$dieselStock', filled - consumed] }, 0] } },
        [{ $set: { dieselStock: { $round: [{ $add: ['$dieselStock', filled - consumed] }, 3] }, lastReadingAt: base.at, ...(hm.hoursEnd !== undefined && { lastHours: hm.hoursEnd }) } }],
        { returnDocument: 'after', updatePipeline: true },
      ).lean();
      if (!updated) throw ApiError.conflict('Consumption is more than the {stock} L in stock', { params: { stock: point.dieselStock } });
      reading = await UtilityReading.create({ ...base, ...hm, dieselFilled: filled || undefined, dieselConsumed: consumed || undefined, dieselCost: data.dieselCost, dieselStock: updated.dieselStock });
      if (point.capacity && updated.dieselStock < point.capacity * 0.2) alert = { title: `Low diesel: ${point.name}`, body: `${updated.dieselStock} L left of ${point.capacity} L` };
      return finish(ctx, reading, alert);
    }
    case 'pump': {
      const hm = hourMeter(point, data);
      let runMinutes = data.runMinutes;
      if (runMinutes === undefined && data.startTime && data.endTime) runMinutes = minutesBetween(data.startTime, data.endTime);
      if (runMinutes === undefined && hm.runHours !== undefined) runMinutes = Math.round(hm.runHours * 60);
      if (runMinutes === undefined) throw ApiError.badRequest('Enter start / end time, run minutes or hour-meter readings');
      reading = await UtilityReading.create({ ...base, ...hm, runMinutes });
      if (hm.hoursEnd !== undefined) pointUpdate.lastHours = hm.hoursEnd;
      break;
    }
    case 'tank': {
      let { levelPercent, levelLitres } = data;
      if (levelPercent === undefined && levelLitres !== undefined) {
        if (!point.capacity) throw ApiError.badRequest('Set the tank capacity to log litres, or enter a percentage');
        levelPercent = Math.min(100, round3((levelLitres / point.capacity) * 100));
      }
      if (levelPercent === undefined) throw ApiError.badRequest('Enter the tank level');
      if (levelLitres === undefined && point.capacity) levelLitres = Math.round((levelPercent / 100) * point.capacity);
      reading = await UtilityReading.create({ ...base, levelPercent, levelLitres });
      if (levelPercent < 20) alert = { title: `Low water: ${point.name}`, body: `Tank at ${levelPercent}%` };
      break;
    }
    case 'stp':
    case 'wtp': {
      const params = new Map(point.parameters.map((p) => [p.key, p]));
      if (!data.values?.length) throw ApiError.badRequest('Enter at least one parameter');
      const values = data.values.map(({ key, value }) => {
        const p = params.get(key);
        if (!p) throw ApiError.badRequest('Unknown parameter "{parameter}" for {point}', { params: { parameter: key, point: point.name } });
        const outOfRange = (p.min !== undefined && p.min !== null && value < p.min) || (p.max !== undefined && p.max !== null && value > p.max);
        return { key, label: p.label, unit: p.unit, value, outOfRange };
      });
      const bad = values.filter((v) => v.outOfRange);
      reading = await UtilityReading.create({ ...base, values, outOfRange: bad.length > 0 });
      if (bad.length) alert = { title: `${KIND_LABEL[point.kind]} out of range: ${point.name}`, body: bad.map((v) => `${v.label} ${v.value}${v.unit ? ` ${v.unit}` : ''}`).join(', ') };
      break;
    }
    case 'meter': {
      if (data.meterReading === undefined) throw ApiError.badRequest('Enter the meter reading');
      const last = point.lastMeterReading;
      const hasLast = last !== undefined && last !== null && !data.meterReset;
      if (hasLast && data.meterReading < last) throw ApiError.badRequest('Reading {reading} is below the previous {previous}. Tick "meter reset" if the meter was replaced.', { params: { reading: data.meterReading, previous: last } });
      reading = await UtilityReading.create({ ...base, meterReading: data.meterReading, consumption: hasLast ? round3(data.meterReading - last) : undefined });
      pointUpdate.lastMeterReading = data.meterReading;
      break;
    }
    default:
      throw ApiError.badRequest('Unsupported log point');
  }
  await UtilityPoint.updateOne({ _id: point._id }, pointUpdate);
  return finish(ctx, reading, alert);
}

async function finish(ctx, reading, alert) {
  if (alert) await notifyRoles(ctx.societyId, MANAGERS, { type: 'facility', ...alert, link: `/utility-logs?kind=${reading.kind}` });
  return UtilityReading.findById(reading._id).populate([{ path: 'point', select: 'name kind' }, { path: 'recordedBy', select: 'name' }]).lean();
}

function readingFilter(ctx, { kind, point, from, to }) {
  const filter = { society: ctx.societyId };
  if (kind) filter.kind = kind;
  if (point) filter.point = point;
  if (from || to) filter.date = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  return filter;
}

export const listReadings = (ctx, filters, pagination) =>
  paginate(UtilityReading, readingFilter(ctx, filters), pagination, { sort: { at: -1 }, populate: [{ path: 'point', select: 'name kind' }, { path: 'recordedBy', select: 'name' }] });

// Daily or monthly roll-up per log point (default: last 30 days).
export async function summary(ctx, { kind, point, groupBy = 'day', from, to }) {
  const end = to || today();
  const start = from || addDaysStr(end, groupBy === 'month' ? -364 : -29);
  const match = readingFilter(ctx, { kind, point, from: start, to: end });
  const period = groupBy === 'month' ? { $substrBytes: ['$date', 0, 7] } : '$date';
  const rows = await UtilityReading.aggregate([
    { $match: match },
    { $sort: { at: 1 } },
    {
      $group: {
        _id: { point: '$point', period },
        readings: { $sum: 1 },
        runHours: { $sum: { $ifNull: ['$runHours', 0] } },
        runMinutes: { $sum: { $ifNull: ['$runMinutes', 0] } },
        dieselFilled: { $sum: { $ifNull: ['$dieselFilled', 0] } },
        dieselConsumed: { $sum: { $ifNull: ['$dieselConsumed', 0] } },
        dieselCost: { $sum: { $ifNull: ['$dieselCost', 0] } },
        closingStock: { $last: '$dieselStock' },
        levelMin: { $min: '$levelPercent' },
        levelAvg: { $avg: '$levelPercent' },
        levelMax: { $max: '$levelPercent' },
        consumption: { $sum: { $ifNull: ['$consumption', 0] } },
        closingReading: { $last: '$meterReading' },
        outOfRange: { $sum: { $cond: ['$outOfRange', 1, 0] } },
      },
    },
    { $lookup: { from: 'utilitypoints', localField: '_id.point', foreignField: '_id', as: 'point', pipeline: [{ $project: { name: 1, kind: 1, unit: 1 } }] } },
    { $unwind: '$point' },
    { $sort: { '_id.period': -1, 'point.name': 1 } },
  ]);

  // Average of each treatment-plant parameter per period.
  let params = [];
  if (['stp', 'wtp'].includes(kind)) {
    params = await UtilityReading.aggregate([
      { $match: match },
      { $unwind: '$values' },
      { $group: { _id: { point: '$point', period, key: '$values.key' }, label: { $first: '$values.label' }, unit: { $first: '$values.unit' }, avg: { $avg: '$values.value' }, min: { $min: '$values.value' }, max: { $max: '$values.value' }, outOfRange: { $sum: { $cond: ['$values.outOfRange', 1, 0] } } } },
    ]);
  }
  const paramsFor = (r) =>
    params
      .filter((p) => String(p._id.point) === String(r._id.point) && p._id.period === r._id.period)
      .map((p) => ({ key: p._id.key, label: p.label, unit: p.unit, avg: round3(p.avg), min: p.min, max: p.max, outOfRange: p.outOfRange }));

  return {
    kind,
    groupBy,
    from: start,
    to: end,
    rows: rows.map((r) => ({
      period: r._id.period,
      point: r.point,
      readings: r.readings,
      runHours: round3(r.runHours),
      runMinutes: r.runMinutes,
      dieselFilled: round3(r.dieselFilled),
      dieselConsumed: round3(r.dieselConsumed),
      dieselCost: r.dieselCost,
      closingStock: r.closingStock,
      levelMin: r.levelMin,
      levelAvg: r.levelAvg === null ? null : Math.round(r.levelAvg * 10) / 10,
      levelMax: r.levelMax,
      consumption: round3(r.consumption),
      closingReading: r.closingReading,
      outOfRange: r.outOfRange,
      parameters: paramsFor(r),
    })),
  };
}

const COLUMNS = {
  dg: [['hoursStart', 'Hours start'], ['hoursEnd', 'Hours end'], ['runHours', 'Run hours'], ['dieselFilled', 'Diesel filled (L)'], ['dieselConsumed', 'Diesel used (L)'], ['dieselStock', 'Stock after (L)']],
  pump: [['hoursStart', 'Hours start'], ['hoursEnd', 'Hours end'], ['runMinutes', 'Run minutes']],
  tank: [['levelPercent', 'Level %'], ['levelLitres', 'Level (L)']],
  meter: [['meterReading', 'Reading (kWh)'], ['consumption', 'Consumption (kWh)']],
  stp: [],
  wtp: [],
};
const SUMMARY_COLUMNS = {
  dg: [['runHours', 'Run hours'], ['dieselFilled', 'Filled (L)'], ['dieselConsumed', 'Used (L)'], ['closingStock', 'Closing stock (L)']],
  pump: [['runMinutes', 'Run minutes']],
  tank: [['levelMin', 'Min %'], ['levelAvg', 'Avg %'], ['levelMax', 'Max %']],
  meter: [['consumption', 'Consumption (kWh)'], ['closingReading', 'Closing reading']],
  stp: [['outOfRange', 'Out-of-range readings']],
  wtp: [['outOfRange', 'Out-of-range readings']],
};

export async function exportXlsx(ctx, q) {
  const s = await summary(ctx, q);
  const readings = await UtilityReading.find(readingFilter(ctx, { ...q, from: s.from, to: s.to })).sort({ at: 1 }).limit(20000).populate([{ path: 'point', select: 'name' }, { path: 'recordedBy', select: 'name' }]).lean();
  const paramKeys = [...new Map(readings.flatMap((r) => r.values || []).map((v) => [v.key, v])).values()];
  const kindCols = COLUMNS[q.kind].map(([key, header]) => ({ key, header, width: 14 }));
  const paramCols = paramKeys.map((p) => ({ key: `p_${p.key}`, header: `${p.label}${p.unit ? ` (${p.unit})` : ''}`, width: 12 }));
  return workbookBuffer([
    {
      name: 'Summary',
      columns: [
        { header: q.groupBy === 'month' ? 'Month' : 'Date', key: 'period', width: 12 },
        { header: 'Point', key: 'point', width: 24 },
        { header: 'Readings', key: 'readings', width: 10 },
        ...SUMMARY_COLUMNS[q.kind].map(([key, header]) => ({ key, header, width: 16 })),
        ...paramKeys.map((p) => ({ key: `avg_${p.key}`, header: `Avg ${p.label}`, width: 12 })),
      ],
      rows: s.rows.map((r) => ({ ...r, point: r.point.name, ...Object.fromEntries(r.parameters.map((p) => [`avg_${p.key}`, p.avg])) })),
    },
    {
      name: 'Readings',
      columns: [
        { header: 'Date', key: 'date', width: 12 },
        { header: 'Time', key: 'time', width: 8 },
        { header: 'Shift', key: 'shift', width: 10 },
        { header: 'Point', key: 'point', width: 24 },
        ...kindCols,
        ...paramCols,
        { header: 'Notes', key: 'notes', width: 30 },
        { header: 'By', key: 'by', width: 18 },
      ],
      rows: readings.map((r) => ({
        ...r,
        time: new Date(r.at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }),
        point: r.point?.name,
        by: r.recordedBy?.name,
        ...Object.fromEntries((r.values || []).map((v) => [`p_${v.key}`, v.value])),
      })),
    },
  ]);
}
