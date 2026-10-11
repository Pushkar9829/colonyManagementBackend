import Complaint from '../complaints/complaint.model.js';
import { COMPLAINT_CATEGORIES } from '../../common/constants/index.js';

// Complaint category suggestion — a keyword / term-frequency HEURISTIC, not machine learning.
// score(category) = Σ over words in the text of
//   2 × [word is in the built-in keyword list for the category]
// + 3 × (share of the society's past complaints in that category containing the word) × idf(word)
// where idf(word) = ln(1 + all past complaints / past complaints containing the word), so words that
// appear everywhere ("please", "flat") count little. Confidence = a category's share of the total score.

export const DEFAULT_KEYWORDS = {
  plumbing: ['leak', 'leakage', 'leaking', 'tap', 'pipe', 'drain', 'drainage', 'flush', 'toilet', 'commode', 'sink', 'basin', 'clog', 'clogged', 'blocked', 'block', 'choke', 'choked', 'seepage', 'geyser', 'shower', 'nal', 'sewage', 'overflow', 'plumber', 'washbasin'],
  electrical: ['light', 'lights', 'bulb', 'tube', 'switch', 'socket', 'plug', 'wire', 'wiring', 'fan', 'power', 'mcb', 'fuse', 'short', 'circuit', 'spark', 'sparking', 'shock', 'electric', 'electrical', 'electricity', 'bijli', 'inverter', 'meter', 'voltage', 'tripping', 'trip', 'electrician'],
  lift: ['lift', 'elevator', 'stuck', 'door', 'floor', 'button', 'jerk', 'jerking', 'alarm', 'cabin'],
  cleaning: ['garbage', 'trash', 'dustbin', 'bin', 'waste', 'dirty', 'dust', 'clean', 'cleaning', 'sweep', 'sweeping', 'mop', 'smell', 'stink', 'cockroach', 'pest', 'rats', 'rat', 'mosquito', 'housekeeping', 'kachra'],
  security: ['security', 'guard', 'theft', 'stolen', 'stranger', 'gate', 'cctv', 'camera', 'intruder', 'unknown', 'suspicious', 'safety', 'trespass', 'watchman'],
  parking: ['parking', 'park', 'parked', 'car', 'bike', 'scooter', 'vehicle', 'slot', 'blocked', 'wrong', 'tow', 'basement', 'sticker'],
  noise: ['noise', 'noisy', 'loud', 'music', 'party', 'barking', 'dog', 'drilling', 'construction', 'shouting', 'speaker', 'disturbance', 'night'],
  water: ['water', 'supply', 'pressure', 'tank', 'tanker', 'pani', 'drinking', 'muddy', 'dirty', 'motor', 'pump', 'shortage', 'cut', 'borewell', 'overhead'],
  other: [],
};

// Words that suggest the issue cannot wait.
const URGENT = ['fire', 'smoke', 'spark', 'sparking', 'shock', 'stuck', 'flood', 'flooding', 'gas', 'burst', 'collapse', 'injury', 'injured'];
const HIGH = ['leak', 'leakage', 'leaking', 'overflow', 'theft', 'stolen', 'blocked', 'broken'];

const STOP = new Set('a an the is are was were be been am i me my we our you your it its this that of to in on at for from with and or but not no please kindly since sir madam hi hello there here very also have has had do does did will would can could get got since day days today yesterday'.split(' '));

const stem = (w) => (w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w);

export function tokenize(text) {
  const words = String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
  return [...new Set(words)];
}

const KEYWORDS = Object.fromEntries(Object.entries(DEFAULT_KEYWORDS).map(([c, words]) => [c, new Set(words.flatMap((w) => [w, stem(w)]))]));

const MODEL_TTL = 10 * 60 * 1000;
const HISTORY = 1000;
const models = new Map();

// Term statistics from the society's own history (latest 1000 complaints), cached for 10 minutes.
async function societyModel(societyId) {
  const key = String(societyId);
  const hit = models.get(key);
  if (hit && hit.until > Date.now()) return hit.model;
  const past = await Complaint.find({ society: societyId }).sort({ createdAt: -1 }).limit(HISTORY).select('title description category').lean();
  const docs = {};
  const termDocs = {}; // category -> term -> count of complaints containing it
  const anyDocs = {}; // term -> count of complaints containing it
  for (const c of past) {
    docs[c.category] = (docs[c.category] || 0) + 1;
    termDocs[c.category] ||= {};
    for (const t of new Set(tokenize(`${c.title} ${c.description || ''}`).map(stem))) {
      termDocs[c.category][t] = (termDocs[c.category][t] || 0) + 1;
      anyDocs[t] = (anyDocs[t] || 0) + 1;
    }
  }
  const model = { total: past.length, docs, termDocs, anyDocs };
  models.set(key, { model, until: Date.now() + MODEL_TTL });
  return model;
}

export const clearModel = (societyId) => models.delete(String(societyId));

export function score(text, model) {
  const tokens = tokenize(text);
  const results = COMPLAINT_CATEGORIES.map((category) => {
    let s = 0;
    const matched = [];
    for (const t of tokens) {
      const st = stem(t);
      let w = KEYWORDS[category]?.has(t) || KEYWORDS[category]?.has(st) ? 2 : 0;
      const inCat = model.termDocs[category]?.[st] || 0;
      if (inCat && model.docs[category]) w += 3 * (inCat / model.docs[category]) * Math.log(1 + model.total / model.anyDocs[st]);
      if (w > 0) {
        s += w;
        matched.push(t);
      }
    }
    return { category, score: Math.round(s * 100) / 100, matched };
  });
  const total = results.reduce((t, r) => t + r.score, 0);
  const ranked = results
    .filter((r) => r.score > 0)
    .map((r) => ({ ...r, confidence: Math.round((r.score / total) * 100) / 100 }))
    .sort((a, b) => b.score - a.score);
  const priority = tokens.some((t) => URGENT.includes(t)) ? 'urgent' : tokens.some((t) => HIGH.includes(t)) ? 'high' : 'medium';
  return { tokens, ranked, priority };
}

export async function suggest(societyId, { title, description }) {
  const model = await societyModel(societyId);
  const { ranked, priority } = score(`${title || ''} ${description || ''}`, model);
  const suggestions = ranked.length ? ranked.slice(0, 3) : [{ category: 'other', score: 0, confidence: 0.2, matched: [] }];
  return {
    suggestions,
    suggestedPriority: priority,
    basedOn: { pastComplaints: model.total },
    method: 'heuristic',
    note: 'Keyword and term-frequency scoring over built-in keywords and this society’s past complaints. Not machine learning; always let the person choose.',
  };
}
