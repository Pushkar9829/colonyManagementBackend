import { SHADES } from './templates.catalogue.js';

const HEX = /^#[0-9a-fA-F]{6}$/;
export const isHex = (v) => typeof v === 'string' && HEX.test(v);

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, share) => toHex(rgb(a).map((v, i) => v * share + rgb(b)[i] * (1 - share)));

// WCAG 2.x relative luminance and contrast ratio.
export function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// A full 50–950 scale from one brand colour (used for a reseller's colour): the colour itself is 600,
// lighter shades mix in white, darker ones black.
const SHARE = { 50: 0.07, 100: 0.15, 200: 0.3, 300: 0.48, 400: 0.68, 500: 0.86, 700: 0.84, 800: 0.7, 900: 0.58, 950: 0.36 };
export function scaleFromColour(hex) {
  return Object.fromEntries(SHADES.map((s) => [s, s === '600' ? hex.toLowerCase() : Number(s) < 600 ? mix(hex, '#ffffff', SHARE[s]) : mix(hex, '#000000', SHARE[s])]));
}

// THE place that decides which colours a society's app uses: the template's palette, unless its white-label
// partner asked for its own brand colour to win (reseller.templates.brandOverridesTemplate). On a partner's
// login page with no society picked yet, the partner colour always shows (as before templates existed).
export function resolvePalette(template, reseller, { loginWithoutSociety = false } = {}) {
  const own = template.palette;
  const colour = reseller?.status === 'active' ? reseller.brand?.primaryColor : null;
  const override = isHex(colour) && (loginWithoutSociety || reseller.templates?.brandOverridesTemplate === true);
  return {
    brand: override ? scaleFromColour(colour) : { ...own.brand },
    accent: own.accent,
    successSurface: own.successSurface,
    warningSurface: own.warningSurface,
    source: override ? 'reseller' : 'template',
  };
}
