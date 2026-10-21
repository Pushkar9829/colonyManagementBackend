import Meter, { METER_UNITS, TYPE_LABELS } from './meter.model.js';
import MeterReading from './meterReading.model.js';
import Tariff from './tariff.model.js';
import Unit from '../units/unit.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { localPeriod } from '../../common/utils/dates.js';
import { ROLES } from '../../common/constants/index.js';
import { invalidate } from '../../realtime/socket.js';
import * as audit from '../audit/audit.service.js';
import { parseDateCell, parseNumber, readSheet, workbookBuffer } from '../billing/sheets.js';

const isResident = (ctx) => ctx.role === ROLES.RESIDENT;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const round3 = (n) => Math.round(n * 1000) / 1000;

// IST month boundaries: [start of period, start of next period).
export function periodRange(period) {
  const [y, m] = period.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { start: new Date(`${period}-01T00:00:00+05:30`), end: new Date(`${next}-01T00:00:00+05:30`) };
}

// Progressive slab charge in paise for `qty` units.
export function slabCharge(slabs, qty) {
  let remaining = qty;
  let floor = 0;
  let total = 0;
  for (const s of slabs) {
    const cap = s.upTo == null ? Infinity : s.upTo;
    const band = Math.min(remaining, cap - floor);
    if (band > 0) {
      total += band * s.rate;
      remaining -= band;
    }
    floor = cap;
    if (remaining <= 0) break;
  }
  return Math.round(total);
}

const consumptionLabel = (type, qty) => `${TYPE_LABELS[type]} (${round3(qty)} ${METER_UNITS[type]})`;

// ---------- meters ----------
export async function listMeters(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  else if (filters.unit) filter.unit = filters.unit;
  if (filters.block) filter.block = filters.block;
  if (filters.type) filter.type = filters.type;
  if (filters.active !== undefined) filter.active = filters.active;
  if (filters.search) filter.serial = { $regex: `^${filters.search.toUpperCase().replace(/[^A-Z0-9-]/g, '')}` };
  return paginate(Meter, filter, pagination, { sort: { type: 1, serial: 1 }, populate: { path: 'unit', select: 'label' } });
}

async function findMeter(ctx, id) {
  const filter = { _id: id, society: ctx.societyId };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  const meter = await Meter.findOne(filter);
  if (!meter) throw ApiError.notFound('Meter not found');
  return meter;
}

export async function getMeter(ctx, id) {
  const meter = await findMeter(ctx, id);
  await meter.populate('unit', 'label');
  return meter.toObject();
}

export async function createMeter(ctx, data) {
  const unit = await Unit.findOne({ _id: data.unit, society: ctx.societyId }).select('block label').lean();
  if (!unit) throw ApiError.badRequest('Unit not found');
  try {
    const meter = await Meter.create({
      ...data,
      society: ctx.societyId,
      block: unit.block,
      billedReading: data.initialReading ?? 0,
      lastReading: data.initialReading ?? 0,
      lastReadAt: data.installedAt || new Date(),
    });
    audit.record(ctx, 'meter.created', 'Meter', meter._id, { serial: meter.serial, unit: unit.label, type: meter.type });
    return meter.toObject();
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('A meter with this serial number already exists');
    throw err;
  }
}

export async function updateMeter(ctx, id, data) {
  const meter = await findMeter(ctx, id);
  if (data.active === true && meter.replacedBy) throw ApiError.conflict('A replaced meter cannot be reactivated');
  Object.assign(meter, data);
  try {
    await meter.save();
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('A meter with this serial number already exists');
    throw err;
  }
  audit.record(ctx, 'meter.updated', 'Meter', meter._id, data);
  return meter.toObject();
}

// Swaps a faulty meter: records the old meter's final reading, retires it and fits a new one.
// Readings may restart from the new meter's initial reading — that is the only time they "go backwards".
export async function replaceMeter(ctx, id, { finalReading, serial, initialReading = 0, multiplier, replacedAt }) {
  const old = await findMeter(ctx, id);
  if (!old.active) throw ApiError.conflict('This meter is no longer active');
  const at = replacedAt || new Date();
  if (finalReading !== undefined) await addReading(ctx, old, { reading: finalReading, readAt: at, source: 'replacement', note: 'Final reading at replacement' });
  let fresh;
  try {
    fresh = await Meter.create({
      society: ctx.societyId,
      unit: old.unit,
      block: old.block,
      type: old.type,
      serial,
      multiplier: multiplier ?? old.multiplier,
      initialReading,
      installedAt: at,
      replaces: old._id,
      billedReading: initialReading,
      lastReading: initialReading,
      lastReadAt: at,
    });
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('A meter with this serial number already exists');
    throw err;
  }
  await Meter.updateOne({ _id: old._id }, { active: false, replacedAt: at, replacedBy: fresh._id });
  audit.record(ctx, 'meter.replaced', 'Meter', old._id, { from: old.serial, to: fresh.serial, finalReading });
  return fresh.toObject();
}

