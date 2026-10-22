// Colony app templates: the look & feel a society picks for its members' app (Settings → Appearance).
// Code-defined so every instance agrees; bump CATALOGUE_VERSION (and the template's own `version`) when a
// template's design changes, so browsers that cached it (frontend lib/template.js) take the new one.
// Every palette must keep brand-600 at WCAG AA (4.5:1) against white — test/templates.test.js checks it.
export const CATALOGUE_VERSION = 1;

export const HEADER_STYLES = ['white', 'brand', 'gradient', 'transparent-on-cover'];
export const SIDEBAR_STYLES = ['light', 'brand', 'dark'];
export const LOGIN_LAYOUTS = ['split-photo', 'centered-card', 'full-cover', 'minimal'];
export const HOME_LAYOUTS = ['cards', 'tiles', 'list', 'hero'];
export const BUTTON_STYLES = ['solid', 'soft', 'outline'];
export const ICON_STYLES = ['circle', 'square'];
export const RADIUS_SCALES = ['sharp', 'medium', 'rounded', 'pill'];
export const SHADOW_STYLES = ['flat', 'soft', 'elevated'];
export const FONT_STYLES = ['modern', 'rounded', 'serif', 'condensed'];
export const SHADES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];

// System font stacks only (nothing is downloaded). Devanagari / Gurmukhi fall back to the OS font.
const SANS = "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
export const FONTS = Object.freeze({
  modern: { body: SANS, heading: SANS },
  rounded: {
    body: "ui-rounded, 'SF Pro Rounded', 'Nunito', 'Varela Round', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif",
    heading: "ui-rounded, 'SF Pro Rounded', 'Nunito', 'Varela Round', 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif",
  },
  serif: { body: SANS, heading: "Georgia, Cambria, 'Palatino Linotype', 'Times New Roman', ui-serif, serif" },
  condensed: {
    body: "'Segoe UI', system-ui, -apple-system, Roboto, 'Helvetica Neue', Arial, sans-serif",
    heading: "'Bahnschrift SemiCondensed', 'Bahnschrift', 'Roboto Condensed', 'Arial Narrow', 'Segoe UI', sans-serif",
  },
});

// Tailwind radius tokens (rounded-md / -lg / -xl / -2xl / -3xl read these variables).
export const RADII = Object.freeze({
  sharp: { sm: '0.125rem', md: '0.1875rem', lg: '0.25rem', xl: '0.25rem', '2xl': '0.375rem', '3xl': '0.5rem', button: '0.25rem' },
  medium: { sm: '0.25rem', md: '0.3125rem', lg: '0.4375rem', xl: '0.5625rem', '2xl': '0.75rem', '3xl': '1rem', button: '0.4375rem' },
  rounded: { sm: '0.25rem', md: '0.375rem', lg: '0.5rem', xl: '0.75rem', '2xl': '1rem', '3xl': '1.5rem', button: '0.5rem' },
  pill: { sm: '0.5rem', md: '0.625rem', lg: '0.875rem', xl: '1.125rem', '2xl': '1.5rem', '3xl': '2rem', button: '9999px' },
});

const scale = (values) => Object.freeze(Object.fromEntries(SHADES.map((s, i) => [s, values[i]])));

