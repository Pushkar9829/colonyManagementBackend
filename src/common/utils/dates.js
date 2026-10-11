export const addHours = (date, hours) => new Date(new Date(date).getTime() + hours * 3600 * 1000);
export const addDays = (date, days) => new Date(new Date(date).getTime() + days * 86400 * 1000);


// "HH:MM" -> minutes since midnight
export const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

// Societies are in India for now; calendar dates (bookings, "today") follow IST, not the server clock.
export const APP_TIMEZONE = 'Asia/Kolkata';
const IST_OFFSET = '+05:30';

export const localDateString = (date = new Date()) => new Date(date).toLocaleDateString('en-CA', { timeZone: APP_TIMEZONE });
export const startOfLocalDay = (date = new Date()) => new Date(`${localDateString(date)}T00:00:00${IST_OFFSET}`);
export const localPeriod = (date = new Date()) => localDateString(date).slice(0, 7);