// ---------- readings ----------
// Validates and stores one reading. A reading must lie between its neighbours in time, cannot be in the
// future, before installation, or inside a period whose consumption has already been billed.
export async function addReading(ctx, meterOrId, { reading, readAt, source = 'manual', note, device }) {
  const meter = meterOrId instanceof Meter ? meterOrId : await findMeter(ctx, meterOrId);
  const at = readAt ? new Date(readAt) : new Date();
  if (!meter.active && source !== 'replacement') throw ApiError.conflict(`Meter ${meter.serial} is not active`);
  if (at.getTime() > Date.now() + FUTURE_SKEW_MS) throw ApiError.badRequest('Reading time cannot be in the future');
  if (meter.installedAt && at < meter.installedAt) throw ApiError.badRequest('Reading is older than the meter installation');
  if (meter.billedAt && at <= meter.billedAt) throw ApiError.conflict('Consumption up to this date has already been billed');
  if (reading < meter.initialReading) throw ApiError.badRequest(`Reading cannot be below the meter's initial reading (${meter.initialReading})`);

  const [prev, next] = await Promise.all([
    MeterReading.findOne({ meter: meter._id, readAt: { $lt: at } }).sort({ readAt: -1 }).lean(),
    MeterReading.findOne({ meter: meter._id, readAt: { $gt: at } }).sort({ readAt: 1 }).lean(),
  ]);
  if (prev && reading < prev.reading) {
    throw ApiError.badRequest('Reading cannot go backwards: last reading was {reading} on {date}', { params: { reading: prev.reading, date: prev.readAt.toISOString().slice(0, 10) } });
  }
  if (next && reading > next.reading) throw ApiError.badRequest(`Reading is higher than the later reading ${next.reading}`);

  let doc;
  try {
    doc = await MeterReading.create({
      society: meter.society,
      meter: meter._id,
      unit: meter.unit,
      reading,
      readAt: at,
      period: localPeriod(at),
      source,
      note,
      device,
      recordedBy: ctx.userId || undefined,
    });
  } catch (err) {
    if (err.code === 11000) {
      const same = await MeterReading.findOne({ meter: meter._id, readAt: at }).lean();
      if (same?.reading === reading) return same; // device retry of the same reading
      throw ApiError.conflict('A different reading already exists for this time');
    }
    throw err;
  }
  await Meter.updateOne(
    { _id: meter._id, $or: [{ lastReadAt: null }, { lastReadAt: { $lte: at } }] },
    { lastReading: reading, lastReadAt: at },
  );
  return doc.toObject();
}

export async function recordReading(ctx, meterId, data) {
  const r = await addReading(ctx, meterId, { ...data, source: 'manual' });
  invalidate(ctx.societyId, ['meters']);
  return r;
}

// Applies many readings; each row succeeds or fails on its own so one typo does not block a block's sheet.
async function applyRows(ctx, rows, source) {
  const results = [];
  for (const row of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const meter = row.meterDoc || (await findMeter(ctx, row.meter));
      // eslint-disable-next-line no-await-in-loop
      const r = await addReading(ctx, meter, { reading: row.reading, readAt: row.readAt, source, device: row.device });
      results.push({ ref: row.ref, meter: meter._id, serial: meter.serial, ok: true, reading: r.reading });
    } catch (err) {
      results.push({ ref: row.ref, meter: row.meterDoc?._id || row.meter, serial: row.meterDoc?.serial || row.serial, ok: false, error: err.message });
    }
  }
  const saved = results.filter((r) => r.ok).length;
  if (saved) invalidate(ctx.societyId, ['meters']);
  return { saved, failed: results.length - saved, results };
}

export async function bulkReadings(ctx, { readAt, readings }) {
  const res = await applyRows(ctx, readings.map((r) => ({ ref: r.meter, meter: r.meter, reading: r.reading, readAt: r.readAt || readAt })), 'manual');
  audit.record(ctx, 'meter.readings_bulk', 'MeterReading', undefined, { saved: res.saved, failed: res.failed });
  return res;
}

