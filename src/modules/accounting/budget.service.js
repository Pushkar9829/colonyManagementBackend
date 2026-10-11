import Budget from './budget.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { localDateString } from '../../common/utils/dates.js';
import * as audit from '../audit/audit.service.js';
import { fyLabel, fyRange } from './chart.js';
import { accountsByCode } from './ledger.service.js';
import { balancesByCode, naturalBalance, refresh } from './accounting.service.js';

const BUDGET_TYPES = ['income', 'expense'];

export async function getBudget(ctx, fyStart) {
  const rows = await Budget.find({ society: ctx.societyId, fyStart }).sort({ code: 1 }).lean();
  return { fyStart, label: fyLabel(fyStart), ...fyRange(fyStart), lines: rows.map((r) => ({ code: r.code, amount: r.amount, notes: r.notes })) };
}

// Replaces the budget lines given (other accounts keep their budget). amount 0 removes a line.
export async function saveBudget(ctx, fyStart, { lines }) {
  const accounts = await accountsByCode(ctx.societyId);
  for (const l of lines) {
    const a = accounts.get(l.code);
    if (!a) throw ApiError.badRequest(`Unknown account ${l.code}`);
    if (!BUDGET_TYPES.includes(a.type)) throw ApiError.badRequest(`Budgets are for income and expense accounts; ${l.code} is ${a.type}`);
  }
  const ops = lines.map((l) =>
    l.amount > 0
      ? {
        updateOne: {
          filter: { society: ctx.societyId, fyStart, code: l.code },
          update: { $set: { amount: l.amount, notes: l.notes, updatedBy: ctx.userId } },
          upsert: true,
        },
      }
      : { deleteOne: { filter: { society: ctx.societyId, fyStart, code: l.code } } },
  );
  if (ops.length) await Budget.bulkWrite(ops);
  audit.record(ctx, 'budget.saved', 'Budget', undefined, { fy: fyLabel(fyStart), lines: lines.length });
  refresh(ctx.societyId);
  return getBudget(ctx, fyStart);
}

// Budget vs actual for the financial year. Actuals run to today for the current year.
// variance = actual - budget; variancePct relative to budget (null without a budget).
export async function budgetVsActual(ctx, fyStart) {
  const range = fyRange(fyStart);
  const today = localDateString();
  const to = today < range.to ? today : range.to;
  const accounts = await accountsByCode(ctx.societyId);
  const [budgets, actuals] = await Promise.all([
    Budget.find({ society: ctx.societyId, fyStart }).lean(),
    to >= range.from ? balancesByCode(ctx.societyId, { from: range.from, to }) : Promise.resolve(new Map()),
  ]);
  const budgetBy = new Map(budgets.map((b) => [b.code, b.amount]));
  // Share of the year elapsed: lets the UI show a pro-rated budget to date.
  const days = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000) + 1;
  const elapsed = to >= range.from ? Math.min(1, days(range.from, to) / days(range.from, range.to)) : 0;

  const section = (type) =>
    [...accounts.values()]
      .filter((a) => a.type === type)
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((a) => {
        const budget = budgetBy.get(a.code) || 0;
        const actual = naturalBalance(a.type, actuals.get(a.code));
        const variance = actual - budget;
        return {
          code: a.code,
          name: a.name,
          type,
          budget,
          budgetToDate: Math.round(budget * elapsed),
          actual,
          variance,
          variancePct: budget ? Math.round((variance / budget) * 1000) / 10 : null,
        };
      })
      .filter((r) => r.budget || r.actual);
  const income = section('income');
  const expenses = section('expense');
  const sum = (rows, k) => rows.reduce((s, r) => s + r[k], 0);
  const totals = (rows) => {
    const budget = sum(rows, 'budget');
    const actual = sum(rows, 'actual');
    return { budget, budgetToDate: sum(rows, 'budgetToDate'), actual, variance: actual - budget, variancePct: budget ? Math.round(((actual - budget) / budget) * 1000) / 10 : null };
  };
  return { fyStart, label: fyLabel(fyStart), from: range.from, to, elapsedPct: Math.round(elapsed * 1000) / 10, income, expenses, totals: { income: totals(income), expenses: totals(expenses) } };
}
