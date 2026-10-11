// Standard chart of accounts every society starts with. Other modules post to these codes, so they are
// fixed ("system") accounts: they cannot be renamed, re-typed or deactivated.
export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'];

// The first digit of a code decides its type, so sub-accounts (e.g. 1001 second bank) stay in the right group.
export const TYPE_BY_DIGIT = { 1: 'asset', 2: 'liability', 3: 'equity', 4: 'income', 5: 'expense' };
export const typeOfCode = (code) => TYPE_BY_DIGIT[String(code)[0]];

// Debit-normal accounts grow with debits; the rest with credits.
export const DEBIT_NORMAL = new Set(['asset', 'expense']);
export const normalSide = (type) => (DEBIT_NORMAL.has(type) ? 'debit' : 'credit');

export const CODES = Object.freeze({
  BANK: '1000',
  CASH: '1010',
  MAINTENANCE_RECEIVABLE: '1100',
  OTHER_RECEIVABLES: '1150',
  VENDOR_PAYABLES: '2000',
  MEMBER_ADVANCES: '2100',
  SECURITY_DEPOSITS: '2110',
  TDS_PAYABLE: '2200',
  GST_PAYABLE: '2300',
  GENERAL_FUND: '3000',
  SINKING_FUND: '3100',
  REPAIR_FUND: '3200',
  OPENING_BALANCE_EQUITY: '3900',
  MAINTENANCE_INCOME: '4000',
  LATE_FEE_INCOME: '4100',
  AMENITY_INCOME: '4200',
  INTEREST_INCOME: '4300',
  OTHER_INCOME: '4900',
  SALARIES: '5000',
  SECURITY_SERVICES: '5100',
  HOUSEKEEPING: '5200',
  REPAIRS: '5300',
  ELECTRICITY: '5400',
  WATER: '5500',
  AMC: '5600',
  ADMIN_OFFICE: '5700',
  WAIVERS: '5800',
  OTHER_EXPENSES: '5900',
});

export const FUND_CODES = [CODES.GENERAL_FUND, CODES.SINKING_FUND, CODES.REPAIR_FUND];

export const STANDARD_CHART = [
  { code: '1000', name: 'Bank account', isBank: true },
  { code: '1010', name: 'Cash in hand', isCash: true },
  { code: '1100', name: 'Maintenance receivable' },
  { code: '1150', name: 'Other receivables' },
  { code: '2000', name: 'Vendor payables' },
  { code: '2100', name: 'Member advances' },
  { code: '2110', name: 'Security deposits held' },
  { code: '2200', name: 'TDS payable' },
  { code: '2300', name: 'GST payable' },
  { code: '3000', name: 'General fund' },
  { code: '3100', name: 'Sinking fund' },
  { code: '3200', name: 'Repair fund' },
  { code: '3900', name: 'Opening balance equity' },
  { code: '4000', name: 'Maintenance income' },
  { code: '4100', name: 'Late fee income' },
  { code: '4200', name: 'Amenity income' },
  { code: '4300', name: 'Interest income' },
  { code: '4900', name: 'Other income' },
  { code: '5000', name: 'Salaries & wages' },
  { code: '5100', name: 'Security services' },
  { code: '5200', name: 'Housekeeping' },
  { code: '5300', name: 'Repairs & maintenance' },
  { code: '5400', name: 'Electricity (common)' },
  { code: '5500', name: 'Water' },
  { code: '5600', name: 'AMC contracts' },
  { code: '5700', name: 'Admin & office' },
  { code: '5800', name: 'Waivers & write-offs' },
  { code: '5900', name: 'Other expenses' },
].map((a) => ({ ...a, type: typeOfCode(a.code), system: true }));

// Indian financial year (April–March). fyStart 2026 = 1 Apr 2026 .. 31 Mar 2027.
export const fyRange = (fyStart) => ({ from: `${fyStart}-04-01`, to: `${fyStart + 1}-03-31` });
export const fyLabel = (fyStart) => `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`;
export const fyOf = (isoDate) => {
  const [y, m] = isoDate.split('-').map(Number);
  return m >= 4 ? y : y - 1;
};