// Sheet columns: Serial | Reading | Read on (optional, YYYY-MM-DD; default today).
export async function importReadings(ctx, file) {
  const rows = await readSheet(file);
  const serials = [...new Set(rows.map((r) => String(r.serial || r.meter || r.meterserial || '').trim().toUpperCase()).filter(Boolean))];
  const meters = new Map((await Meter.find({ society: ctx.societyId, serial: { $in: serials } })).map((m) => [m.serial, m]));
  const prepared = [];
  const invalid = [];
  for (const r of rows) {
    const serial = String(r.serial || r.meter || r.meterserial || '').trim().toUpperCase();
    const reading = parseNumber(r.reading ?? r.currentreading);
    const day = r.readon || r.readat || r.date ? parseDateCell(r.readon || r.readat || r.date) : null;
    if (!serial || r.reading === undefined || r.reading === '') continue; // blank reading cells are left for later
    if (!meters.has(serial)) invalid.push({ ref: r.row, serial, ok: false, error: 'Unknown meter serial' });
    else if (!Number.isFinite(reading) || reading < 0) invalid.push({ ref: r.row, serial, ok: false, error: 'Reading must be a number' });
    else if ((r.readon || r.readat || r.date) && !day) invalid.push({ ref: r.row, serial, ok: false, error: 'Read on must be YYYY-MM-DD' });
    else prepared.push({ ref: r.row, meterDoc: meters.get(serial), serial, reading, readAt: day ? new Date(`${day}T12:00:00+05:30`) : undefined });
  }
  const res = await applyRows(ctx, prepared, 'import');
  const results = [...invalid, ...res.results].sort((a, b) => a.ref - b.ref);
  audit.record(ctx, 'meter.readings_imported', 'MeterReading', undefined, { saved: res.saved, failed: results.length - res.saved });
  return { saved: res.saved, failed: results.length - res.saved, results };
}

// Hardware path (X-Device-Key with meters:write). ctx.societyId comes from the key.
export async function deviceReadings(ctx, device, items) {
  const serials = [...new Set(items.map((i) => i.serial.toUpperCase()))];
  const meters = new Map((await Meter.find({ society: ctx.societyId, serial: { $in: serials } })).map((m) => [m.serial, m]));
  const rows = [];
  const unknown = [];
  items.forEach((i, idx) => {
    const m = meters.get(i.serial.toUpperCase());
    if (m) rows.push({ ref: idx, meterDoc: m, reading: i.reading, readAt: i.readAt, device: device._id });
    else unknown.push({ ref: idx, serial: i.serial, ok: false, error: 'Unknown meter serial' });
  });
  const res = await applyRows(ctx, rows, 'device');
  const results = [...unknown, ...res.results].sort((a, b) => a.ref - b.ref);
  return { saved: res.saved, failed: results.length - res.saved, results };
}

export async function listReadings(ctx, meterId, pagination) {
  const meter = await findMeter(ctx, meterId);
  return paginate(MeterReading, { society: ctx.societyId, meter: meter._id }, pagination, { sort: { readAt: -1 }, populate: { path: 'recordedBy', select: 'name' } });
}

export async function deleteReading(ctx, id) {
  const r = await MeterReading.findOne({ _id: id, society: ctx.societyId });
  if (!r) throw ApiError.notFound('Reading not found');
  const meter = await Meter.findById(r.meter);
  if (meter.billedAt && r.readAt <= meter.billedAt) throw ApiError.conflict('This reading has already been billed');
  await r.deleteOne();
  const latest = await MeterReading.findOne({ meter: meter._id }).sort({ readAt: -1 }).lean();
  await Meter.updateOne({ _id: meter._id }, latest ? { lastReading: latest.reading, lastReadAt: latest.readAt } : { lastReading: meter.initialReading, lastReadAt: meter.installedAt });
  audit.record(ctx, 'meter.reading_deleted', 'MeterReading', r._id, { serial: meter.serial, reading: r.reading });
  invalidate(ctx.societyId, ['meters']);
}

