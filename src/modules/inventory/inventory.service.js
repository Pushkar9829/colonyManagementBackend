import InventoryItem from './inventoryItem.model.js';
import StockMovement from './stockMovement.model.js';
import PpmTask from '../maintenance/ppmTask.model.js';
import WorkOrder from '../maintenance/workOrder.model.js';
import Society from '../society/society.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { ROLES, STAFF_ROLES } from '../../common/constants/index.js';
import { nextNumber } from '../counter/counter.service.js';
import * as audit from '../audit/audit.service.js';
import { notifyRoles } from '../notifications/notifications.service.js';
import { invalidate } from '../../realtime/socket.js';
import { assertMember, round3, today, workbookBuffer } from '../assets/facility.shared.js';

const MANAGERS = [ROLES.ADMIN, ROLES.FACILITY_MANAGER];
const LOW = { $expr: { $and: [{ $gt: ['$reorderLevel', 0] }, { $lte: ['$stock', '$reorderLevel'] }] } };

const present = (i) => ({ ...i, value: Math.round((i.stock || 0) * (i.avgCost || 0)), low: i.reorderLevel > 0 && i.stock <= i.reorderLevel });

async function loadItem(ctx, id) {
  const item = await InventoryItem.findOne({ _id: id, society: ctx.societyId }).lean();
  if (!item) throw ApiError.notFound('Item not found');
  return item;
}

export async function createItem(ctx, { openingStock, openingCost, ...data }) {
  const item = await InventoryItem.create({ ...data, society: ctx.societyId, code: await nextNumber(ctx.societyId, 'inventory_item', 'ITM', 4) });
  audit.record(ctx, 'inventory.item_created', 'InventoryItem', item._id, { name: item.name });
  if (openingStock > 0) {
    await stockIn(ctx, item._id, { qty: openingStock, unitCost: openingCost || 0, reason: 'Opening stock' });
  }
  return present(await loadItem(ctx, item._id));
}

export async function listItems(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.category) filter.category = filters.category;
  if (filters.active !== undefined) filter.active = filters.active;
  if (filters.search) {
    const rx = new RegExp(escapeRegex(filters.search), 'i');
    filter.$or = [{ name: rx }, { code: rx }, { location: rx }];
  }
  if (filters.low) Object.assign(filter, LOW);
  const result = await paginate(InventoryItem, filter, pagination, { sort: { name: 1 } });
  result.items = result.items.map(present);
  return result;
}

export const getItem = async (ctx, id) => present(await loadItem(ctx, id));

export async function updateItem(ctx, id, data) {
  const item = await InventoryItem.findOneAndUpdate({ _id: id, society: ctx.societyId }, { $set: data }, { returnDocument: 'after', runValidators: true }).lean();
  if (!item) throw ApiError.notFound('Item not found');
  if ('reorderLevel' in data && item.stock > item.reorderLevel && item.lowStockAlertedAt) {
    await InventoryItem.updateOne({ _id: item._id }, { $unset: { lowStockAlertedAt: 1 } });
  }
  return present(item);
}

async function record(ctx, item, data) {
  const m = await StockMovement.create({ ...data, society: ctx.societyId, item: item._id, balanceAfter: item.stock, date: data.date || today(), by: ctx.userId || undefined });
  invalidate(ctx.societyId, ['inventory'], { roles: [] });
  return m;
}

// Tells managers once when an item drops to its reorder level; re-armed by the next stock-in above it.
async function checkLow(ctx, item) {
  if (!(item.reorderLevel > 0 && item.stock <= item.reorderLevel) || item.lowStockAlertedAt) return false;
  const claimed = await InventoryItem.findOneAndUpdate({ _id: item._id, lowStockAlertedAt: null }, { lowStockAlertedAt: new Date() });
  if (!claimed) return false;
  await notifyRoles(ctx.societyId, MANAGERS, {
    type: 'inventory',
    title: `Low stock: ${item.name}`,
    body: `${item.stock} ${item.unit} left (reorder level ${item.reorderLevel}${item.reorderQty ? `, order ${item.reorderQty}` : ''})`,
    link: '/inventory?low=true',
  });
  return true;
}

