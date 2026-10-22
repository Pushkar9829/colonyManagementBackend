// Core double-entry posting API. Other modules call postEntry / reverseEntry / ensureChart
// (re-exported from accounting.service.js); everything here works on a ctx = { societyId, userId }.
import mongoose from 'mongoose';
import Account from './account.model.js';
import JournalEntry from './journalEntry.model.js';
import ApiError from '../../common/errors/ApiError.js';
import logger from '../../common/utils/logger.js';
import { localDateString } from '../../common/utils/dates.js';
import { nextNumber } from '../counter/counter.service.js';
import { STANDARD_CHART } from './chart.js';

const ensured = new Set();

// Creates any missing standard accounts for the society. Cheap after the first call (cached per process).
export async function ensureChart(societyId) {
  const key = String(societyId);
  if (ensured.has(key)) return;
  const existing = await Account.countDocuments({ society: societyId, system: true });
  if (existing < STANDARD_CHART.length) {
    await Account.bulkWrite(
      STANDARD_CHART.map((a) => ({
        updateOne: {
          filter: { society: societyId, code: a.code },
          update: { $setOnInsert: { society: societyId, ...a, active: true } },
          upsert: true,
        },
      })),
      { ordered: false },
    ).catch((err) => {
      // a concurrent first use may race on the unique index; the accounts exist either way
      if (err.code !== 11000 && !err.writeErrors?.every((e) => e.code === 11000)) throw err;
    });
  }
  ensured.add(key);
}

// Test helper / tenant reset: forget the cache so the next call re-checks the database.
export const forgetChartCache = () => ensured.clear();

export async function accountsByCode(societyId) {
  await ensureChart(societyId);
  const accounts = await Account.find({ society: societyId }).lean();
  return new Map(accounts.map((a) => [a.code, a]));
}

const isInt = (n) => Number.isInteger(n) && n >= 0;

// Validates and normalises lines: drops zero lines, checks accounts exist and the entry balances.
async function buildLines(societyId, lines, { allowInactive }) {
  if (!Array.isArray(lines)) throw ApiError.badRequest('Entry lines are required');
  const accounts = await accountsByCode(societyId);
  const out = [];
  for (const l of lines) {
    const debit = Math.round(Number(l.debit || 0));
    const credit = Math.round(Number(l.credit || 0));
    if (!isInt(debit) || !isInt(credit)) throw ApiError.badRequest('Debit and credit must be positive amounts in paise');
    if (debit && credit) throw ApiError.badRequest('A line can have a debit or a credit, not both');
    if (!debit && !credit) continue;
    const code = String(l.accountCode ?? l.code ?? '');
    const account = accounts.get(code);
    if (!account) throw ApiError.badRequest('Unknown account {code}', { params: { code } });
    if (!account.active && !allowInactive) throw ApiError.badRequest('Account {code} {name} is inactive', { params: { code, name: account.name } });
    out.push({
      account: account._id,
      code,
      debit,
      credit,
      unit: l.unit || undefined,
      vendor: l.vendor || undefined,
      memo: l.memo || undefined,
    });
  }
  const dr = out.reduce((s, l) => s + l.debit, 0);
  const cr = out.reduce((s, l) => s + l.credit, 0);
  if (out.length < 2) throw ApiError.badRequest('An entry needs at least one debit and one credit line');
  if (dr !== cr) throw ApiError.badRequest('Entry does not balance: debits {debits} ≠ credits {credits} (paise)', { params: { debits: dr, credits: cr } });
  if (dr <= 0) throw ApiError.badRequest('Entry total must be more than zero');
  return { lines: out, total: dr };
}

const findBySource = (societyId, sourceType, sourceId) =>
  JournalEntry.findOne({ society: societyId, sourceType, sourceId: String(sourceId) });

/**
 * Posts a balanced journal entry. When sourceType + sourceId are given the call is idempotent:
 * posting the same source twice returns the existing entry instead of creating another.
 *   postEntry(ctx, { date, narration, sourceType, sourceId, sourceRef?, reference?, kind?,
 *                    lines: [{ accountCode, debit, credit, unit?, vendor?, memo? }] })
 * Amounts are integer paise. Returns the entry (lean) with `created: boolean`.
 */
