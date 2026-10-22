import Account from './account.model.js';
import JournalEntry from './journalEntry.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { escapeRegex } from '../../common/utils/strings.js';
import * as audit from '../audit/audit.service.js';
import { invalidate } from '../../realtime/socket.js';
import { ROLES } from '../../common/constants/index.js';
import { CODES, normalSide, typeOfCode } from './chart.js';
import { accountsByCode, ensureChart, postEntry, reverseEntry, reverseEntryById } from './ledger.service.js';

// Public posting API for other modules.
export { ensureChart, postEntry, reverseEntry } from './ledger.service.js';

const FINANCE_ROLES = [ROLES.ADMIN, ROLES.ACCOUNTANT];
export const refresh = (societyId) => invalidate(societyId, ['accounting'], { roles: FINANCE_ROLES });

// ---------- chart of accounts ----------

// Balance per account code up to (and including) `to`, as { code: { debit, credit } }.
export async function balancesByCode(societyId, { from, to } = {}) {
  const match = { society: societyId };
  if (from || to) match.date = { ...(from && { $gte: from }), ...(to && { $lte: to }) };
  const rows = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    { $group: { _id: '$lines.code', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ]);
  return new Map(rows.map((r) => [r._id, { debit: r.debit, credit: r.credit }]));
}

export const naturalBalance = (type, { debit = 0, credit = 0 } = {}) => (normalSide(type) === 'debit' ? debit - credit : credit - debit);

export async function listAccounts(ctx, filters = {}) {
  await ensureChart(ctx.societyId);
  const filter = { society: ctx.societyId };
  if (filters.type) filter.type = filters.type;
  if (filters.active !== undefined) filter.active = filters.active;
  if (filters.bank) filter.$or = [{ isBank: true }, { isCash: true }];
  const accounts = await Account.find(filter).sort({ code: 1 }).lean();
  if (!filters.withBalances) return accounts;
  const balances = await balancesByCode(ctx.societyId, { to: filters.asOf });
  return accounts.map((a) => ({ ...a, balance: naturalBalance(a.type, balances.get(a.code)) }));
}

export async function createAccount(ctx, data) {
  await ensureChart(ctx.societyId);
  const type = typeOfCode(data.code);
  if (!type) throw ApiError.badRequest('Account code must start with 1-5 (asset, liability, fund, income, expense)');
  if (data.parent) {
    const parent = await Account.findOne({ society: ctx.societyId, code: data.parent }).lean();
    if (!parent) throw ApiError.badRequest('Parent account {code} not found', { params: { code: data.parent } });
    if (parent.type !== type) throw ApiError.badRequest('A sub-account must be of the same type as its parent');
  }
  if ((data.isBank || data.isCash) && type !== 'asset') throw ApiError.badRequest('Bank and cash accounts must be asset accounts (1xxx)');
  try {
    const account = await Account.create({
      society: ctx.societyId,
      code: data.code,
      name: data.name,
      type,
      parent: data.parent,
      description: data.description,
      isBank: Boolean(data.isBank),
      isCash: Boolean(data.isCash),
      bankDetails: data.isBank ? data.bankDetails : undefined,
      system: false,
      createdBy: ctx.userId,
    });
    audit.record(ctx, 'account.created', 'Account', account._id, { code: account.code, name: account.name });
    refresh(ctx.societyId);
    return account.toObject();
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('Account code {code} is already used', { params: { code: data.code } });
    throw err;
  }
}

export async function updateAccount(ctx, id, data) {
  const account = await Account.findOne({ _id: id, society: ctx.societyId });
  if (!account) throw ApiError.notFound('Account not found');
  if (account.system) {
    // Standard accounts are relied on by automatic postings; only bank details of 1000 may change.
    const onlyBank = Object.keys(data).every((k) => k === 'bankDetails');
    if (!(onlyBank && account.isBank)) throw ApiError.conflict('Standard accounts are locked');
  }
  for (const k of ['name', 'description', 'active']) if (data[k] !== undefined) account[k] = data[k];
  if (data.bankDetails !== undefined && account.isBank) account.bankDetails = data.bankDetails;
  await account.save();
  audit.record(ctx, 'account.updated', 'Account', account._id, { code: account.code, changes: Object.keys(data) });
  refresh(ctx.societyId);
  return account.toObject();
}

// ---------- journal ----------

const ENTRY_POPULATE = [
  { path: 'createdBy', select: 'name' },
  { path: 'lines.unit', select: 'label' },
  { path: 'lines.vendor', select: 'name' },
];

async function withAccountNames(societyId, entries) {
  const accounts = await accountsByCode(societyId);
  const name = (code) => accounts.get(code)?.name || code;
  return entries.map((e) => ({ ...e, lines: e.lines.map((l) => ({ ...l, accountName: name(l.code) })) }));
}