export async function stockIn(ctx, id, { qty, unitCost, ...rest }) {
  const q = round3(qty);
  // Moving weighted-average cost, computed in the same atomic update as the stock change.
  const item = await InventoryItem.findOneAndUpdate(
    { _id: id, society: ctx.societyId },
    [
      {
        $set: {
          avgCost: {
            $let: {
              vars: { base: { $max: ['$stock', 0] } },
              in: { $round: [{ $divide: [{ $add: [{ $multiply: ['$$base', '$avgCost'] }, q * unitCost] }, { $add: ['$$base', q] }] }, 0] },
            },
          },
          stock: { $round: [{ $add: ['$stock', q] }, 3] },
          lastPurchaseCost: unitCost,
        },
      },
    ],
    { returnDocument: 'after', updatePipeline: true },
  ).lean();
  if (!item) throw ApiError.notFound('Item not found');
  if (item.lowStockAlertedAt && item.stock > item.reorderLevel) await InventoryItem.updateOne({ _id: item._id }, { $unset: { lowStockAlertedAt: 1 } });
  const movement = await record(ctx, item, { ...rest, type: 'in', qty: q, unitCost, value: Math.round(q * unitCost) });
  audit.record(ctx, 'inventory.stock_in', 'InventoryItem', item._id, { qty: q, unitCost, vendorName: rest.vendorName });
  return { item: present(await loadItem(ctx, item._id)), movement: movement.toObject() };
}

export async function stockOut(ctx, id, { qty, ...rest }) {
  const q = round3(qty);
  if (rest.issuedTo) await assertMember(ctx, rest.issuedTo, [...STAFF_ROLES, ROLES.ADMIN], 'Issued-to person');
  if (rest.ppmTask && !(await PpmTask.exists({ _id: rest.ppmTask, society: ctx.societyId }))) throw ApiError.badRequest('PPM task not found');
  if (rest.workOrder && !(await WorkOrder.exists({ _id: rest.workOrder, society: ctx.societyId }))) throw ApiError.badRequest('Work order not found');
  const item = await InventoryItem.findOneAndUpdate(
    { _id: id, society: ctx.societyId, stock: { $gte: q } },
    [{ $set: { stock: { $round: [{ $subtract: ['$stock', q] }, 3] } } }],
    { returnDocument: 'after', updatePipeline: true },
  ).lean();
  if (!item) {
    const current = await loadItem(ctx, id);
    throw ApiError.conflict('Only {stock} {unit} of {name} in stock', { params: { stock: current.stock, unit: current.unit, name: current.name } });
  }
  const movement = await record(ctx, item, { ...rest, type: 'out', qty: -q, unitCost: item.avgCost, value: -Math.round(q * item.avgCost) });
  const alerted = await checkLow(ctx, item);
  return { item: present(await loadItem(ctx, item._id)), movement: movement.toObject(), lowStockAlert: alerted };
}

export async function adjust(ctx, id, { countedQty, reason, date }) {
  const current = await loadItem(ctx, id);
  const target = round3(countedQty);
  const delta = round3(target - current.stock);
  if (delta === 0) throw ApiError.conflict('The count matches the stock on record');
  // Guard against a concurrent movement between the read and the write.
  const item = await InventoryItem.findOneAndUpdate({ _id: id, society: ctx.societyId, stock: current.stock }, { $set: { stock: target } }, { returnDocument: 'after' }).lean();
  if (!item) throw ApiError.conflict('Stock changed while you were counting; try again');
  const movement = await record(ctx, item, { type: 'adjust', qty: delta, unitCost: item.avgCost, value: Math.round(delta * item.avgCost), reason, date });
  audit.record(ctx, 'inventory.adjusted', 'InventoryItem', item._id, { from: current.stock, to: target, reason });
  if (item.stock > item.reorderLevel && item.lowStockAlertedAt) await InventoryItem.updateOne({ _id: item._id }, { $unset: { lowStockAlertedAt: 1 } });
  else await checkLow(ctx, item);
  return { item: present(await loadItem(ctx, item._id)), movement: movement.toObject() };
}

function movementFilter(ctx, filters) {
  const filter = { society: ctx.societyId };
  if (filters.item) filter.item = filters.item;
  if (filters.type) filter.type = filters.type;
  if (filters.from || filters.to) filter.date = { ...(filters.from && { $gte: filters.from }), ...(filters.to && { $lte: filters.to }) };
  return filter;
}

const MOVEMENT_POPULATE = [
  { path: 'item', select: 'name code unit' },
  { path: 'issuedTo', select: 'name' },
  { path: 'by', select: 'name' },
  { path: 'workOrder', select: 'number' },
  { path: 'ppmTask', select: 'title dueDate' },
];

export const listMovements = (ctx, filters, pagination) => paginate(StockMovement, movementFilter(ctx, filters), pagination, { populate: MOVEMENT_POPULATE });

