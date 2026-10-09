// Pure matching logic: no sockets, no I/O, so it is easy to test.
// A "user" looks like: { id, clientId, interests: string[], blocked: Set<string> }

class Matcher {
  constructor({ fallbackMs = 10000 } = {}) {
    this.fallbackMs = fallbackMs; // after this wait, interests stop mattering
    this.queue = [];
  }

  get size() { return this.queue.length; }
  has(id) { return this.queue.some((u) => u.id === id); }

  static shared(a, b) {
    return a.interests.filter((i) => b.interests.includes(i));
  }

  _canPair(a, b) {
    return (
      a.id !== b.id &&
      a.clientId !== b.clientId &&          // same browser can't talk to itself
      !a.blocked.has(b.clientId) &&
      !b.blocked.has(a.clientId)
    );
  }

  _compatible(a, b, now) {
    if (!this._canPair(a, b)) return false;
    if (Matcher.shared(a, b).length > 0) return true;
    if (a.interests.length === 0 || b.interests.length === 0) return true; // "anyone" users
    return now - a.joinedAt >= this.fallbackMs || now - b.joinedAt >= this.fallbackMs;
  }

  _tryMatch(user, now) {
    let best = null, bestScore = -1;
    for (const other of this.queue) {
      if (other === user || !this._compatible(user, other, now)) continue;
      const score = Matcher.shared(user, other).length;
      // highest overlap wins; ties go to whoever has waited longest
      if (score > bestScore || (score === bestScore && other.joinedAt < best.joinedAt)) {
        best = other; bestScore = score;
      }
    }
    if (!best) return null;
    this.remove(user.id);
    this.remove(best.id);
    return { a: best, b: user, shared: Matcher.shared(user, best) };
  }

  // Add a user. Returns a match object if one was found immediately, else null.
  add(user, now = Date.now()) {
    if (this.has(user.id)) return null;
    const entry = { ...user, joinedAt: now };
    this.queue.push(entry);
    return this._tryMatch(entry, now);
  }

  remove(id) {
    this.queue = this.queue.filter((u) => u.id !== id);
  }

  // Call periodically: pairs up people whose wait exceeded fallbackMs.
  tick(now = Date.now()) {
    const matches = [];
    for (const u of [...this.queue]) {
      if (!this.has(u.id)) continue;
      const m = this._tryMatch(u, now);
      if (m) matches.push(m);
    }
    return matches;
  }
}

function normalizeInterests(raw) {
  if (!Array.isArray(raw)) return [];
  const out = new Set();
  for (const r of raw) {
    const t = String(r).toLowerCase().replace(/[^a-z0-9 ]/g, "").trim().slice(0, 20);
    if (t) out.add(t);
    if (out.size >= 5) break;
  }
  return [...out];
}

module.exports = { Matcher, normalizeInterests };