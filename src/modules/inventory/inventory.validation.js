import { z } from 'zod';
import { dateOnly, idParams, noDefaults, objectId, pageQuery, paise } from '../../common/utils/schemas.js';
import { ITEM_CATEGORIES, UNITS } from './inventoryItem.model.js';
import { MOVEMENT_TYPES } from './stockMovement.model.js';

export { idParams };

const text = (max) => z.string().trim().max(max);
const qty = () => z.coerce.number().positive().max(1e7);

const itemFields = {
  name: text(100).min(2),
  category: z.enum(ITEM_CATEGORIES).default('consumable'),
  unit: z.enum(UNITS).default('pcs'),
  description: text(500).optional(),
  location: text(80).optional(),
  reorderLevel: z.coerce.number().min(0).max(1e7).default(0),
  reorderQty: z.coerce.number().min(0).max(1e7).default(0),
};

export const createItem = z.object({ ...itemFields, openingStock: z.coerce.number().min(0).max(1e7).optional(), openingCost: paise().optional() });
export const updateItem = z
  .object({ ...noDefaults(itemFields), active: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const listItems = pageQuery.extend({
  category: z.enum(ITEM_CATEGORIES).optional(),
  search: text(60).optional(),
  low: z.stringbool().optional(),
  active: z.stringbool().optional(),
});

export const stockIn = z.object({
  qty: qty(),
  unitCost: paise(), // per unit, paise
  date: dateOnly().optional(),
  vendor: objectId().optional(),
  vendorName: text(120).optional(),
  invoiceNumber: text(60).optional(),
  reason: text(300).optional(),
});

export const stockOut = z.object({
  qty: qty(),
  date: dateOnly().optional(),
  issuedTo: objectId().optional(),
  ppmTask: objectId().optional(),
  workOrder: objectId().optional(),
  location: text(120).optional(),
  reason: text(300).optional(),
});

// Stock count correction: set the physical count.
export const adjust = z.object({ countedQty: z.coerce.number().min(0).max(1e7), reason: text(300).min(3), date: dateOnly().optional() });

export const listMovements = pageQuery.extend({
  item: objectId().optional(),
  type: z.enum(MOVEMENT_TYPES).optional(),
  from: dateOnly().optional(),
  to: dateOnly().optional(),
});

export const exportQuery = z.object({ report: z.enum(['valuation', 'ledger']).default('valuation'), from: dateOnly().optional(), to: dateOnly().optional() });
