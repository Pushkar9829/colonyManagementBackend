import crypto from 'node:crypto';
import Block from '../units/block.model.js';
import Unit from '../units/unit.model.js';
import Society from '../society/society.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { ROLES, RESIDENT_TYPES, UNIT_TYPES } from '../../common/constants/index.js';
import * as unitsService from '../units/units.service.js';
import * as usersService from '../users/users.service.js';
import { sendInvite } from '../auth/password.service.js';
import * as audit from '../audit/audit.service.js';
import { readSheet, templateBuffer } from './sheet.js';

const ROLE_ALIASES = {
  resident: ROLES.RESIDENT,
  owner: ROLES.RESIDENT,
  tenant: ROLES.RESIDENT,
  admin: ROLES.ADMIN,
  committee: ROLES.ADMIN,
  accountant: ROLES.ACCOUNTANT,
  treasurer: ROLES.ACCOUNTANT,
  facilitymanager: ROLES.FACILITY_MANAGER,
  manager: ROLES.FACILITY_MANAGER,
  guard: ROLES.GUARD,
  security: ROLES.GUARD,
  staff: ROLES.STAFF,
};

export const KINDS = {
  units: {
    columns: ['Block', 'Unit number', 'Floor', 'Type', 'Area sqft'],
    sample: [['A', '101', 1, 'flat', 1100], ['A', '102', 1, 'flat', 1100], ['B', 'G01', 0, 'shop', 400]],
  },
  members: {
    columns: ['Name', 'Email', 'Phone', 'Role', 'Unit', 'Resident type', 'Designation'],
    sample: [
      ['Ravi Iyer', 'ravi@example.com', '9876543210', 'resident', 'A-101', 'owner', ''],
      ['Ramesh Yadav', '', '9876500001', 'guard', '', '', 'Main gate'],
    ],
  },
};

export const template = (kind) => templateBuffer(KINDS[kind].columns, KINDS[kind].sample);

// ---------- validation (no writes) ----------
async function checkUnits(ctx, rows) {
  const seen = new Set();
  return rows.map((r) => {
    const errors = [];
    const block = (r.block || '').toUpperCase();
    const number = (r.unitnumber || r.unit || '').toUpperCase();
    if (!block) errors.push('Block is required');
    if (!number) errors.push('Unit number is required');
    const type = (r.type || 'flat').toLowerCase();
    if (!UNIT_TYPES.includes(type)) errors.push(`Type must be one of ${UNIT_TYPES.join(', ')}`);
    const floor = r.floor === '' || r.floor === undefined ? undefined : Number(r.floor);
    if (floor !== undefined && !Number.isInteger(floor)) errors.push('Floor must be a whole number');
    const area = r.areasqft ? Number(r.areasqft) : 0;
    if (Number.isNaN(area) || area < 0) errors.push('Area must be a number');
    const key = `${block}-${number}`;
    if (seen.has(key)) errors.push('Duplicate row in this file');
    seen.add(key);
    return { row: r._row, label: key, data: { block, number, floor, type, areaSqft: area }, errors };
  });
}