export async function listJournals(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.from || filters.to) filter.date = { ...(filters.from && { $gte: filters.from }), ...(filters.to && { $lte: filters.to }) };
  if (filters.sourceType) filter.sourceType = filters.sourceType === 'manual' ? { $exists: false } : filters.sourceType;
  if (filters.kind) filter.kind = filters.kind;
  if (filters.code) filter['lines.code'] = filters.code;
  if (filters.search) {
    const rx = new RegExp(escapeRegex(filters.search), 'i');
    filter.$or = [{ narration: rx }, { number: rx }, { reference: rx }];
  }
  const result = await paginate(JournalEntry, filter, pagination, { sort: { date: -1, number: -1 }, populate: ENTRY_POPULATE });
  result.items = await withAccountNames(ctx.societyId, result.items);
  return result;
}

export async function getJournal(ctx, id) {
  const entry = await JournalEntry.findOne({ _id: id, society: ctx.societyId }).populate([...ENTRY_POPULATE, { path: 'reversedBy', select: 'number date' }, { path: 'reversalOf', select: 'number date' }]).lean();
  if (!entry) throw ApiError.notFound('Journal entry not found');
  const [withNames] = await withAccountNames(ctx.societyId, [entry]);
  return withNames;
}

export async function createManualEntry(ctx, data) {
  const entry = await postEntry(ctx, {
    date: data.date,
    narration: data.narration,
    reference: data.reference,
    kind: 'manual',
    lines: data.lines.map((l) => ({ accountCode: l.code, debit: l.debit, credit: l.credit, unit: l.unit, vendor: l.vendor, memo: l.memo })),
  });
  audit.record(ctx, 'journal.created', 'JournalEntry', entry._id, { number: entry.number, total: entry.total });
  refresh(ctx.societyId);
  return getJournal(ctx, entry._id);
}

// Automatic postings are corrected at their source (cancel the bill, bounce the payment ...),
// otherwise the next sync would disagree with the ledger.
const REVERSIBLE_KINDS = ['manual', 'opening'];
const REVERSIBLE_SOURCES = [undefined, 'opening_balance', 'bank_line'];

export async function reverseManualEntry(ctx, id, { reason, date }) {
  const entry = await JournalEntry.findOne({ _id: id, society: ctx.societyId }).lean();
  if (!entry) throw ApiError.notFound('Journal entry not found');
  if (!REVERSIBLE_KINDS.includes(entry.kind) && !REVERSIBLE_SOURCES.includes(entry.sourceType)) {
    throw ApiError.conflict('Automatic entries are reversed by cancelling their source document');
  }
  if (entry.sourceType === 'bank_line') throw ApiError.conflict('Unmatch the bank statement line to undo this entry');
  if (entry.reversedBy) throw ApiError.conflict('This entry is already reversed');
  const reversal = await reverseEntryById(ctx, id, reason, date);
  audit.record(ctx, 'journal.reversed', 'JournalEntry', entry._id, { number: entry.number, reversal: reversal.number, reason });
  refresh(ctx.societyId);
  return getJournal(ctx, reversal._id);
}

// ---------- opening balances ----------

// Opening balances are one journal against 3900 Opening balance equity. Only one may be live at a time;
// to change them, reverse the current one and post again.
const liveOpening = (societyId) => JournalEntry.findOne({ society: societyId, sourceType: 'opening_balance', reversedBy: null }).lean();

export async function getOpeningBalances(ctx) {
  const entry = await liveOpening(ctx.societyId);
  if (!entry) return null;
  const [withNames] = await withAccountNames(ctx.societyId, [entry]);
  return withNames;
}

export async function postOpeningBalances(ctx, { date, lines }) {
  if (await liveOpening(ctx.societyId)) throw ApiError.conflict('Opening balances are already posted. Reverse them first to post again.');
  const accounts = await accountsByCode(ctx.societyId);
  const out = [];
  let net = 0; // debit - credit
  for (const l of lines) {
    const account = accounts.get(l.code);
    if (!account) throw ApiError.badRequest('Unknown account {code}', { params: { code: l.code } });
    if (l.code === CODES.OPENING_BALANCE_EQUITY) throw ApiError.badRequest('3900 is balanced automatically');
    if (!['asset', 'liability', 'equity'].includes(account.type)) throw ApiError.badRequest('Opening balances are for balance-sheet accounts; {code} is {type}', { params: { code: l.code, type: account.type } });
    if (!l.debit && !l.credit) continue;
    out.push({ accountCode: l.code, debit: l.debit || 0, credit: l.credit || 0 });
    net += (l.debit || 0) - (l.credit || 0);
  }
  if (!out.length) throw ApiError.badRequest('Enter at least one opening balance');
  if (net > 0) out.push({ accountCode: CODES.OPENING_BALANCE_EQUITY, credit: net });
  if (net < 0) out.push({ accountCode: CODES.OPENING_BALANCE_EQUITY, debit: -net });
  if (out.length < 2) throw ApiError.badRequest('Opening balances need at least two accounts when they already balance');
  const previous = await JournalEntry.countDocuments({ society: ctx.societyId, sourceType: 'opening_balance' });
  const entry = await postEntry(ctx, {
    date,
    narration: 'Opening balances',
    kind: 'opening',
    sourceType: 'opening_balance',
    sourceId: `opening-${previous + 1}`,
    lines: out,
  });
  audit.record(ctx, 'journal.opening_balances', 'JournalEntry', entry._id, { number: entry.number, total: entry.total });
  refresh(ctx.societyId);
  return getJournal(ctx, entry._id);
}
