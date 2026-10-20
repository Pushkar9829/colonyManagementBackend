// Default wish messages. Placeholders: {name}, {society}, {years} (age for birthdays, years married for anniversaries).
export const LANGUAGES = ['en', 'hi'];
export const PLACEHOLDERS = ['{name}', '{society}', '{years}'];

export const DEFAULT_TEMPLATES = {
  en: {
    birthday: 'Dear {name}, wishing you a very happy birthday! May the year ahead bring you joy and good health. Warm wishes from all of us at {society}.',
    anniversary: 'Dear {name}, happy anniversary! Congratulations on {years} wonderful years together. Warm wishes from all of us at {society}.',
  },
  hi: {
    birthday: 'प्रिय {name}, जन्मदिन की हार्दिक शुभकामनाएँ! आने वाला वर्ष आपके लिए खुशियाँ और अच्छा स्वास्थ्य लेकर आए। {society} परिवार की ओर से शुभकामनाएँ।',
    anniversary: 'प्रिय {name}, विवाह की वर्षगाँठ की हार्दिक बधाई! साथ के {years} सुंदर वर्षों के लिए {society} परिवार की ओर से शुभकामनाएँ।',
  },
};

export const TITLES = {
  en: { birthday: 'Happy birthday!', anniversary: 'Happy anniversary!' },
  hi: { birthday: 'जन्मदिन मुबारक!', anniversary: 'सालगिरह मुबारक!' },
};

export function render(template, { name, society, years }) {
  return String(template)
    .replaceAll('{name}', name || '')
    .replaceAll('{society}', society || '')
    .replaceAll('{years}', years == null ? '' : String(years))
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export const templateFor = (settings, kind) => settings.templates?.[kind] || DEFAULT_TEMPLATES[settings.language || 'en'][kind];
export const titleFor = (settings, kind) => TITLES[settings.language || 'en'][kind];
