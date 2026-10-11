import Block from './block.model.js';
import Unit from './unit.model.js';
import Membership from '../users/membership.model.js';
import Society from '../society/society.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { escapeRegex } from '../../common/utils/strings.js';
import * as audit from '../audit/audit.service.js';

// ---------- blocks ----------
export const listBlocks = (ctx) => Block.find({ society: ctx.societyId }).sort({ name: 1 }).lean();

export async function createBlock(ctx, data) {
  const block = await Block.create({ ...data, society: ctx.societyId });
  audit.record(ctx, 'block.created', 'Block', block._id, data);
  return block;
}

async function getBlock(ctx, id) {
  const block = await Block.findOne({ _id: id, society: ctx.societyId });
  if (!block) throw ApiError.notFound('Block not found');
  return block;
}

export async function updateBlock(ctx, id, data) {
  const block = await getBlock(ctx, id);
  Object.assign(block, data);
  await block.save();
  if (data.name) {
    const units = await Unit.find({ society: ctx.societyId, block: id }).select('number').lean();
    if (units.length) {
      await Unit.bulkWrite(units.map((u) => ({ updateOne: { filter: { _id: u._id }, update: { label: `${block.name}-${u.number}` } } })));
    }
  }
  return block;
}

export async function deleteBlock(ctx, id) {
  await getBlock(ctx, id);
  if (await Unit.exists({ society: ctx.societyId, block: id })) throw ApiError.conflict('Delete the units in this block first');
  await Block.deleteOne({ _id: id, society: ctx.societyId });
  audit.record(ctx, 'block.deleted', 'Block', id);
}

// ---------- units ----------
// Keeps a society within its plan's unit allowance.
async function assertUnitCapacity(ctx, adding) {
  const society = await Society.findById(ctx.societyId).select('plan').lean();
  const trialOver = society?.plan?.name === 'trial' && society.plan.validUntil && new Date(society.plan.validUntil) < new Date();
  const limit = trialOver ? 50 : society?.plan?.unitLimit;
  if (limit === null || limit === undefined) return;
  const count = await Unit.countDocuments({ society: ctx.societyId });
  if (count + adding > limit) {
    throw new ApiError(402, 'PLAN_LIMIT', `Your plan allows ${limit} units (${count} used). Contact support to upgrade.`);
  }
}

export function listUnits(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.block) filter.block = filters.block;
  if (filters.occupancy) filter.occupancy = filters.occupancy;
  if (filters.search) filter.label = { $regex: escapeRegex(filters.search.toUpperCase()) };
  return paginate(Unit, filter, pagination, { sort: { label: 1 }, populate: { path: 'block', select: 'name' } });
}

export async function getUnit(ctx, id) {
  const unit = await Unit.findOne({ _id: id, society: ctx.societyId }).populate('block', 'name').lean();
  if (!unit) throw ApiError.notFound('Unit not found');
  const members = await Membership.find({ society: ctx.societyId, unit: id, role: 'resident', status: { $in: ['active', 'pending'] } })
    .populate('user', 'name email phone')
    .lean();
  const residents = members.map((m) => ({ _id: m._id, user: m.user?._id, name: m.user?.name, email: m.user?.email, phone: m.user?.phone, residentType: m.residentType, status: m.status }));
  return { ...unit, residents };
}

// Ensures a unit belongs to the society; used by other modules.
export async function assertUnit(societyId, unitId) {
  const unit = await Unit.findOne({ _id: unitId, society: societyId }).lean();
  if (!unit) throw ApiError.badRequest('Unit not found in this society');
  return unit;
}

export async function createUnit(ctx, data) {
  const block = await getBlock(ctx, data.block);
  await assertUnitCapacity(ctx, 1);
  const unit = await Unit.create({ ...data, society: ctx.societyId, label: `${block.name}-${data.number.toUpperCase()}` });
  audit.record(ctx, 'unit.created', 'Unit', unit._id, { label: unit.label });
  return unit;
}

export async function updateUnit(ctx, id, data) {
  const unit = await Unit.findOne({ _id: id, society: ctx.societyId });
  if (!unit) throw ApiError.notFound('Unit not found');
  Object.assign(unit, data);
  const block = await getBlock(ctx, unit.block);
  unit.label = `${block.name}-${unit.number}`;
  await unit.save();
  return unit;
}

export async function deleteUnit(ctx, id) {
  const unit = await Unit.findOne({ _id: id, society: ctx.societyId });
  if (!unit) throw ApiError.notFound('Unit not found');
  if (await Membership.exists({ society: ctx.societyId, unit: id, status: { $in: ['active', 'pending'] } })) {
    throw ApiError.conflict('Unit has residents; move or deactivate them first');
  }
  await unit.deleteOne();
  audit.record(ctx, 'unit.deleted', 'Unit', id, { label: unit.label });
}

export async function bulkCreate(ctx, { block: blockId, fromFloor, toFloor, unitsPerFloor, type, areaSqft }) {
  const block = await getBlock(ctx, blockId);
  const docs = [];
  for (let floor = fromFloor; floor <= toFloor; floor += 1) {
    for (let i = 1; i <= unitsPerFloor; i += 1) {
      const number = `${floor === 0 ? 'G' : floor}${String(i).padStart(2, '0')}`;
      docs.push({ society: ctx.societyId, block: block._id, number, floor, type, areaSqft, label: `${block.name}-${number}` });
    }
  }
  const existing = await Unit.find({ society: ctx.societyId, block: block._id, number: { $in: docs.map((d) => d.number) } })
    .select('number')
    .lean();
  const taken = new Set(existing.map((u) => u.number));
  const fresh = docs.filter((d) => !taken.has(d.number));
  await assertUnitCapacity(ctx, fresh.length);
  if (fresh.length) await Unit.insertMany(fresh);
  audit.record(ctx, 'unit.bulk_created', 'Block', block._id, { requested: docs.length, inserted: fresh.length });
  return { requested: docs.length, inserted: fresh.length, skipped: docs.length - fresh.length };
}

// Derives occupancy from the active residents linked to a unit.
export async function refreshOccupancy(societyId, unitId) {
  if (!unitId) return;
  const residents = await Membership.find({ society: societyId, unit: unitId, role: 'resident', status: 'active' }).select('residentType').lean();
  let occupancy = 'vacant';
  if (residents.some((r) => r.residentType === 'tenant')) occupancy = 'rented';
  else if (residents.length) occupancy = 'owner_occupied';
  await Unit.updateOne({ _id: unitId, society: societyId }, { occupancy });
}
