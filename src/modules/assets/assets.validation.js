import { z } from 'zod';
import { dateOnly, hhmm, idParams, objectId, pageQuery, paise, phone } from '../../common/utils/schemas.js';
import { AMC_COVERAGE, ASSET_CATEGORIES, ASSET_STATUS } from './asset.model.js';
import { EXTINGUISHER_TYPES } from './fireExtinguisher.model.js';

export { idParams };

const text = (max) => z.string().trim().max(max);
const uploadIds = (max = 10) => z.array(objectId()).max(max);

const assetFields = {
  category: z.enum(ASSET_CATEGORIES),
  name: text(100).min(2),
  tag: text(40).min(1).optional(),
  location: text(120).optional(),
  block: objectId().optional(),
  make: text(80).optional(),
  model: text(80).optional(),
  serialNumber: text(80).optional(),
  capacity: text(60).optional(),
  purchaseDate: dateOnly().optional(),
  purchaseCost: paise().optional(),
  warrantyExpiry: dateOnly().optional(),
  notes: text(1000).optional(),
};

export const createAsset = z.object({
  ...assetFields,
  status: z.enum(ASSET_STATUS).optional(),
  photos: uploadIds().optional(),
  documents: uploadIds().optional(),
});

// Nullable so a field can be cleared from the edit form.
export const updateAsset = z
  .object(Object.fromEntries(Object.entries(assetFields).map(([k, v]) => [k, k === 'category' || k === 'name' ? v.optional() : v.unwrap().nullable().optional()])))
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' });

export const changeStatus = z.object({ status: z.enum(ASSET_STATUS), note: text(300).optional() });

export const listAssets = pageQuery.extend({
  category: z.enum(ASSET_CATEGORIES).optional(),
  status: z.enum(ASSET_STATUS).optional(),
  block: objectId().optional(),
  search: text(60).optional(),
  expiring: z.coerce.number().int().min(1).max(365).optional(), // AMC or warranty ending within N days
});

export const codeParams = z.object({ code: text(60).min(3) });

export const addFiles = z.object({ kind: z.enum(['photos', 'documents']), uploads: uploadIds().min(1) });
export const removeFile = z.object({ kind: z.enum(['photos', 'documents', 'amc']), url: z.string().min(1).max(500) });

export const setAmc = z
  .object({
    renew: z.boolean().default(false), // true: archive the current contract and start a new one
    vendor: objectId().optional(),
    vendorName: text(120).min(2),
    contractNumber: text(60).optional(),
    startDate: dateOnly(),
    endDate: dateOnly(),
    cost: paise().default(0),
    coverage: z.enum(AMC_COVERAGE).optional(),
    visitsPerYear: z.coerce.number().int().min(0).max(365).default(0),
    contactPhone: phone().optional(),
    notes: text(1000).optional(),
    documents: uploadIds().optional(),
  })
  .refine((v) => v.endDate > v.startDate, { message: 'End date must be after the start date', path: ['endDate'] });

export const amcVisit = z.object({
  date: dateOnly(),
  type: z.enum(['preventive', 'breakdown', 'inspection']).default('preventive'),
  technician: text(80).optional(),
  findings: text(1000).optional(),
  attachments: uploadIds(5).optional(),
});

export const serviceEvent = z.object({
  type: z.enum(['service', 'note']).default('service'),
  title: text(120).min(2),
  notes: text(1000).optional(),
  cost: paise().optional(),
  date: dateOnly().optional(),
  attachments: uploadIds(5).optional(),
});

// ---- fire safety ----
const extinguisherFields = {
  location: text(120).min(2),
  block: objectId().optional(),
  type: z.enum(EXTINGUISHER_TYPES),
  capacityKg: z.coerce.number().min(0).max(500).optional(),
  installedOn: dateOnly().optional(),
  lastRefillDate: dateOnly().optional(),
  nextRefillDue: dateOnly().optional(),
  expiryDate: dateOnly().optional(),
  lastInspectedOn: dateOnly().optional(),
  notes: text(500).optional(),
};
export const createExtinguisher = z.object(extinguisherFields);
export const updateExtinguisher = z.object({ ...extinguisherFields, active: z.boolean() }).partial();
export const refillExtinguisher = z.object({ lastRefillDate: dateOnly(), nextRefillDue: dateOnly(), expiryDate: dateOnly().optional() });
export const listExtinguishers = pageQuery.extend({ dueWithin: z.coerce.number().int().min(0).max(365).optional(), active: z.stringbool().optional() });

export const createDrill = z.object({
  date: dateOnly(),
  time: hhmm().optional(),
  scenario: text(200).optional(),
  conductedBy: text(120).optional(),
  attendance: z.coerce.number().int().min(0).max(100000).default(0),
  evacuationMinutes: z.coerce.number().min(0).max(600).optional(),
  notes: text(2000).optional(),
  attachments: uploadIds(5).optional(),
});

export const createNoc = z
  .object({
    number: text(60).min(2),
    issuedBy: text(120).optional(),
    issueDate: dateOnly().optional(),
    expiryDate: dateOnly(),
    notes: text(500).optional(),
    documents: uploadIds(5).optional(),
  })
  .refine((v) => !v.issueDate || v.expiryDate > v.issueDate, { message: 'Expiry must be after the issue date', path: ['expiryDate'] });
