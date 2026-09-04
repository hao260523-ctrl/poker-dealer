/*
 * Poker dealer engine (no-limit hold'em, chips only).
 * Pure functions over a plain JSON-serialisable game object.
 * Works in the browser (window.PokerEngine) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PokerEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STREETS = ['preflop', 'flop', 'turn', 'river', 'showdown', 'done'];

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  // ---------- game creation ----------

  function defaultLevels(minutes) {
    const bbs = [50, 100, 150, 200, 300, 400, 600, 800, 1000, 1200, 1600, 2000, 3000, 4000, 6000, 8000, 10000];
    return bbs.map((bb) => ({ sb: bb / 2, bb, ante: bb, minutes }));
  }

  function createGame(cfg) {
    const players = cfg.players.map((p, i) => ({
      id: i + 1,
      name: (p.name || '').trim() || `P${i + 1}`,
      stack: Math.max(0, Math.floor(p.stack || 0)),
      buyIn: Math.max(0, Math.floor(p.stack || 0)),
      sitOut: false,
      out: false,
    }));
    const g = {
      version: 1,
      mode: cfg.mode === 'tournament' ? 'tournament' : 'cash',
      players,
      blinds: {
        sb: cfg.sb,
        bb: cfg.bb,
        ante: cfg.ante == null ? cfg.bb : cfg.ante,
        anteMode: cfg.anteMode || 'bb', // 'bb' | 'all' | 'none'
      },
      levels: null,
      levelIndex: 0,
      timer: null,
      dealerIdx: -1,
      firstDealer: typeof cfg.firstDealer === 'number' ? cfg.firstDealer : null,
      handNo: 0,
      hand: null,
      lastResult: null,
      createdAt: Date.now(),
    };
    if (g.mode === 'tournament') {
      g.levels = (cfg.levels && cfg.levels.length ? cfg.levels : defaultLevels(cfg.levelMinutes || 15)).map((l) => ({
        sb: l.sb, bb: l.bb, ante: l.ante == null ? l.bb : l.ante, minutes: l.minutes || cfg.levelMinutes || 15,
      }));
      g.levelIndex = 0;
      applyLevel(g, 0);
      g.timer = { remainingMs: g.levels[0].minutes * 60000, running: false, lastTick: null };
    }
    return g;
  }

  function applyLevel(g, idx) {
    if (!g.levels) return;
    idx = Math.max(0, Math.min(idx, g.levels.length - 1));
    g.levelIndex = idx;
    const l = g.levels[idx];
    g.blinds.sb = l.sb;
    g.blinds.bb = l.bb;
    g.blinds.ante = l.ante;
  }

  function setLevel(g, idx) {
    if (!g.levels) return;
    applyLevel(g, idx);
    g.timer.remainingMs = g.levels[g.levelIndex].minutes * 60000;
    g.timer.lastTick = g.timer.running ? Date.now() : null;
  }

  /** Advance the tournament clock. Returns true when the level changed. */
  function tickTimer(g, now) {
    if (!g.timer || !g.timer.running) return false;
    now = now == null ? Date.now() : now;
    const last = g.timer.lastTick == null ? now : g.timer.lastTick;
    g.timer.remainingMs -= now - last;
    g.timer.lastTick = now;
    if (g.timer.remainingMs <= 0) {
      if (g.levelIndex < g.levels.length - 1) {
        const carry = g.timer.remainingMs; // negative
        applyLevel(g, g.levelIndex + 1);
        g.timer.remainingMs = g.levels[g.levelIndex].minutes * 60000 + carry;
        return true;
      }
      g.timer.remainingMs = 0;
      g.timer.running = false;
    }
    return false;
  }

  function startTimer(g, now) {
    if (!g.timer) return;
    g.timer.running = true;
    g.timer.lastTick = now == null ? Date.now() : now;
  }

  function pauseTimer(g, now) {
    if (!g.timer) return;
    tickTimer(g, now);
    g.timer.running = false;
    g.timer.lastTick = null;
  }

  // ---------- helpers ----------

  function byId(g, id) { return g.players.find((p) => p.id === id); }
  function idxOf(g, id) { return g.players.findIndex((p) => p.id === id); }

  /** Players who can be dealt into the next hand. */
  function canBeDealt(p) { return !p.out && !p.sitOut && p.stack > 0; }

  function eligiblePlayers(g) { return g.players.filter(canBeDealt); }

  function canStartHand(g) { return eligiblePlayers(g).length >= 2; }

  /** Seat order starting AFTER index `from` (wrapping). */
  function orderAfter(g, from) {
    const n = g.players.length;
    const out = [];
    for (let k = 1; k <= n; k++) out.push((from + k) % n);
    return out;
  }

  function nextIdx(g, from, pred) {
    for (const i of orderAfter(g, from)) if (pred(g.players[i])) return i;
    return -1;
  }

  const H = {
    inHand: (h, id) => h.inHandIds.includes(id) && !h.folded[id],
    active: (h, id) => H.inHand(h, id) && !h.allIn[id],
  };

  function inHandIds(h) { return h.inHandIds.filter((id) => !h.folded[id]); }
  function activeIds(h) { return h.inHandIds.filter((id) => H.active(h, id)); }

  function pay(g, h, id, amount, isBet) {
    const p = byId(g, id);
    const a = Math.min(Math.max(0, amount), p.stack);
    p.stack -= a;
    h.committed[id] = (h.committed[id] || 0) + a;
    if (isBet) h.bets[id] = (h.bets[id] || 0) + a;
    if (p.stack === 0) h.allIn[id] = true;
    return a;
  }

  function totalPot(h) {
    return Object.values(h.committed).reduce((s, v) => s + v, 0);
  }

  // ---------- hand lifecycle ----------

  function startHand(g) {
    if (!canStartHand(g)) throw new Error('プレイ可能なプレイヤーが2人以上必要です');
    // dealer button
    let dealerIdx;
    if (g.dealerIdx === -1) {
      if (g.firstDealer != null && canBeDealt(g.players[g.firstDealer])) dealerIdx = g.firstDealer;
      else {
        const el = eligiblePlayers(g);
        dealerIdx = idxOf(g, el[Math.floor(Math.random() * el.length)].id);
      }
    } else {
      dealerIdx = nextIdx(g, g.dealerIdx, canBeDealt);
    }
    const prevDealerIdx = g.dealerIdx;
    g.dealerIdx = dealerIdx;
    g.handNo += 1;

    const ids = [];
    // seat order starting from left of dealer, dealer last
    for (const i of orderAfter(g, dealerIdx)) if (canBeDealt(g.players[i])) ids.push(g.players[i].id);

    const { sb, bb, ante, anteMode } = g.blinds;
    const h = {
      no: g.handNo,
      prevDealerIdx,
      dealerId: g.players[dealerIdx].id,
      sbId: null,
      bbId: null,
      street: 'preflop',
      inHandIds: ids,
      bets: {},
      committed: {},
      folded: {},
      allIn: {},
      currentBet: 0,
      minRaise: bb,
      needToAct: [],
      acted: {},
      toAct: null,
      blinds: { sb, bb, ante, anteMode },
      actions: [],
      result: null,
      runout: false,
    };
    const headsUp = ids.length === 2;
    if (headsUp) {
      h.sbId = h.dealerId;
      h.bbId = ids[0];
    } else {
      h.sbId = ids[0];
      h.bbId = ids[1];
    }

    // antes
    if (anteMode === 'all' && ante > 0) {
      for (const id of ids) pay(g, h, id, ante, false);
    }
    // blinds
    pay(g, h, h.sbId, sb, true);
    pay(g, h, h.bbId, bb, true);
    if (anteMode === 'bb' && ante > 0) pay(g, h, h.bbId, ante, false); // blind first, then ante

    h.currentBet = bb;
    h.minRaise = bb;
    h.needToAct = activeIds(h);
    // first to act preflop: UTG (after BB); heads-up: dealer/SB
    h.toAct = firstToActAfter(g, h, idxOf(g, h.bbId));
    g.hand = h;
    g.lastResult = null;
    h.actions.push({ type: 'start', dealer: h.dealerId, sb: h.sbId, bb: h.bbId });
    checkRoundEnd(g, h, null);
    return h;
  }

  function firstToActAfter(g, h, fromIdx) {
    for (const i of orderAfter(g, fromIdx)) {
      const id = g.players[i].id;
      if (h.needToAct.includes(id)) return id;
    }
    return null;
  }

  /** Legal actions for the player to act. */
  function legalActions(g) {
    const h = g.hand;
    if (!h || h.toAct == null) return null;
    const id = h.toAct;
    const p = byId(g, id);
    const bet = h.bets[id] || 0;
    const owed = h.currentBet - bet;
    const callAmount = Math.min(owed, p.stack);
    const canCheck = owed <= 0;
    const raiseAllowed = !h.acted[id] || !h.raiseClosed; // players who acted before an incomplete all-in cannot re-raise
    const maxTo = bet + p.stack;
    const minTo = Math.min(h.currentBet + h.minRaise, maxTo);
    const canRaise = raiseAllowed && p.stack > Math.max(0, owed) && maxTo > h.currentBet;
    return {
      playerId: id,
      canCheck,
      callAmount: canCheck ? 0 : callAmount,
      callIsAllIn: !canCheck && callAmount >= p.stack,
      canRaise,
      minRaiseTo: minTo,
      maxRaiseTo: maxTo,
      pot: totalPot(h),
      currentBet: h.currentBet,
      myBet: bet,
      stack: p.stack,
    };
  }

  /**
   * Apply an action. type: 'fold' | 'check' | 'call' | 'raise' (amount = raise TO total this street) | 'allin'
   */
  function act(g, type, amount) {
    const h = g.hand;
    if (!h || h.toAct == null) throw new Error('アクションできる状態ではありません');
    const la = legalActions(g);
    const id = h.toAct;
    const p = byId(g, id);
    let record = { type, id };

    switch (type) {
      case 'fold':
        h.folded[id] = true;
        break;
      case 'check':
        if (!la.canCheck) throw new Error('チェックできません');
        break;
      case 'call': {
        if (la.canCheck) throw new Error('コールする額がありません');
        record.amount = pay(g, h, id, la.callAmount, true);
        break;
      }
      case 'allin':
        amount = la.maxRaiseTo;
      // fallthrough
      case 'raise': {
        let to = Math.floor(amount);
        if (!(to > h.currentBet)) {
          // all-in for less than a call is a call
          if (type === 'allin') { record = { type: 'call', id, amount: pay(g, h, id, la.callAmount, true), allIn: true }; break; }
          throw new Error('レイズ額が不正です');
        }
        if (!la.canRaise) throw new Error('レイズできません');
        if (to >= la.maxRaiseTo) to = la.maxRaiseTo; // all-in
        else if (to < la.minRaiseTo) throw new Error(`最低レイズ額は ${la.minRaiseTo} です`);
        const raiseBy = to - h.currentBet;
        const full = raiseBy >= h.minRaise;
        pay(g, h, id, to - la.myBet, true);
        if (full) {
          h.minRaise = raiseBy;
          h.acted = {};
          h.raiseClosed = false;
        } else {
          // incomplete all-in raise: does not reopen betting for those who already acted
          h.raiseClosed = true;
        }
        h.currentBet = to;
        h.needToAct = activeIds(h).filter((x) => x !== id);
        record.amount = to;
        record.allIn = !!h.allIn[id];
        break;
      }
      default:
        throw new Error('不明なアクション');
    }
    h.acted[id] = true;
    h.needToAct = h.needToAct.filter((x) => x !== id && H.active(h, x));
    h.actions.push(record);
    h.lastAction = record;
    checkRoundEnd(g, h, id);
    return record;
  }

  function checkRoundEnd(g, h, lastActorId) {
    const remaining = inHandIds(h);
    if (remaining.length === 1) {
      // everyone else folded
      finishHand(g, h, [{ amount: totalPot(h), eligible: remaining, winners: remaining }]);
      return;
    }
    if (h.needToAct.length > 0) {
      if (lastActorId != null) h.toAct = firstToActAfter(g, h, idxOf(g, lastActorId));
      return;
    }
    advanceStreet(g, h);
  }

  function advanceStreet(g, h) {
    h.bets = {};
    h.currentBet = 0;
    h.minRaise = h.blinds.bb;
    h.acted = {};
    h.raiseClosed = false;
    h.needToAct = [];
    h.toAct = null;
    const active = activeIds(h);
    const idx = STREETS.indexOf(h.street);
    if (h.street === 'river' || active.length <= 1) {
      h.runout = h.street !== 'river' && active.length <= 1;
      h.street = 'showdown';
      const pots = computePots(g);
      // auto-award when nobody needs to choose (only one eligible in every pot)
      if (pots.every((pt) => pt.eligible.length === 1)) {
        finishHand(g, h, pots.map((pt) => ({ ...pt, winners: pt.eligible })));
      }
      return;
    }
    h.street = STREETS[idx + 1];
    h.needToAct = active;
    h.toAct = firstToActAfter(g, h, idxOf(g, h.dealerId));
  }

  /** Main / side pots from committed amounts. */
  function computePots(g) {
    const h = g.hand;
    const contenders = inHandIds(h);
    const levels = [...new Set(Object.values(h.committed).filter((v) => v > 0))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const lv of levels) {
      let amount = 0;
      for (const id of Object.keys(h.committed)) {
        const c = h.committed[id];
        amount += Math.max(0, Math.min(c, lv) - prev);
      }
      const eligible = contenders.filter((id) => (h.committed[id] || 0) >= lv);
      prev = lv;
      if (amount === 0) continue;
      if (eligible.length === 0) {
        // money only from folded players above everyone else's commitment -> goes to previous pot
        if (pots.length) pots[pots.length - 1].amount += amount;
        continue;
      }
      const last = pots[pots.length - 1];
      if (last && last.eligible.length === eligible.length && last.eligible.every((x, i) => x === eligible[i])) {
        last.amount += amount;
      } else {
        pots.push({ amount, eligible });
      }
    }
    return pots;
  }

  /**
   * Award pots. winnersPerPot[i] = array of player ids (split pot when >1).
   */
  function awardPots(g, winnersPerPot) {
    const h = g.hand;
    if (!h || h.street !== 'showdown') throw new Error('ショーダウンではありません');
    const pots = computePots(g);
    if (winnersPerPot.length !== pots.length) throw new Error('ポット数が一致しません');
    const awarded = pots.map((pt, i) => {
      let w = (winnersPerPot[i] || []).filter((id) => pt.eligible.includes(id));
      if (!w.length && pt.eligible.length === 1) w = pt.eligible.slice();
      if (!w.length) throw new Error(`ポット${i + 1}の勝者を選んでください`);
      return { ...pt, winners: w };
    });
    finishHand(g, h, awarded);
  }

  function finishHand(g, h, awardedPots) {
    const won = {};
    // odd chips go to the first winner left of the dealer
    const order = orderAfter(g, idxOf(g, h.dealerId)).map((i) => g.players[i].id);
    for (const pt of awardedPots) {
      const ws = order.filter((id) => pt.winners.includes(id));
      const share = Math.floor(pt.amount / ws.length);
      let rem = pt.amount - share * ws.length;
      for (const id of ws) {
        let a = share;
        if (rem > 0) { a += 1; rem -= 1; }
        byId(g, id).stack += a;
        won[id] = (won[id] || 0) + a;
      }
    }
    h.result = { pots: awardedPots, won };
    h.street = 'done';
    h.toAct = null;
    h.needToAct = [];
    g.lastResult = { handNo: h.no, won, pots: awardedPots };
    // tournament: bust players
    if (g.mode === 'tournament') {
      for (const p of g.players) if (!p.out && p.stack === 0) { p.out = true; p.bustHand = h.no; }
    }
    // per-hand checkpoint (stacks right after the hand) for review / recovery
    g.handLog = g.handLog || [];
    g.handLog.push({ no: h.no, dealerId: h.dealerId, won, stacks: g.players.map((p) => [p.id, p.stack]), at: Date.now() });
    if (g.handLog.length > 500) g.handLog.shift();
  }

  /** Roll the table back to the state right after hand `no` finished (stacks, button, hand counter). */
  function restoreToHand(g, no) {
    const rec = (g.handLog || []).find((r) => r.no === no);
    if (!rec) throw new Error('その履歴が見つかりません');
    for (const [id, stack] of rec.stacks) { const p = byId(g, id); if (p) p.stack = stack; }
    g.hand = null;
    g.handNo = no;
    g.dealerIdx = idxOf(g, rec.dealerId);
    g.handLog = g.handLog.filter((r) => r.no <= no);
    g.lastResult = { handNo: no, won: rec.won, pots: [] };
    if (g.mode === 'tournament') {
      for (const p of g.players) {
        if (p.stack > 0 && p.out) { p.out = false; delete p.bustHand; }
        if (p.stack === 0 && !p.out) { p.out = true; p.bustHand = no; }
      }
    }
  }

  function endHand(g) {
    if (g.hand && g.hand.street !== 'done') throw new Error('ハンドが終わっていません');
    g.hand = null;
  }

  /** Misdeal: refund every chip committed this hand and put the button back. */
  function cancelHand(g) {
    const h = g.hand;
    if (!h) return;
    if (h.street !== 'done') {
      for (const id of Object.keys(h.committed)) byId(g, Number(id)).stack += h.committed[id];
      g.dealerIdx = h.prevDealerIdx;
      g.handNo -= 1;
    }
    g.hand = null;
  }

  // ---------- table management ----------

  function addChips(g, id, amount) {
    const p = byId(g, id);
    amount = Math.floor(amount);
    if (!(amount > 0)) throw new Error('金額が不正です');
    p.stack += amount;
    p.buyIn += amount;
    if (g.mode === 'tournament' && p.out) p.out = false;
  }

  function addPlayer(g, name, stack) {
    const id = Math.max(0, ...g.players.map((p) => p.id)) + 1;
    g.players.push({ id, name: (name || '').trim() || `P${id}`, stack: Math.floor(stack), buyIn: Math.floor(stack), sitOut: false, out: false });
    return id;
  }

  function setBlinds(g, sb, bb, ante, anteMode) {
    g.blinds.sb = sb; g.blinds.bb = bb;
    if (ante != null) g.blinds.ante = ante;
    if (anteMode) g.blinds.anteMode = anteMode;
  }

  function summary(g) {
    return g.players.map((p) => ({ id: p.id, name: p.name, buyIn: p.buyIn, stack: p.stack, net: p.stack - p.buyIn, out: p.out, bustHand: p.bustHand || null }))
      .sort((a, b) => b.net - a.net);
  }

  return {
    STREETS, clone, defaultLevels, createGame, applyLevel, setLevel, tickTimer, startTimer, pauseTimer,
    byId, idxOf, eligiblePlayers, canStartHand, startHand, legalActions, act, computePots, awardPots, endHand, cancelHand, restoreToHand,
    addChips, addPlayer, setBlinds, summary, totalPot, inHandIds, activeIds,
  };
});
