// SaaS billing of societies by the platform owner. All amounts in integer paise.
export const PLAN_NAMES = ['free', 'basic', 'standard', 'premium'];

// monthly / quarterly / yearly repeat every CYCLE_MONTHS; one_time is a single payment for a fixed term
// (oneTimeValidityMonths) or for life (no validity), renewed by a new one-time invoice when a term ends.
export const BILLING_CYCLES = ['monthly', 'quarterly', 'yearly', 'one_time'];
export const RECURRING_CYCLES = ['monthly', 'quarterly', 'yearly'];
export const CYCLE_MONTHS = Object.freeze({ monthly: 1, quarterly: 3, yearly: 12 });
export const CYCLE_LABELS = Object.freeze({ monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly', one_time: 'One-time' });

// A lifetime licence is "paid until" this date, so every date comparison keeps working.
export const LIFETIME_UNTIL = new Date('2100-01-01T00:00:00+05:30');
export const isLifetime = (date) => Boolean(date) && new Date(date) >= LIFETIME_UNTIL;

// Used until the super admin saves a price list. perUnitMonthly is charged per unit per month,
// flatMonthly once per society per month; both can be combined. oneTimePrice 0 = no one-time option.
export const DEFAULT_PRICES = Object.freeze({
  free: { perUnitMonthly: 0, flatMonthly: 0, quarterlyDiscountPercent: 0, yearlyDiscountPercent: 0, oneTimePrice: 0, oneTimeValidityMonths: null },
  basic: { perUnitMonthly: 1000, flatMonthly: 0, quarterlyDiscountPercent: 5, yearlyDiscountPercent: 10, oneTimePrice: 0, oneTimeValidityMonths: null },
  standard: { perUnitMonthly: 1500, flatMonthly: 50000, quarterlyDiscountPercent: 5, yearlyDiscountPercent: 10, oneTimePrice: 0, oneTimeValidityMonths: null },
  premium: { perUnitMonthly: 2500, flatMonthly: 100000, quarterlyDiscountPercent: 5, yearlyDiscountPercent: 15, oneTimePrice: 0, oneTimeValidityMonths: null },
});

export const GST_RATE = 18; // percent, on every platform invoice
export const DEFAULT_GRACE_DAYS = 7;
export const DEFAULT_DUE_DAYS = 10;
export const REMIND_BEFORE_DAYS = 3;
export const REMIND_EVERY_DAYS = 3;
