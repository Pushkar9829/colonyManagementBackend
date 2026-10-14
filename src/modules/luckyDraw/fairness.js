import crypto from 'node:crypto';

// The verifiable draw, kept free of database code so anyone can re-run it from the published numbers.
//
// 1. When a draw opens we pick a secret 32-byte random seed and publish only SHA-256(seed) — the "sealed code".
// 2. When entries close we publish entriesHash = SHA-256 of the active entry ids, sorted, one per line.
// 3. Each entry gets a score = HMAC-SHA256(key = seed, message = entry id). Entries are ordered by score
//    (lowest first). Nobody can predict or steer the scores without the seed, and the seed was fixed
//    before anyone entered.
// 4. Prizes are given in the order they are listed, one per person (one per flat in per-flat draws),
//    walking down that order; the next people in the order become the reserves.
// 5. After the draw the seed is revealed: anyone can check SHA-256(seed) matches the sealed code and
//    recompute every score.

export const ALGORITHM =
  'Seed: 32 random bytes written as 64 hex characters, sealed by publishing SHA-256(seed) when entries open. ' +
  'entriesHash = SHA-256 of the active entry ids sorted ascending and joined with "\\n". ' +
  'score(entry) = HMAC-SHA256(key = seed text, message = entry id), hex. ' +
  'Entries are sorted by score ascending (ties by entry id). Prizes are assigned in listed order, each prize ' +
  'quantity filled from the top of that order, skipping anyone (or, in per-flat draws, any flat) that already won. ' +
  'The next entrants in the order become the reserves.';

export const sha256 = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');

export const newSeed = () => crypto.randomBytes(32).toString('hex');

export const score = (seed, entryId) => crypto.createHmac('sha256', String(seed)).update(String(entryId), 'utf8').digest('hex');

export const entriesHash = (entryIds) => sha256(entryIds.map(String).sort().join('\n'));

// [{ entryId, score }] in draw order.
export function order(seed, entryIds) {
  return entryIds
    .map((id) => ({ entryId: String(id), score: score(seed, id) }))
    .sort((a, b) => (a.score < b.score ? -1 : a.score > b.score ? 1 : a.entryId < b.entryId ? -1 : 1));
}

// entries: [{ _id, user, unit, ... }]; prizes: [{ _id, quantity }]
// Returns { results: [{ prize, winners: [{ entry, position }] }], reserves: [{ entry, position }], ordered }.
export function assign(seed, entries, prizes, { perFlat = false, reserves = 0 } = {}) {
  const byId = new Map(entries.map((e) => [String(e._id), e]));
  const ordered = order(seed, [...byId.keys()]);
  const takenUsers = new Set();
  const takenUnits = new Set();
  let cursor = 0;
  const next = () => {
    while (cursor < ordered.length) {
      const position = cursor + 1;
      const entry = byId.get(ordered[cursor].entryId);
      cursor += 1;
      const userKey = String(entry.user);
      const unitKey = entry.unit ? String(entry.unit) : null;
      if (takenUsers.has(userKey) || (perFlat && unitKey && takenUnits.has(unitKey))) continue;
      takenUsers.add(userKey);
      if (unitKey) takenUnits.add(unitKey);
      return { entry, position };
    }
    return null;
  };
  const results = prizes.map((p) => {
    const winners = [];
    for (let i = 0; i < p.quantity; i += 1) {
      const w = next();
      if (!w) break;
      winners.push(w);
    }
    return { prize: p._id, winners };
  });
  const reserveList = [];
  for (let i = 0; i < reserves; i += 1) {
    const r = next();
    if (!r) break;
    reserveList.push(r);
  }
  return { results, reserves: reserveList, ordered };
}
