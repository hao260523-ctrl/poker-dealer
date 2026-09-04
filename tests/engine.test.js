const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');

function game(stacks, opts = {}) {
  return E.createGame({
    mode: 'cash', sb: 1, bb: 2, anteMode: 'none', ante: 0, firstDealer: 0,
    players: stacks.map((s, i) => ({ name: 'P' + (i + 1), stack: s })),
    ...opts,
  });
}
const stacks = (g) => g.players.map((p) => p.stack);

test('3-handed: blinds, action order, everyone calls, BB checks -> flop', () => {
  const g = game([100, 100, 100]);
  const h = E.startHand(g);
  assert.equal(h.dealerId, 1);
  assert.equal(h.sbId, 2);
  assert.equal(h.bbId, 3);
  assert.equal(h.toAct, 1); // UTG = dealer in 3-handed
  assert.deepEqual(stacks(g), [100, 99, 98]);
  E.act(g, 'call');
  assert.equal(h.toAct, 2);
  E.act(g, 'call');
  assert.equal(h.toAct, 3);
  assert.equal(E.legalActions(g).canCheck, true);
  E.act(g, 'check');
  assert.equal(h.street, 'flop');
  assert.equal(h.toAct, 2); // SB first postflop
  assert.equal(E.totalPot(h), 6);
});

test('heads-up: dealer is SB and acts first preflop, BB first postflop', () => {
  const g = game([50, 50]);
  const h = E.startHand(g);
  assert.equal(h.sbId, 1);
  assert.equal(h.bbId, 2);
  assert.equal(h.toAct, 1);
  E.act(g, 'call');
  E.act(g, 'check');
  assert.equal(h.street, 'flop');
  assert.equal(h.toAct, 2);
});

test('everyone folds to BB -> BB wins pot without showdown', () => {
  const g = game([100, 100, 100]);
  const h = E.startHand(g);
  E.act(g, 'fold');
  E.act(g, 'fold');
  assert.equal(h.street, 'done');
  assert.deepEqual(stacks(g), [100, 99, 101]);
});

test('min raise tracking and re-raise', () => {
  const g = game([500, 500, 500]);
  const h = E.startHand(g);
  let la = E.legalActions(g);
  assert.equal(la.minRaiseTo, 4);
  E.act(g, 'raise', 10); // raise by 8
  la = E.legalActions(g);
  assert.equal(la.playerId, 2);
  assert.equal(la.callAmount, 9);
  assert.equal(la.minRaiseTo, 18);
  E.act(g, 'raise', 30); // raise by 20
  la = E.legalActions(g);
  assert.equal(la.playerId, 3);
  assert.equal(la.minRaiseTo, 50);
  assert.throws(() => E.act(g, 'raise', 40));
  E.act(g, 'call');
  assert.equal(h.toAct, 1); // original raiser must act again
  E.act(g, 'call');
  assert.equal(h.street, 'flop');
  assert.equal(E.totalPot(h), 90);
});

test('incomplete all-in raise does not reopen action for players who already acted', () => {
  const g = game([500, 500, 15, 500]);
  const h = E.startHand(g);
  // dealer=1, sb=2, bb=3, utg=4
  E.act(g, 'raise', 10); // P4 raises to 10 (by 8)
  E.act(g, 'call'); // P1 calls
  E.act(g, 'call'); // P2 calls 9
  // P3 (BB, 15 total) shoves: to 15 = raise by 5 < minRaise 8 => incomplete
  assert.equal(h.toAct, 3);
  E.act(g, 'allin');
  assert.equal(h.currentBet, 15);
  assert.equal(h.toAct, 4);
  let la = E.legalActions(g);
  assert.equal(la.canRaise, false);
  assert.equal(la.callAmount, 5);
  E.act(g, 'call');
  E.act(g, 'call');
  E.act(g, 'call');
  assert.equal(h.street, 'flop');
  assert.deepEqual(E.activeIds(h), [2, 4, 1]);
});

test('side pots with three all-ins and a folder', () => {
  const g = game([100, 30, 60, 100, 100]);
  const h = E.startHand(g);
  // dealer=1 sb=2 bb=3 utg=4
  E.act(g, 'allin'); // P4 100
  E.act(g, 'fold'); // P5
  E.act(g, 'allin'); // P1 100
  E.act(g, 'allin'); // P2 30
  E.act(g, 'allin'); // P3 60
  assert.equal(h.street, 'showdown');
  assert.equal(h.runout, true);
  const pots = E.computePots(g);
  assert.deepEqual(pots, [
    { amount: 120, eligible: [2, 3, 4, 1] },
    { amount: 90, eligible: [3, 4, 1] },
    { amount: 80, eligible: [4, 1] },
  ]);
  E.awardPots(g, [[2], [3], [4, 1]]);
  assert.deepEqual(stacks(g), [40, 120, 90, 40, 100]);
});

