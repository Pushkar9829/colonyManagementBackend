// All money is stored as integer paise. These helpers convert at the API edge.
export const toPaise = (rupees) => Math.round(Number(rupees) * 100);
export const toRupees = (paise) => Math.round(paise) / 100;

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
export const money = (paise) => inr.format((paise || 0) / 100);
