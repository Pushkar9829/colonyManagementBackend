// SaaS billing of societies by the platform owner. All amounts in integer paise.
export const PLAN_NAMES = ['free', 'basic', 'standard', 'premium'];
export const BILLING_CYCLES = ['monthly', 'yearly'];

// Used until the super admin saves a price list. perUnitMonthly is charged per unit per month,
// flatMonthly once per society per month; both can be combined.
export const DEFAULT_PRICES = Object.freeze({
  free: { perUnitMonthly: 0, flatMonthly: 0, yearlyDiscountPercent: 0 },
  basic: { perUnitMonthly: 1000, flatMonthly: 0, yearlyDiscountPercent: 10 },
  standard: { perUnitMonthly: 1500, flatMonthly: 50000, yearlyDiscountPercent: 10 },
  premium: { perUnitMonthly: 2500, flatMonthly: 100000, yearlyDiscountPercent: 15 },
});

export const GST_RATE = 18; // percent, on every platform invoice
export const DEFAULT_GRACE_DAYS = 7;
export const DEFAULT_DUE_DAYS = 10;
export const REMIND_BEFORE_DAYS = 3;
export const REMIND_EVERY_DAYS = 3;