// Reading-entry grid for one block: every active meter with its last reading and the reading already
// captured this period (if any).
export async function sheet(ctx, { block, type, period }) {
  const filter = { society: ctx.societyId, active: true };
  if (block) filter.block = block;
  if (type) filter.type = type;
  const meters = await Meter.find(filter).populate('unit', 'label').lean();
  meters.sort((a, b) => (a.unit?.label || '').localeCompare(b.unit?.label || '', 'en', { numeric: true }) || a.type.localeCompare(b.type));
  const { start, end } = periodRange(period);
  const inPeriod = await MeterReading.aggregate([
    { $match: { society: ctx.societyId, meter: { $in: meters.map((m) => m._id) }, readAt: { $gte: start, $lt: end } } },
    { $sort: { readAt: -1 } },
    { $group: { _id: '$meter', reading: { $first: '$reading' }, readAt: { $first: '$readAt' } } },
  ]);
  const byMeter = new Map(inPeriod.map((r) => [String(r._id), r]));
  return meters.map((m) => ({
    meter: { _id: m._id, serial: m.serial, type: m.type, multiplier: m.multiplier },
    unit: m.unit,
    lastReading: m.lastReading ?? m.initialReading,
    lastReadAt: m.lastReadAt,
    periodReading: byMeter.get(String(m._id)) || null,
  }));
}

export async function sheetWorkbook(ctx, query) {
  const rows = await sheet(ctx, query);
  return workbookBuffer(
    'Readings',
    [
      { header: 'Unit', key: 'unit', width: 12 },
      { header: 'Type', key: 'type', width: 14 },
      { header: 'Serial', key: 'serial', width: 18 },
      { header: 'Last reading', key: 'last', width: 14 },
      { header: 'Reading', key: 'reading', width: 14 },
      { header: 'Read on', key: 'readOn', width: 14 },
    ],
    rows.map((r) => ({ unit: r.unit?.label, type: TYPE_LABELS[r.meter.type], serial: r.meter.serial, last: r.lastReading, reading: r.periodReading?.reading ?? '', readOn: '' })),
  );
}

// ---------- consumption ----------
// Consumption inside a calendar month per meter (independent of billing): last reading in the month
// minus the last reading before it (or the initial reading for meters fitted later), times the multiplier.
export async function consumption(ctx, { period, type, unit, block }) {
  const filter = { society: ctx.societyId };
  if (isResident(ctx)) filter.unit = ctx.unitId;
  else if (unit) filter.unit = unit;
  if (type) filter.type = type;
  if (block) filter.block = block;
  const { start, end } = periodRange(period);
  filter.installedAt = { $lt: end };
  filter.$or = [{ replacedAt: null }, { replacedAt: { $gte: start } }];
  const meters = await Meter.find(filter).populate('unit', 'label').lean();
  const ids = meters.map((m) => m._id);
  const [before, within, tariffs] = await Promise.all([
    MeterReading.aggregate([
      { $match: { society: ctx.societyId, meter: { $in: ids }, readAt: { $lt: start } } },
      { $sort: { readAt: -1 } },
      { $group: { _id: '$meter', reading: { $first: '$reading' } } },
    ]),
    MeterReading.aggregate([
      { $match: { society: ctx.societyId, meter: { $in: ids }, readAt: { $gte: start, $lt: end } } },
      { $sort: { readAt: -1 } },
      { $group: { _id: '$meter', reading: { $first: '$reading' }, readAt: { $first: '$readAt' }, count: { $sum: 1 } } },
    ]),
    Tariff.find({ society: ctx.societyId, active: true }).lean(),
  ]);
  const prevBy = new Map(before.map((r) => [String(r._id), r.reading]));
  const endBy = new Map(within.map((r) => [String(r._id), r]));
  const tariffBy = new Map(tariffs.map((t) => [t.type, t]));
  return meters.map((m) => {
    const last = endBy.get(String(m._id));
    const base = prevBy.get(String(m._id)) ?? m.initialReading;
    const qty = last ? round3(Math.max(0, last.reading - base) * m.multiplier) : 0;
    const tariff = tariffBy.get(m.type);
    return {
      meter: { _id: m._id, serial: m.serial, type: m.type, multiplier: m.multiplier, active: m.active },
      unit: m.unit,
      opening: base,
      closing: last?.reading ?? null,
      readings: last?.count || 0,
      consumption: qty,
      uom: METER_UNITS[m.type],
      estimatedCharge: tariff ? slabCharge(tariff.slabs, qty) + (m.active ? tariff.fixedCharge : 0) : null,
    };
  });
}

// ---------- tariffs ----------
export const listTariffs = (ctx) => Tariff.find({ society: ctx.societyId }).sort({ type: 1, active: -1, createdAt: -1 }).lean();

// A new active tariff replaces the one in force for that type.
export async function createTariff(ctx, data) {
  if (data.active !== false) await Tariff.updateMany({ society: ctx.societyId, type: data.type, active: true }, { active: false });
  const t = await Tariff.create({ ...data, society: ctx.societyId, createdBy: ctx.userId });
  audit.record(ctx, 'meter.tariff_created', 'Tariff', t._id, { type: t.type, name: t.name });
  return t.toObject();
}

