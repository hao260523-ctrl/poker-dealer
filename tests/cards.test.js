const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../cards.js');

const ev = (s) => C.evaluate(s.split(' '));

test('deck has 52 unique cards and shuffle keeps them', () => {
  const d = C.newDeck();
  assert.equal(d.length, 52);
  assert.equal(new Set(d).size, 52);
  const s = C.shuffle(d.slice());
  assert.equal(new Set(s).size, 52);
});

test('categories', () => {
  assert.equal(ev('As Ks Qs Js Ts 2d 3c').name, 'straight_flush');
  assert.equal(ev('9h 9d 9s 9c 2d 3c 4h').name, 'four_kind');
  assert.equal(ev('9h 9d 9s 2c 2d 3c 4h').name, 'full_house');
  assert.equal(ev('2h 7h 9h Jh Kh 2d 3c').name, 'flush');
  assert.equal(ev('5h 6d 7s 8c 9d Kc 2h').name, 'straight');
  assert.equal(ev('Ah 2d 3s 4c 5d Kc 9h').name, 'straight'); // wheel
  assert.equal(ev('9h 9d 9s 2c 5d 3c 4h').name, 'three_kind');
  assert.equal(ev('9h 9d 5s 5c Ad 3c 4h').name, 'two_pair');
  assert.equal(ev('9h 9d 5s 6c Ad 3c 4h').name, 'pair');
  assert.equal(ev('9h 2d 5s 6c Ad 3c Jh').name, 'high_card');
});

test('comparisons and kickers', () => {
  // higher pair wins
  assert.ok(ev('Ah Ad 2s 3c 5d 7c 9h').score > ev('Kh Kd 2s 3c 5d 7c 9h').score);
  // same pair, kicker decides
  assert.ok(ev('Ah Ad Ks 3c 5d 7c 9h').score > ev('Ac As Qs 3c 5d 7c 9h').score);
  // wheel loses to 6-high straight
  assert.ok(ev('2h 3d 4s 5c 6d Kc 9h').score > ev('Ah 2d 3s 4c 5d Kc 9h').score);
  // flush beats straight
  assert.ok(ev('2h 7h 9h Jh Kh 2d 3c').score > ev('5h 6d 7s 8c 9d Kc 2h').score);
  // full house: trips rank first
  assert.ok(ev('9h 9d 9s 2c 2d 3c 4h').score > ev('8h 8d 8s Ac Ad 3c 4h').score);
  // board plays: identical scores
  assert.equal(ev('Ah Kh Qh Jh Th 2c 3d').score, ev('Ah Kh Qh Jh Th 9c 8d').score);
});

test('winners with split', () => {
  const board = 'Ah Kh Qh Jh Th'.split(' ');
  const w = C.winners({ 1: [...board, '2c', '3d'], 2: [...board, '9s', '8s'], 3: ['2d', '2s', '3c', '4c', '5c', '6c', '7c'] });
  assert.deepEqual(w, ['1', '2']);
  const w2 = C.winners({ 1: 'As Ad 2c 3c 5d 7h 9h'.split(' '), 2: 'Ks Kd 2c 3c 5d 7h 9h'.split(' ') });
  assert.deepEqual(w2, ['1']);
});
