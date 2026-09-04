/*
 * Cards: deck, shuffle, 7-card hand evaluation.
 * Card = 2-char string, rank in '23456789TJQKA', suit in 'shdc' (e.g. 'As', 'Td').
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PokerCards = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RANKS = '23456789TJQKA';
  const SUITS = 'shdc';
  const CATEGORIES = ['high_card', 'pair', 'two_pair', 'three_kind', 'straight', 'flush', 'full_house', 'four_kind', 'straight_flush'];

  function newDeck() {
    const d = [];
    for (const s of SUITS) for (const r of RANKS) d.push(r + s);
    return d;
  }

  function randomInt(n) {
    const g = typeof globalThis !== 'undefined' ? globalThis : self;
    const c = g.crypto || (typeof require === 'function' ? require('crypto').webcrypto : null);
    if (c && c.getRandomValues) {
      const buf = new Uint32Array(1);
      const limit = Math.floor(0x100000000 / n) * n;
      let x;
      do { c.getRandomValues(buf); x = buf[0]; } while (x >= limit);
      return x % n;
    }
    return Math.floor(Math.random() * n);
  }

  /** In-place Fisher-Yates shuffle with a CSPRNG. */
  function shuffle(deck, rnd) {
    rnd = rnd || randomInt;
    for (let i = deck.length - 1; i > 0; i--) {
      const j = rnd(i + 1);
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }

  const rankOf = (c) => RANKS.indexOf(c[0]) + 2; // 2..14
  const suitOf = (c) => c[1];

  /** Evaluate exactly 5 cards -> { cat, tb (tiebreak values, high first) }. */
  function evaluate5(cards) {
    const vals = cards.map(rankOf).sort((a, b) => b - a);
    const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]));
    const counts = {};
    for (const v of vals) counts[v] = (counts[v] || 0) + 1;
    const groups = Object.keys(counts).map(Number).sort((a, b) => counts[b] - counts[a] || b - a);
    const uniq = [...new Set(vals)];
    let straightHigh = 0;
    if (uniq.length === 5) {
      if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
      else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5; // wheel
    }
    if (flush && straightHigh) return { cat: 8, tb: [straightHigh] };
    if (counts[groups[0]] === 4) return { cat: 7, tb: [groups[0], groups[1]] };
    if (counts[groups[0]] === 3 && counts[groups[1]] === 2) return { cat: 6, tb: [groups[0], groups[1]] };
    if (flush) return { cat: 5, tb: vals };
    if (straightHigh) return { cat: 4, tb: [straightHigh] };
    if (counts[groups[0]] === 3) return { cat: 3, tb: groups };
    if (counts[groups[0]] === 2 && counts[groups[1]] === 2) return { cat: 2, tb: groups };
    if (counts[groups[0]] === 2) return { cat: 1, tb: groups };
    return { cat: 0, tb: vals };
  }

  function score(ev) {
    let s = ev.cat;
    for (let i = 0; i < 5; i++) s = s * 15 + (ev.tb[i] || 0);
    return s;
  }

  /** Best 5-card hand out of 5..7 cards -> { score, cat, name, best }. Higher score wins. */
  function evaluate(cards) {
    if (cards.length < 5) throw new Error('need at least 5 cards');
    let best = null;
    const n = cards.length;
    const idx = [0, 1, 2, 3, 4];
    const combos = [];
    (function rec(start, chosen) {
      if (chosen.length === 5) { combos.push(chosen.slice()); return; }
      for (let i = start; i < n; i++) { chosen.push(i); rec(i + 1, chosen); chosen.pop(); }
    })(0, []);
    for (const c of combos) {
      const hand = c.map((i) => cards[i]);
      const ev = evaluate5(hand);
      const sc = score(ev);
      if (!best || sc > best.score) best = { score: sc, cat: ev.cat, name: CATEGORIES[ev.cat], best: hand };
    }
    void idx;
    return best;
  }

  /** Winners among {id: cards[]} (7 cards each) -> array of ids with the top score. */
  function winners(handsById) {
    let top = -1;
    let ids = [];
    for (const id of Object.keys(handsById)) {
      const sc = evaluate(handsById[id]).score;
      if (sc > top) { top = sc; ids = [id]; } else if (sc === top) ids.push(id);
    }
    return ids;
  }

  return { RANKS, SUITS, CATEGORIES, newDeck, shuffle, evaluate, evaluate5, winners, rankOf, suitOf };
});