export async function updateTariff(ctx, id, data) {
  const t = await Tariff.findOne({ _id: id, society: ctx.societyId });
  if (!t) throw ApiError.notFound('Tariff not found');
  if (data.active === true && !t.active) await Tariff.updateMany({ society: ctx.societyId, type: t.type, active: true, _id: { $ne: t._id } }, { active: false });
  Object.assign(t, data);
  await t.save();
  audit.record(ctx, 'meter.tariff_updated', 'Tariff', t._id, data);
  return t.toObject();
}

// ---------- billing hook ----------
// Metered charges for the given units for a billing period: consumption since the last billed reading
// up to the end of the period, priced with the active tariff (+ its fixed charge per active meter).
// Returns:
//   lines:   Map(unitId → [{ head: 'Water (12 kL)', key: 'Water', amount, kind: 'metered' }])
//   details: Map(unitId → [{ meter, serial, type, from, fromAt, to, toAt, consumption }])  (stored on the bill)
//   commit(unitIds): advance those units' meters to the billed reading — call it for units actually billed.
export async function meteredCharges(societyId, unitIds, period) {
  const { end } = periodRange(period);
  const lines = new Map();
  const details = new Map();
  const meters = await Meter.find({ society: societyId, unit: { $in: unitIds }, installedAt: { $lt: end } }).lean();
  if (!meters.length) return { lines, details, commit: async () => {} };
  const tariffs = new Map((await Tariff.find({ society: societyId, active: true }).lean()).map((t) => [t.type, t]));
  const latest = await MeterReading.aggregate([
    { $match: { society: societyId, meter: { $in: meters.map((m) => m._id) }, readAt: { $lt: end } } },
    { $sort: { readAt: -1 } },
    { $group: { _id: '$meter', reading: { $first: '$reading' }, readAt: { $first: '$readAt' } } },
  ]);
  const lastBy = new Map(latest.map((r) => [String(r._id), r]));
  const perUnitType = new Map();

  for (const m of meters) {
    const tariff = tariffs.get(m.type);
    if (!tariff) continue; // no tariff: consumption stays unbilled until one exists
    const last = lastBy.get(String(m._id));
    const from = m.billedReading ?? m.initialReading;
    const fresh = last && (!m.billedAt || last.readAt > m.billedAt);
    const qty = fresh ? round3(Math.max(0, last.reading - from) * m.multiplier) : 0;
    const key = `${m.unit}|${m.type}`;
    const agg = perUnitType.get(key) || { unit: String(m.unit), type: m.type, tariff, qty: 0, activeMeters: 0 };
    agg.qty += qty;
    if (m.active) agg.activeMeters += 1;
    perUnitType.set(key, agg);
    if (fresh) {
      if (!details.has(String(m.unit))) details.set(String(m.unit), []);
      details.get(String(m.unit)).push({ meter: m._id, serial: m.serial, type: m.type, from, fromAt: m.billedAt || null, to: last.reading, toAt: last.readAt, consumption: qty });
    }
  }

  for (const agg of perUnitType.values()) {
    const qty = round3(agg.qty);
    const amount = slabCharge(agg.tariff.slabs, qty) + agg.tariff.fixedCharge * agg.activeMeters;
    if (amount <= 0) continue;
    if (!lines.has(agg.unit)) lines.set(agg.unit, []);
    lines.get(agg.unit).push({ head: consumptionLabel(agg.type, qty), key: TYPE_LABELS[agg.type], amount, kind: 'metered' });
  }

  const commit = async (billedUnitIds) => {
    const ops = [];
    for (const unit of billedUnitIds.map(String)) {
      for (const d of details.get(unit) || []) {
        ops.push({ updateOne: { filter: { _id: d.meter, society: societyId }, update: { $set: { billedReading: d.to, billedAt: d.toAt } } } });
      }
    }
    if (ops.length) await Meter.bulkWrite(ops);
  };
  return { lines, details, commit };
}

// Undoes commit() for a cancelled bill, so its consumption is charged on the next bill instead.
// Only meters still at exactly the bill's reading are rolled back (a later bill may have moved them on).
export async function unbill(societyId, entries = []) {
  const ops = entries.map((d) => ({
    updateOne: { filter: { _id: d.meter, society: societyId, billedAt: d.toAt }, update: { $set: { billedReading: d.from, billedAt: d.fromAt } } },
  }));
  if (ops.length) await Meter.bulkWrite(ops);
}