export async function valuation(ctx) {
  const items = (await InventoryItem.find({ society: ctx.societyId, active: true }).sort({ category: 1, name: 1 }).lean()).map(present);
  const byCategory = {};
  for (const i of items) {
    byCategory[i.category] = byCategory[i.category] || { category: i.category, items: 0, value: 0, low: 0 };
    byCategory[i.category].items += 1;
    byCategory[i.category].value += i.value;
    if (i.low) byCategory[i.category].low += 1;
  }
  return { totalValue: items.reduce((s, i) => s + i.value, 0), lowStock: items.filter((i) => i.low).length, categories: Object.values(byCategory), items };
}

const rupees = (p) => Math.round(p) / 100;

export async function exportXlsx(ctx, { report, from, to }) {
  if (report === 'ledger') {
    const rows = await StockMovement.find(movementFilter(ctx, { from, to })).sort({ createdAt: 1 }).limit(20000).populate(MOVEMENT_POPULATE).lean();
    return workbookBuffer([
      {
        name: 'Stock ledger',
        columns: [
          { header: 'Date', key: 'date', width: 12 },
          { header: 'Item', key: 'item', width: 28 },
          { header: 'Type', key: 'type', width: 8 },
          { header: 'Qty', key: 'qty', width: 10 },
          { header: 'Unit', key: 'unit', width: 8 },
          { header: 'Balance', key: 'balance', width: 10 },
          { header: 'Unit cost (₹)', key: 'unitCost', width: 12 },
          { header: 'Value (₹)', key: 'value', width: 12 },
          { header: 'Vendor / issued to', key: 'party', width: 24 },
          { header: 'Reference', key: 'ref', width: 18 },
          { header: 'Reason / location', key: 'reason', width: 30 },
          { header: 'By', key: 'by', width: 18 },
        ],
        rows: rows.map((m) => ({
          date: m.date,
          item: `${m.item?.name || ''} (${m.item?.code || ''})`,
          type: m.type,
          qty: m.qty,
          unit: m.item?.unit,
          balance: m.balanceAfter,
          unitCost: rupees(m.unitCost),
          value: rupees(m.value),
          party: m.vendorName || m.issuedTo?.name || '',
          ref: m.invoiceNumber || m.workOrder?.number || m.ppmTask?.title || '',
          reason: [m.reason, m.location].filter(Boolean).join(' · '),
          by: m.by?.name || '',
        })),
      },
    ]);
  }
  const v = await valuation(ctx);
  return workbookBuffer([
    {
      name: 'Valuation',
      columns: [
        { header: 'Code', key: 'code', width: 10 },
        { header: 'Item', key: 'name', width: 30 },
        { header: 'Category', key: 'category', width: 14 },
        { header: 'Stock', key: 'stock', width: 10 },
        { header: 'Unit', key: 'unit', width: 8 },
        { header: 'Avg cost (₹)', key: 'avgCost', width: 12 },
        { header: 'Value (₹)', key: 'value', width: 14 },
        { header: 'Reorder level', key: 'reorderLevel', width: 12 },
        { header: 'Low', key: 'low', width: 6 },
      ],
      rows: v.items.map((i) => ({ ...i, avgCost: rupees(i.avgCost), value: rupees(i.value), low: i.low ? 'Yes' : '' })),
    },
    {
      name: 'By category',
      columns: [
        { header: 'Category', key: 'category', width: 16 },
        { header: 'Items', key: 'items', width: 8 },
        { header: 'Low stock', key: 'low', width: 10 },
        { header: 'Value (₹)', key: 'value', width: 14 },
      ],
      rows: [...v.categories.map((c) => ({ ...c, value: rupees(c.value) })), { category: 'Total', value: rupees(v.totalValue) }],
    },
  ]);
}

// Catches items that are low without a movement having triggered the alert (e.g. reorder level raised).
export async function reorderAlerts() {
  const societies = (await Society.find({ active: true }).select('_id').lean()).map((s) => s._id);
  const items = await InventoryItem.find({ society: { $in: societies }, active: true, lowStockAlertedAt: null, ...LOW }).select('society name stock unit').limit(5000).lean();
  if (!items.length) return { alerted: 0 };
  await InventoryItem.updateMany({ _id: { $in: items.map((i) => i._id) } }, { lowStockAlertedAt: new Date() });
  const bySociety = new Map();
  for (const i of items) bySociety.set(String(i.society), [...(bySociety.get(String(i.society)) || []), i]);
  for (const [society, list] of bySociety) {
    // eslint-disable-next-line no-await-in-loop
    await notifyRoles(society, MANAGERS, {
      type: 'inventory',
      title: list.length === 1 ? `Low stock: ${list[0].name}` : `${list.length} items at or below reorder level`,
      body: list.slice(0, 5).map((i) => `${i.name} (${i.stock} ${i.unit})`).join(', '),
      link: '/inventory?low=true',
    });
  }
  return { alerted: items.length };
}