test('folded player money that exceeds contenders goes to last pot', () => {
  const g = game([100, 100, 20]);
  const h = E.startHand(g);
  // dealer=1 sb=2 bb=3 ; utg=1
  E.act(g, 'raise', 50); // P1 to 50
  E.act(g, 'call'); // P2 calls 50
  E.act(g, 'allin'); // P3 20
  assert.equal(h.street, 'flop');
  E.act(g, 'raise', 50); // P2 bets 50 on flop
  E.act(g, 'fold'); // P1 folds -> P2 wins everything? no: P3 is all-in, so showdown between P2 and P3
  assert.equal(h.street, 'showdown');
  const pots = E.computePots(g);
  assert.deepEqual(pots, [
    { amount: 60, eligible: [2, 3] },
    { amount: 110, eligible: [2] },
  ]);
  E.awardPots(g, [[3], [2]]);
  assert.deepEqual(stacks(g), [50, 110, 60]);
});

test('split pot: odd chip goes to first winner left of dealer', () => {
  const g = game([100, 100, 100]);
  const h = E.startHand(g);
  E.act(g, 'raise', 5);
  E.act(g, 'call');
  E.act(g, 'call'); // pot 15
  for (let i = 0; i < 9; i++) E.act(g, 'check');
  assert.equal(h.street, 'showdown');
  E.awardPots(g, [[1, 2]]);
  assert.deepEqual(stacks(g), [102, 103, 95]);
});

test('BB ante: blind then ante, dead money counts toward pot', () => {
  const g = game([100, 100, 100], { anteMode: 'bb', ante: 2 });
  const h = E.startHand(g);
  assert.deepEqual(stacks(g), [100, 99, 96]);
  assert.equal(E.totalPot(h), 5);
  assert.equal(E.legalActions(g).callAmount, 2);
});

test('all-player ante', () => {
  const g = game([100, 100, 100], { anteMode: 'all', ante: 1 });
  const h = E.startHand(g);
  assert.deepEqual(stacks(g), [99, 98, 97]);
  assert.equal(E.totalPot(h), 6);
});

test('short BB all-in from posting is skipped in action', () => {
  const g = game([100, 100, 1]);
  const h = E.startHand(g);
  assert.equal(h.allIn[3], true);
  assert.deepEqual(h.needToAct, [2, 1]);
  E.act(g, 'call');
  E.act(g, 'call');
  assert.equal(h.street, 'flop');
  E.act(g, 'check');
  E.act(g, 'check');
  E.act(g, 'check'); E.act(g, 'check');
  E.act(g, 'check'); E.act(g, 'check');
  assert.equal(h.street, 'showdown');
  const pots = E.computePots(g);
  assert.deepEqual(pots, [{ amount: 3, eligible: [2, 3, 1] }, { amount: 2, eligible: [2, 1] }]);
});

test('dealer button moves and skips busted players; tournament busts', () => {
  const g = game([10, 100, 100], { mode: 'tournament', levels: [{ sb: 1, bb: 2, ante: 0, minutes: 10 }] });
  let h = E.startHand(g);
  assert.equal(h.dealerId, 1);
  E.act(g, 'allin'); // P1 10
  E.act(g, 'allin'); // P2 100
  E.act(g, 'fold'); // P3
  assert.equal(h.street, 'showdown');
  assert.deepEqual(E.computePots(g), [{ amount: 22, eligible: [2, 1] }, { amount: 90, eligible: [2] }]);
  E.awardPots(g, [[2], [2]]);
  assert.equal(g.players[0].out, true);
  E.endHand(g);
  h = E.startHand(g);
  assert.equal(h.dealerId, 2);
  E.cancelHand(g);
  assert.deepEqual(stacks(g), [0, 112, 98]);
  E.cancelHand(g); // no-op
  h = E.startHand(g);
  assert.equal(h.dealerId, 2); // misdeal: same dealer deals again
  E.act(g, 'fold'); // heads-up: dealer/SB folds
  assert.equal(h.street, 'done');
  E.endHand(g);
  h = E.startHand(g);
  assert.equal(h.dealerId, 3);
});

test('tournament timer advances level', () => {
  const g = game([100, 100], { mode: 'tournament', levels: [{ sb: 1, bb: 2, minutes: 1 }, { sb: 2, bb: 4, minutes: 1 }] });
  E.startTimer(g, 0);
  assert.equal(E.tickTimer(g, 30000), false);
  assert.equal(E.tickTimer(g, 61000), true);
  assert.equal(g.blinds.bb, 4);
  assert.equal(g.timer.remainingMs, 59000);
});

test('summary nets', () => {
  const g = game([100, 100]);
  E.addChips(g, 2, 50);
  const s = E.summary(g);
  assert.deepEqual(s.map((x) => [x.id, x.buyIn, x.net]), [[1, 100, 0], [2, 150, 0]]);
});