async function checkMembers(ctx, rows) {
  const units = await Unit.find({ society: ctx.societyId }).select('label').lean();
  const byLabel = new Map(units.map((u) => [u.label.toUpperCase(), u._id]));
  return rows.map((r) => {
    const errors = [];
    const role = ROLE_ALIASES[(r.role || 'resident').toLowerCase().replace(/[^a-z]/g, '')];
    if (!role) errors.push(`Unknown role "${r.role}"`);
    if (!r.name || r.name.length < 2) errors.push('Name is required');
    const email = r.email ? r.email.toLowerCase() : undefined;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Email looks invalid');
    const phone = r.phone ? r.phone.replace(/[^\d+]/g, '') : undefined;
    if (phone && !/^\+?\d{10,13}$/.test(phone)) errors.push('Phone must be 10–13 digits');
    if (!email && !phone) errors.push('Email or phone is required');
    let unit;
    let residentType;
    if (role === ROLES.RESIDENT) {
      unit = byLabel.get((r.unit || '').toUpperCase().replace(/\s+/g, ''));
      if (!unit) errors.push(`Unit "${r.unit || ''}" not found — import units first`);
      // "tenant" in the Role column implies the resident type when that column is blank
      residentType = (r.residenttype || ((r.role || '').toLowerCase() === 'tenant' ? 'tenant' : 'owner')).toLowerCase();
      if (!RESIDENT_TYPES.includes(residentType)) errors.push(`Resident type must be ${RESIDENT_TYPES.join(', ')}`);
    }
    return {
      row: r._row,
      label: r.name || `Row ${r._row}`,
      data: { name: r.name, email, phone, role, unit, residentType, designation: r.designation || undefined },
      errors,
    };
  });
}

const CHECKS = { units: checkUnits, members: checkMembers };

export async function preview(ctx, kind, file) {
  const rows = await readSheet(file);
  const checked = await CHECKS[kind](ctx, rows);
  const valid = checked.filter((r) => !r.errors.length).length;
  return { total: checked.length, valid, invalid: checked.length - valid, rows: checked.slice(0, 500) };
}

// ---------- apply ----------
export async function commit(ctx, kind, file) {
  const rows = await readSheet(file);
  const checked = await CHECKS[kind](ctx, rows);
  const results = [];

  if (kind === 'units') {
    const blocks = new Map((await Block.find({ society: ctx.societyId }).lean()).map((b) => [b.name, b]));
    for (const r of checked.filter((x) => !x.errors.length)) {
      try {
        let block = blocks.get(r.data.block);
        if (!block) {
          // eslint-disable-next-line no-await-in-loop
          block = await unitsService.createBlock(ctx, { name: r.data.block });
          blocks.set(block.name, block);
        }
        // eslint-disable-next-line no-await-in-loop
        if (await Unit.exists({ society: ctx.societyId, block: block._id, number: r.data.number })) {
          results.push({ row: r.row, label: r.label, status: 'skipped', message: 'Already exists' });
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        await unitsService.createUnit(ctx, { block: block._id, number: r.data.number, floor: r.data.floor, type: r.data.type, areaSqft: r.data.areaSqft });
        results.push({ row: r.row, label: r.label, status: 'created' });
      } catch (err) {
        results.push({ row: r.row, label: r.label, status: 'failed', message: err.message });
        if (err.code === 'PLAN_LIMIT') break;
      }
    }
  }

  if (kind === 'members') {
    const society = await Society.findById(ctx.societyId).select('name').lean();
    for (const r of checked.filter((x) => !x.errors.length)) {
      try {
        // New accounts get a random password and an emailed invite to set their own.
        const password = crypto.randomBytes(18).toString('base64url');
        // eslint-disable-next-line no-await-in-loop
        const member = await usersService.create(ctx, { ...r.data, password });
        // eslint-disable-next-line no-await-in-loop
        if (r.data.email) await sendInvite(member.user, society.name).catch(() => null);
        results.push({ row: r.row, label: r.label, status: 'created' });
      } catch (err) {
        results.push({ row: r.row, label: r.label, status: err.status === 409 ? 'skipped' : 'failed', message: err.message });
      }
    }
  }

  for (const r of checked.filter((x) => x.errors.length)) results.push({ row: r.row, label: r.label, status: 'invalid', message: r.errors.join('; ') });
  results.sort((a, b) => a.row - b.row);
  const count = (s) => results.filter((r) => r.status === s).length;
  const summary = { created: count('created'), skipped: count('skipped'), failed: count('failed'), invalid: count('invalid') };
  audit.record(ctx, `import.${kind}`, 'Society', ctx.societyId, summary);
  return { ...summary, results };
}

export function assertKind(kind) {
  if (!KINDS[kind]) throw ApiError.notFound('Unknown import type');
}