export async function postEntry(ctx, data) {
  const societyId = ctx.societyId;
  const sourceId = data.sourceId != null ? String(data.sourceId) : undefined;
  if (sourceId && !data.sourceType) throw ApiError.badRequest('sourceType is required with sourceId');
  if (sourceId) {
    const existing = await findBySource(societyId, data.sourceType, sourceId).lean();
    if (existing) return { ...existing, created: false };
  }
  const narration = String(data.narration || '').trim();
  if (!narration) throw ApiError.badRequest('Narration is required');
  const date = data.date ? String(data.date).slice(0, 10) : localDateString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw ApiError.badRequest('Date must be YYYY-MM-DD');

  const kind = data.kind || (sourceId ? 'auto' : 'manual');
  const { lines, total } = await buildLines(societyId, data.lines, { allowInactive: kind !== 'manual' });
  try {
    const entry = await JournalEntry.create({
      society: societyId,
      number: await nextNumber(societyId, 'journal', 'JV'),
      date,
      narration: narration.slice(0, 500),
      reference: data.reference || undefined,
      kind,
      sourceType: data.sourceType || undefined,
      sourceId,
      sourceRef: data.sourceRef != null ? String(data.sourceRef) : sourceId,
      lines,
      total,
      reversalOf: data.reversalOf,
      reversalReason: data.reversalReason,
      createdBy: ctx.userId || undefined,
    });
    return { ...entry.toObject(), created: true };
  } catch (err) {
    // Two syncs racing on the same source: the unique index lets exactly one win.
    if (err.code === 11000 && sourceId) {
      const existing = await findBySource(societyId, data.sourceType, sourceId).lean();
      if (existing) return { ...existing, created: false };
    }
    throw err;
  }
}

// Reverses an entry document: posts the mirror image and links both. Idempotent.
async function reverseDoc(ctx, original, reason, date) {
  if (original.reversalOf) throw ApiError.conflict('A reversing entry cannot itself be reversed');
  if (original.reversedBy) {
    const existing = await JournalEntry.findById(original.reversedBy).lean();
    if (existing) return { ...existing, created: false };
  }
  const reversal = await postEntry(ctx, {
    date: date || localDateString(),
    narration: `Reversal of ${original.number}${reason ? `: ${reason}` : ''}`,
    kind: 'reversal',
    sourceType: 'reversal',
    sourceId: String(original._id),
    sourceRef: original.sourceRef,
    reference: original.reference,
    reversalOf: original._id,
    reversalReason: reason,
    lines: original.lines.map((l) => ({ accountCode: l.code, debit: l.credit, credit: l.debit, unit: l.unit, vendor: l.vendor, memo: l.memo })),
  });
  await JournalEntry.updateOne({ _id: original._id, society: ctx.societyId }, { reversedBy: reversal._id, reversalReason: reason });
  return reversal;
}

/**
 * Reverses the entry posted for a source document (e.g. a cancelled bill). Returns the reversing
 * entry, or null when nothing was posted for that source. Safe to call repeatedly.
 */
export async function reverseEntry(ctx, sourceType, sourceId, reason, date) {
  const original = await findBySource(ctx.societyId, sourceType, sourceId).lean();
  if (!original) return null;
  return reverseDoc(ctx, original, reason, date);
}

export async function reverseEntryById(ctx, id, reason, date) {
  if (!mongoose.isValidObjectId(id)) throw ApiError.notFound('Journal entry not found');
  const original = await JournalEntry.findOne({ _id: id, society: ctx.societyId }).lean();
  if (!original) throw ApiError.notFound('Journal entry not found');
  return reverseDoc(ctx, original, reason, date);
}

// Reverses every live (not yet reversed) entry for a source document — used when a bill with
// later late-fee entries is cancelled.
export async function reverseAllForRef(ctx, sourceRef, sourceTypes, reason, date) {
  const entries = await JournalEntry.find({
    society: ctx.societyId,
    sourceRef: String(sourceRef),
    sourceType: { $in: sourceTypes },
    reversedBy: null,
    reversalOf: null,
  }).lean();
  const out = [];
  for (const e of entries) {
    // eslint-disable-next-line no-await-in-loop
    out.push(await reverseDoc(ctx, e, reason, date).catch((err) => {
      logger.error({ err, entry: e.number }, 'reversal failed');
      return null;
    }));
  }
  return out.filter(Boolean);
}