export const TEMPLATES = Object.freeze([
  {
    key: 'classic-blue',
    name: 'Classic Blue',
    description: 'The familiar ColonyHub look: calm indigo, white header and card dashboard.',
    tags: ['Light', 'Classic', 'Dark-friendly'],
    palette: {
      brand: scale(['#eef2ff', '#e0e7ff', '#c7d2fe', '#a5b4fc', '#818cf8', '#6366f1', '#4f46e5', '#4338ca', '#3730a3', '#312e81', '#1e1b4b']),
      accent: '#0ea5e9',
      successSurface: '#ecfdf5',
      warningSurface: '#fffbeb',
    },
    font: 'modern', radius: 'rounded', shadow: 'soft', header: 'white', sidebar: 'light', login: 'split-photo', home: 'cards', buttons: 'solid', icons: 'circle',
  },
  {
    key: 'royal-maroon',
    name: 'Royal Maroon',
    description: 'Deep maroon with gold accents, serif headings and a big cover banner on the home screen.',
    tags: ['Bold', 'Elegant', 'Dark-friendly'],
    palette: {
      brand: scale(['#fdf2f4', '#fbe4e8', '#f6c9d2', '#ee9fb0', '#e06a86', '#c93d61', '#9f1d3f', '#861634', '#6f132c', '#5c1227', '#340512']),
      accent: '#c08a1e',
      successSurface: '#f0fdf4',
      warningSurface: '#fef9e7',
    },
    font: 'serif', radius: 'medium', shadow: 'elevated', header: 'brand', sidebar: 'brand', login: 'full-cover', home: 'hero', buttons: 'solid', icons: 'circle',
  },
  {
    key: 'green-garden',
    name: 'Green Garden',
    description: 'Fresh greens, soft buttons and big icon tiles that are easy to tap.',
    tags: ['Light', 'Friendly', 'Dark-friendly'],
    palette: {
      brand: scale(['#ecfdf5', '#d1fae5', '#a7f3d0', '#6ee7b7', '#34d399', '#059669', '#047857', '#065f46', '#064e3b', '#053d2f', '#022c22']),
      accent: '#84cc16',
      successSurface: '#ecfdf5',
      warningSurface: '#fefce8',
    },
    font: 'rounded', radius: 'rounded', shadow: 'soft', header: 'white', sidebar: 'light', login: 'centered-card', home: 'tiles', buttons: 'soft', icons: 'square',
  },
  {
    key: 'night-sky',
    name: 'Night Sky',
    description: 'Dark-first: starts in dark mode, with a blue gradient header, dark menu and a compact list home.',
    tags: ['Dark', 'Dark-first', 'Modern'],
    darkFirst: true,
    palette: {
      brand: scale(['#eff6ff', '#dbeafe', '#bfdbfe', '#93c5fd', '#60a5fa', '#3b82f6', '#2563eb', '#1d4ed8', '#1e40af', '#1e3a8a', '#172554']),
      accent: '#8b5cf6',
      successSurface: '#ecfdf5',
      warningSurface: '#fffbeb',
    },
    font: 'modern', radius: 'rounded', shadow: 'elevated', header: 'gradient', sidebar: 'dark', login: 'full-cover', home: 'list', buttons: 'solid', icons: 'square',
  },
  {
    key: 'festive-saffron',
    name: 'Festive Saffron',
    description: 'Warm saffron and marigold for festival season, with a celebratory cover banner.',
    tags: ['Festive', 'Bold', 'Warm'],
    palette: {
      brand: scale(['#fff7ed', '#ffedd5', '#fed7aa', '#fdba74', '#fb923c', '#ea580c', '#c2410c', '#9a3412', '#7c2d12', '#6a2410', '#431407']),
      accent: '#e8a10c',
      successSurface: '#f0fdf4',
      warningSurface: '#fff7ed',
    },
    font: 'rounded', radius: 'rounded', shadow: 'soft', header: 'gradient', sidebar: 'brand', login: 'split-photo', home: 'hero', buttons: 'solid', icons: 'circle',
  },
  {
    key: 'ocean-teal',
    name: 'Ocean Teal',
    description: 'Cool teal with a coloured header and big tiles; a good match for partner brands.',
    tags: ['Light', 'Calm', 'Dark-friendly'],
    palette: {
      brand: scale(['#f0fdfa', '#ccfbf1', '#99f6e4', '#5eead4', '#2dd4bf', '#0d9488', '#0f766e', '#115e59', '#134e4a', '#123f3c', '#042f2e']),
      accent: '#0284c7',
      successSurface: '#ecfdf5',
      warningSurface: '#fffbeb',
    },
    font: 'modern', radius: 'medium', shadow: 'soft', header: 'brand', sidebar: 'light', login: 'centered-card', home: 'tiles', buttons: 'solid', icons: 'circle',
  },
  {
    key: 'lavender-calm',
    name: 'Lavender Calm',
    description: 'Soft violet, pill-shaped buttons and a clean, quiet list home.',
    tags: ['Light', 'Soft', 'Dark-friendly'],
    palette: {
      brand: scale(['#f5f3ff', '#ede9fe', '#ddd6fe', '#c4b5fd', '#a78bfa', '#8b5cf6', '#7c3aed', '#6d28d9', '#5b21b6', '#4c1d95', '#2e1065']),
      accent: '#ec4899',
      successSurface: '#f0fdf4',
      warningSurface: '#fefce8',
    },
    font: 'rounded', radius: 'pill', shadow: 'soft', header: 'white', sidebar: 'light', login: 'minimal', home: 'list', buttons: 'soft', icons: 'circle',
  },
  {
    key: 'earthy-terracotta',
    name: 'Earthy Terracotta',
    description: 'Clay and sand tones, serif headings, outline buttons and a classic card dashboard.',
    tags: ['Warm', 'Elegant', 'Light'],
    palette: {
      brand: scale(['#fdf6f3', '#f9e8e0', '#f2cdbd', '#e8a88f', '#d97c5c', '#c45c3b', '#a6482b', '#8a3b24', '#713221', '#5d2b1e', '#33140c']),
      accent: '#65a30d',
      successSurface: '#f3f8ec',
      warningSurface: '#fdf6e7',
    },
    font: 'serif', radius: 'medium', shadow: 'flat', header: 'white', sidebar: 'brand', login: 'split-photo', home: 'cards', buttons: 'outline', icons: 'square',
  },
  {
    key: 'slate-professional',
    name: 'Slate Professional',
    description: 'Steel blue-grey, sharp corners, condensed headings and a dark menu. No-nonsense.',
    tags: ['Professional', 'Minimal', 'Dark-friendly'],
    palette: {
      brand: scale(['#f2f5f8', '#e3e9ef', '#c7d3df', '#9fb2c6', '#7290ab', '#557491', '#435d78', '#384d63', '#304153', '#2b3846', '#1c242e']),
      accent: '#0891b2',
      successSurface: '#ecfdf5',
      warningSurface: '#fffbeb',
    },
    font: 'condensed', radius: 'sharp', shadow: 'flat', header: 'white', sidebar: 'dark', login: 'minimal', home: 'list', buttons: 'solid', icons: 'square',
  },
  {
    key: 'sunrise-gradient',
    name: 'Sunrise Gradient',
    description: 'Rose-to-amber gradients, pill buttons and a cover banner that greets members by name.',
    tags: ['Bold', 'Festive', 'Modern'],
    palette: {
      brand: scale(['#fff1f2', '#ffe4e6', '#fecdd3', '#fda4af', '#fb7185', '#f43f5e', '#e11d48', '#be123c', '#9f1239', '#881337', '#4c0519']),
      accent: '#f59e0b',
      successSurface: '#f0fdf4',
      warningSurface: '#fffbeb',
    },
    font: 'rounded', radius: 'pill', shadow: 'elevated', header: 'transparent-on-cover', sidebar: 'light', login: 'centered-card', home: 'hero', buttons: 'solid', icons: 'circle',
  },
].map((t) => Object.freeze({ version: 1, darkFirst: false, ...t, preview: `/templates/${t.key}.png`, previewPhone: `/templates/${t.key}-phone.png` })));

export const TEMPLATE_KEYS = TEMPLATES.map((t) => t.key);
export const DEFAULT_TEMPLATE = 'classic-blue';
export const templateByKey = (key) => TEMPLATES.find((t) => t.key === key) || null;

// Plans ordered cheapest first: a locked template says "Available on <first plan that has it>".
export const PLAN_ORDER = ['free', 'basic', 'standard', 'premium'];
export const RULE_PLANS = ['trial', ...PLAN_ORDER];

// Default per-plan allowance, used until the platform edits it (TemplatePlanRule rows override these).
const BASIC = ['classic-blue', 'green-garden', 'slate-professional'];
const STANDARD = [...BASIC, 'ocean-teal', 'royal-maroon', 'lavender-calm'];
export const DEFAULT_PLAN_TEMPLATES = Object.freeze({
  trial: TEMPLATE_KEYS,
  free: ['classic-blue'],
  basic: BASIC,
  standard: STANDARD,
  premium: TEMPLATE_KEYS,
});
