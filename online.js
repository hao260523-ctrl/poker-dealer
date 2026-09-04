/* Online room mode: each player uses their own phone. Host phone runs the engine; guests get private views. */
(() => {
  'use strict';
  const A = window.PokerApp;
  const N = window.PokerNet;
  const E = A.E;
  const { t, tt, esc, fmt, ui } = A;
  const st = () => A.state;
  const ol = () => st().online;
  const isHost = () => !!(ol() && ol().role === 'host');
  const isGuest = () => !!(ol() && ol().role === 'guest');
  const HOST_PID = 1;
  const REVEAL_MS = 1300;
  const NEXT_HAND_MS = 9000;

  Object.assign(ui, { lobby: null, me: null, meta: null, netStatus: 'idle', proxy: null, cardsDown: null, swipe: { n: 0, at: 0 }, lastPong: 0, join: null, welcomed: false, helloAt: 0, joinError: false });

  // ---------- helpers ----------
  const rnd = (n) => { const b = new Uint32Array(1); crypto.getRandomValues(b); return b[0] % n; };
  const genPw = () => String(rnd(10000)).padStart(4, '0');
  const genToken = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const roomLink = (o) => `${location.origin}${location.pathname}?room=${o.room || ''}&pw=${o.pw}`;
  const clean = (s) => String(s || '').trim().slice(0, 12);
  const myPid = () => (isHost() ? HOST_PID : (ui.me != null ? ui.me : (ol() && ol().me != null ? ol().me : null)));
  const EMOJI = ['🙂', '😎', '🦊', '🐱', '🐶', '🐼', '🐸', '🐵', '🦁', '🐯', '🐨', '🐰'];
  const COLORS = ['#e57373', '#64b5f6', '#81c784', '#ffb74d', '#ba68c8', '#4db6ac', '#f06292', '#a1887f', '#90a4ae', '#fff176'];
  function avatarOf(p) {
    let h = 0;
    for (const ch of String(p.name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return { emoji: EMOJI[(h + p.id) % EMOJI.length], color: COLORS[(h >> 3) % COLORS.length] };
  }

  // ---------- chips ----------
  const DENOMS = [
    { v: 100000, c: '#6d4c41' }, { v: 25000, c: '#42a5f5' }, { v: 5000, c: '#ff8f00' }, { v: 1000, c: '#fdd835' },
    { v: 500, c: '#8e24aa' }, { v: 100, c: '#212121' }, { v: 25, c: '#2e7d32' }, { v: 5, c: '#d32f2f' }, { v: 1, c: '#f5f5f5' },
  ];
  function chipStack(amount, size) {
    amount = Math.max(0, Math.floor(amount || 0));
    if (!amount) return '';
    const cols = [];
    let rest = amount;
    for (const d of DENOMS) {
      const n = Math.floor(rest / d.v);
      if (n > 0) { cols.push({ d, n }); rest -= n * d.v; }
    }
    return `<span class="stack ${size || ''}">${cols.map(({ d, n }) => {
      const shown = Math.min(n, 8);
      let chips = '';
      for (let i = 0; i < shown; i++) chips += `<i class="chip" style="--c:${d.c}"></i>`;
      return `<span class="col" title="${d.v} x${n}">${chips}${n > shown ? `<em>×${n}</em>` : ''}</span>`;
    }).join('')}</span>`;
  }

  // ---------- host: state & views ----------
  function viewFor(pid) {
    const g = E.clone(st().game);
    delete g._rng;
    const h = g.hand;
    if (h) {
      delete h.deck;
      delete h.actions;
      const revealed = h.revealed == null ? (h.board ? h.board.length : 0) : h.revealed;
      const revealDone = !g.cards || !h.board || revealed >= h.board.length;
      if (h.board) h.board = h.board.slice(0, revealed);
      const showAll = h.street === 'done' && h.result && h.result.hands && revealDone;
      if (h.hole) h.hole = Object.fromEntries(Object.entries(h.hole).filter(([id]) => Number(id) === pid || (showAll && h.result.hands[id])));
      if (h.street === 'done' && !revealDone) {
        // still revealing the run-out: hide the outcome and show stacks as they were before the award
        for (const id of Object.keys(h.result.won)) { const p = g.players.find((x) => x.id === Number(id)); if (p) p.stack -= h.result.won[id]; }
        h.pendingResult = true;
        h.result = null;
        h.street = 'showdown';
      }
    }
    g.handLog = (g.handLog || []).slice(-30);
    return { t: 'view', game: g, me: pid, online: { hostName: ol().name, autoNext: ol().autoNext, players: onlinePlayers() } };
  }
  function onlinePlayers() {
    const o = ol();
    const g = st().game;
    if (!g) return [];
    return g.players.map((p) => ({ id: p.id, offline: !!p.offline }));
  }
  function lobbyMsg() {
    const o = ol();
    return { t: 'lobby', room: o.room, host: o.name, started: !!st().game, players: [{ name: o.name, host: true, connected: true }, ...o.lobby.map((x) => ({ name: x.name, connected: x.connected }))] };
  }
  function pushAll() {
    if (!isHost()) return;
    const o = ol();
    N.broadcast((meta) => {
      const seat = meta && meta.token && o.seats[meta.token];
      return st().game && seat ? viewFor(seat.pid) : lobbyMsg();
    });
  }

  function hostAfterChange() {
    const g = st().game;
    if (!g || !g.hand) return;
    const h = g.hand;
    if (h.street === 'done' && h.revealed == null) {
      h.revealed = g.cards && h.runout && h.boardBefore != null ? h.boardBefore : (h.board ? h.board.length : 0);
      h.revealAt = Date.now();
      h.nextAt = null;
    }
  }
  A.hooks.afterMutate.push(() => { if (isHost()) { hostAfterChange(); pushAll(); } });

  /** Host automation: staged run-out reveal, automatic next hand. */
  function hostTick() {
    const g = st().game;
    const o = ol();
    if (!g || !g.hand) return;
    const h = g.hand;
    if (h.street !== 'done') return;
    const now = Date.now();
    const full = h.board ? h.board.length : 0;
    if (g.cards && h.revealed < full) {
      if (now - h.revealAt >= REVEAL_MS) {
        h.revealed = Math.min(full, h.revealed < 3 ? 3 : h.revealed + 1);
        h.revealAt = now;
        A.save(); A.render(); pushAll();
      }
      return;
    }
    if (h.nextAt == null) {
      h.nextAt = now + NEXT_HAND_MS;
      A.save(); A.render(); pushAll();
      return;
    }
    if (o.autoNext && now >= h.nextAt && E.canStartHand(g)) {
      A.actions.nextHand();
    }
  }

  // ---------- messages ----------
  N.on({
    status: (s) => { ui.netStatus = s; A.render(); },
    open: () => { if (isGuest()) sendHello(); },
    hostLost: () => { ui.welcomed = false; ui.firstHelloAt = 0; A.render(); },
    message: (c, m) => { try { if (isHost()) hostMsg(c, m); else if (isGuest()) guestMsg(c, m); } catch (e) { console.error(e); } },
    close: (c, meta) => { if (isHost()) hostClose(meta); },
    error: (e) => { console.warn('net error', e); if (e && e.type === 'browser-incompatible') A.toast('このブラウザは対応していません'); },
  });

  function hostMsg(c, m) {
    const o = ol();
    const g = st().game;
    if (m.t === 'ping') { N.send(c, { t: 'pong' }); return; }
    if (m.t === 'hello') {
      if (String(m.pw) !== String(o.pw)) { N.send(c, { t: 'denied', reason: 'pw' }); return; }
      if (!m.token) return;
      N.setMeta(c, { token: m.token });
      const name = clean(m.name);
      const seat = o.seats[m.token];
      if (seat) {
        const p = g && E.byId(g, seat.pid);
        if (p) { p.offline = false; if (name) p.name = name; }
      } else if (!g) {
        const ex = o.lobby.find((x) => x.token === m.token);
        if (ex) { ex.connected = true; if (name) ex.name = name; }
        else o.lobby.push({ token: m.token, name: name || `P${o.lobby.length + 2}`, connected: true });
      } else if (g.mode === 'cash') {
        const pid = E.addPlayer(g, name, A.defaultBuyIn());
        o.seats[m.token] = { pid, name: name || `P${pid}` };
        A.toast('{0} が参加しました', [esc(E.byId(g, pid).name)]);
      } else { N.send(c, { t: 'denied', reason: 'inprogress' }); return; }
      const mine = o.seats[m.token];
      N.send(c, { t: 'welcome', room: o.room, me: mine ? mine.pid : null });
      A.save(); A.render(); pushAll();
      return;
    }
    const meta = N.getMeta(c);
    const seat = meta && meta.token && o.seats[meta.token];
    if (m.t === 'name') {
      const name = clean(m.name);
      if (!name) return;
      if (seat && g) E.byId(g, seat.pid).name = name;
      else { const ex = o.lobby.find((x) => x.token === meta.token); if (ex) ex.name = name; }
      A.save(); A.render(); pushAll();
      return;
    }
    if (m.t === 'leave') {
      if (!g) { o.lobby = o.lobby.filter((x) => x.token !== (meta && meta.token)); A.save(); A.render(); pushAll(); }
      return;
    }
    if (!seat || !g) return;
    if (m.t === 'act') {
      if (!g.hand || g.hand.toAct !== seat.pid) return;
      const amount = Number(m.amount);
      A.mutate((gg) => E.act(gg, m.a, amount));
      return;
    }
    if (m.t === 'addChips') {
      const amt = Math.floor(Number(m.amount));
      const p = E.byId(g, seat.pid);
      const live = g.hand && g.hand.street !== 'done' && g.hand.inHandIds.includes(p.id) && !g.hand.folded[p.id];
      if (g.mode !== 'cash' || live || !(amt > 0)) return;
      A.mutate((gg) => { E.addChips(gg, seat.pid, amt); }, { undoable: false });
      A.toast('{0} に {1} 追加', [esc(p.name), fmt(amt)]);
      return;
    }
    if (m.t === 'sitout') {
      const p = E.byId(g, seat.pid);
      const live = g.hand && g.hand.street !== 'done' && g.hand.inHandIds.includes(p.id) && !g.hand.folded[p.id];
      if (live) return;
      A.mutate((gg) => { const pp = E.byId(gg, seat.pid); pp.sitOut = !!m.on; }, { undoable: false });
    }
  }

  function hostClose(meta) {
    const o = ol();
    if (!meta || !meta.token) return;
    const seat = o.seats[meta.token];
    const g = st().game;
    if (seat && g) { const p = E.byId(g, seat.pid); if (p) p.offline = true; }
    const ex = o.lobby.find((x) => x.token === meta.token);
    if (ex) ex.connected = false;
    A.save(); A.render(); pushAll();
  }

  function sendHello() {
    const o = ol();
    if (!o) return;
    ui.helloAt = Date.now();
    if (!ui.firstHelloAt) ui.firstHelloAt = ui.helloAt;
    N.sendHost({ t: 'hello', token: o.token, name: o.name, pw: o.pw });
  }

  function guestMsg(c, m) {
    if (m.t === 'pong') { ui.lastPong = Date.now(); return; }
    if (m.t === 'welcome') { ui.me = m.me; ol().me = m.me; ui.welcomed = true; ui.joinError = false; ui.firstHelloAt = 0; A.save(); A.render(); return; }
    if (m.t === 'denied') {
      N.destroy();
      A.toast(m.reason === 'pw' ? 'パスワードが違います' : 'ゲーム進行中のため入室できません（キャッシュゲームなら途中参加できます）');
      st().online = null;
      st().screen = 'onlineHome';
      A.save(); A.render();
      return;
    }
    if (m.t === 'lobby') {
      ui.lobby = m;
      if (!m.started) { st().screen = 'lobby'; }
      A.render();
      return;
    }
    if (m.t === 'view') {
      const prevTurn = st().game && st().game.hand ? st().game.hand.toAct : null;
      st().game = m.game;
      ui.me = m.me;
      ol().me = m.me;
      ui.meta = m.online;
      if (st().screen !== 'table') { st().screen = 'table'; A.requestWakeLock(); }
      const nowTurn = m.game.hand ? m.game.hand.toAct : null;
      if (nowTurn === m.me && prevTurn !== m.me) A.vibrate([120, 60, 120]);
      A.save(); A.render();
    }
  }

  // guest heartbeat / foreground recovery
  setInterval(() => {
    if (!isGuest()) return;
    if (N.connected) {
      N.sendHost({ t: 'ping' });
      if (ui.lastPong && Date.now() - ui.lastPong > 30000) { ui.lastPong = 0; N.kick(); }
    }
  }, 10000);
  setInterval(() => {
    if (!isGuest() || ui.welcomed) return;
    const now = Date.now();
    // host is visibly present (plain beacon) but never answered our (encrypted) hello -> wrong password
    if (N.hostSeen && ui.firstHelloAt && now - ui.firstHelloAt > 9000 && !ui.joinError) { ui.joinError = true; A.render(); }
    if (ui.helloAt && now - ui.helloAt > 5000 && N.status !== 'idle') sendHello();
  }, 2500);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ol()) { N.kick(); if (isGuest()) ui.lastPong = Date.now(); } });
  A.hooks.tick = () => {
    if (isHost()) { hostTick(); return false; }
    if (isGuest()) {
      const g = st().game;
      const el = document.getElementById('timer');
      if (el && g && g.timer) {
        const rem = g.timer.running && g.timer.lastTick ? g.timer.remainingMs - (Date.now() - g.timer.lastTick) : g.timer.remainingMs;
        el.textContent = A.mmss(rem);
      }
      const cd = document.getElementById('nextcd');
      if (cd && g && g.hand && g.hand.nextAt) cd.textContent = Math.max(0, Math.ceil((g.hand.nextAt - Date.now()) / 1000));
      return true;
    }
    return false;
  };

  // ---------- connection lifecycle ----------
  async function startHosting(o) {
    for (let i = 0; i < 3; i++) {
      try {
        const room = await N.host(o.room, o.pw);
        if (!o.room) { o.room = room; A.save(); }
        return true;
      } catch (e) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    return false;
  }

  async function createRoom(name) {
    const o = { role: 'host', room: null, pw: genPw(), name: clean(name) || 'Host', token: genToken(), seats: {}, lobby: [], autoNext: true };
    st().online = o;
    st().screen = 'lobby';
    st().setup.cards = true;
    A.save(); A.render();
    const ok = await startHosting(o);
    if (!ok) { A.toast('ルームを開けませんでした。通信状態を確認してください。'); st().online = null; st().screen = 'onlineHome'; A.save(); }
    A.render();
  }

  async function joinRoom(room, pw, name) {
    const o = { role: 'guest', room: String(room).trim(), pw: String(pw).trim(), name: clean(name), token: (st().guestTokens || {})[room] || genToken() };
    st().guestTokens = { ...(st().guestTokens || {}), [o.room]: o.token };
    st().online = o;
    st().screen = 'lobby';
    ui.lobby = null; ui.welcomed = false; ui.joinError = false; ui.helloAt = 0; ui.firstHelloAt = 0;
    A.save(); A.render();
    await N.join(o.room, o.pw);
  }

  function leaveRoom() {
    const o = ol();
    if (isGuest()) N.sendHost({ t: 'leave' });
    N.destroy();
    if (isGuest()) { if (st().game) st().archive = { game: st().game, endedAt: Date.now() }; st().game = null; }
    else if (st().game) { st().archive = { game: st().game, endedAt: Date.now() }; st().game = null; }
    st().online = null;
    st().history = [];
    ui.sheet = null;
    ui.me = null; ui.lobby = null; ui.meta = null;
    st().screen = 'setup';
    A.save(); A.render();
  }

  // ---------- gestures: squeeze (hold) & double swipe-up to fold ----------
  const app = document.getElementById('app');
  let press = null;
  app.addEventListener('pointerdown', (ev) => {
    const area = ev.target.closest('[data-mycards]');
    if (!area) return;
    ev.preventDefault();
    press = { x: ev.clientX, y: ev.clientY, t: Date.now(), area };
    area.querySelectorAll('.sq').forEach((q) => q.classList.add('peel'));
    try { area.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
  });
  const release = (ev) => {
    if (!press) return;
    const area = press.area;
    area.querySelectorAll('.sq').forEach((q) => q.classList.remove('peel'));
    const dy = press.y - ev.clientY;
    const dx = Math.abs(ev.clientX - press.x);
    const dt = Date.now() - press.t;
    press = null;
    if (ev.type !== 'pointerup') return;
    const isSwipe = dy >= 60 && dx < dy * 0.6 && dt < 700;
    if (!isSwipe) return;
    const now = Date.now();
    if (ui.swipe.n === 1 && now - ui.swipe.at < 1500) {
      ui.swipe = { n: 0, at: 0 };
      if (canFoldNow()) { A.actions.fold(); A.vibrate(60); }
    } else {
      ui.swipe = { n: 1, at: now };
      area.classList.add('lift');
      const hint = area.querySelector('.foldhint');
      if (hint) hint.hidden = false;
      setTimeout(() => { if (ui.swipe.n === 1 && Date.now() - ui.swipe.at >= 1400) { ui.swipe = { n: 0, at: 0 }; area.classList.remove('lift'); if (hint) hint.hidden = true; } }, 1500);
    }
  };
  app.addEventListener('pointerup', release);
  app.addEventListener('pointercancel', release);
  app.addEventListener('contextmenu', (ev) => { if (ev.target.closest('[data-mycards]')) ev.preventDefault(); });
  function canFoldNow() {
    const g = st().game;
    return g && g.hand && g.hand.toAct != null && g.hand.toAct === myPid() && g.hand.street !== 'done';
  }

  // ---------- actions ----------
  const wrap = (name, guestFn) => {
    const orig = A.actions[name];
    A.actions[name] = (d, ev) => { if (isGuest()) guestFn(d, ev); else if (orig) orig(d, ev); };
  };
  const guestAct = (a, amount) => { ui.sheet = null; N.sendHost({ t: 'act', a, amount }); A.render(); };
  wrap('fold', () => guestAct('fold'));
  wrap('check', () => guestAct('check'));
  wrap('call', () => guestAct('call'));
  wrap('allinConfirm', () => guestAct('allin'));
  wrap('raiseConfirm', () => guestAct('raise', ui.raiseTo));
  ['deal', 'nextHand', 'undo', 'award', 'pickWinner', 'cancelHandConfirm', 'restoreHandConfirm', 'applyBlinds', 'doAddChips', 'doRename', 'toggleSit', 'leave', 'rejoin', 'setDealer', 'newGame', 'newGameConfirm', 'handoff'].forEach((k) => wrap(k, () => {}));
  const origMenu = A.actions.menu;
  A.actions.menu = (d, ev) => { if (ol()) { ui.sheet = { type: 'olMenu' }; A.render(); } else origMenu(d, ev); };
  const origPlayer = A.actions.player;
  A.actions.player = (d, ev) => { if (isGuest()) { ui.sheet = { type: 'olPlayer', id: Number(d.id) }; A.render(); } else origPlayer(d, ev); };

  Object.assign(A.actions, {
    olHome() { st().screen = 'onlineHome'; A.save(); A.render(); },
    olBack() { st().screen = 'setup'; A.save(); A.render(); },
    olCreate() {
      const name = document.getElementById('ol-name').value;
      if (!clean(name)) return A.toast('名前を入力してください');
      st().setup.olName = clean(name);
      createRoom(name);
    },
    olJoin() {
      const name = clean(document.getElementById('ol-name2').value);
      const room = document.getElementById('ol-room').value.replace(/\D/g, '');
      const pw = document.getElementById('ol-pw').value.replace(/\D/g, '');
      if (!name) return A.toast('名前を入力してください');
      if (room.length !== 6 || pw.length !== 4) return A.toast('ルーム番号は6桁、パスワードは4桁です');
      st().setup.olName = name;
      joinRoom(room, pw, name);
    },
    olLeave() {
      ui.sheet = { type: 'confirm', title: isHost() ? 'ルームを閉じる' : 'ルームを退出', text: isHost() ? '全員の接続が切れ、ゲームは「前回のゲーム」として保管されます。' : 'このルームから退出します。', ok: isHost() ? '閉じる' : '退出', act: 'olLeaveConfirm' };
      A.render();
    },
    olLeaveConfirm() { leaveRoom(); },
    olRetryJoin() {
      const o = ol();
      N.destroy();
      ui.join = { room: o.room, pw: '' };
      st().online = null;
      st().screen = 'onlineHome';
      A.save(); A.render();
    },
    olKick(d) {
      const o = ol();
      if (!isHost() || st().game) return;
      o.lobby = o.lobby.filter((x) => x.token !== d.token);
      A.save(); A.render(); pushAll();
    },
    olStart() {
      const o = ol();
      if (!isHost() || st().game) return;
      const guests = o.lobby.filter((x) => x.connected);
      if (!guests.length) return A.toast('参加者が接続するのを待っています');
      const cfg = A.startGameConfig();
      if (!cfg) return;
      cfg.cards = true;
      cfg.players = [{ name: o.name, stack: cfg.stack }, ...guests.map((x) => ({ name: x.name, stack: cfg.stack }))];
      st().game = E.createGame(cfg);
      o.seats = {};
      o.seats[o.token] = { pid: HOST_PID, name: o.name };
      guests.forEach((x, i) => { o.seats[x.token] = { pid: st().game.players[i + 1].id, name: x.name }; });
      o.lobby = [];
      st().history = [];
      st().screen = 'table';
      A.save(); A.render(); A.requestWakeLock(); A.requestPersistentStorage();
      pushAll();
      A.actions.deal();
    },
    olToggleAuto() { ol().autoNext = !ol().autoNext; A.save(); A.render(); pushAll(); },
    olNextNow() { if (isHost() && st().game && st().game.hand && st().game.hand.street === 'done' && E.canStartHand(st().game)) A.actions.nextHand(); },
    olProxy(d) { ui.proxy = ui.proxy === Number(d.id) ? null : Number(d.id); A.render(); },
    olCardsUp() {
      const g = st().game;
      const key = g && g.hand ? g.hand.no : 0;
      ui.cardsDown = ui.cardsDown === key ? null : key;
      A.render();
    },
    olRoomInfo() { ui.sheet = { type: 'olRoom' }; A.render(); },
    async olShare() {
      const url = roomLink(ol());
      const text = tt('ポーカーのルームに参加してね。ルーム {0} ／ パスワード {1}', ol().room, ol().pw);
      if (navigator.share) { try { await navigator.share({ title: tt('ポーカーディーラー'), text, url }); return; } catch (e) { /* cancelled */ } }
      try { await navigator.clipboard.writeText(`${text}\n${url}`); A.toast('リンクをコピーしました'); } catch (e) { A.toast('コピーできませんでした'); }
    },
    async olCopyLink() {
      try { await navigator.clipboard.writeText(roomLink(ol())); A.toast('リンクをコピーしました'); } catch (e) { A.toast('コピーできませんでした'); }
    },
    olRename() {
      const v = clean(document.getElementById('ol-rename').value);
      if (!v) return A.toast('名前を入力してください');
      ol().name = v;
      st().setup.olName = v;
      if (isGuest()) N.sendHost({ t: 'name', name: v });
      else if (st().game) { E.byId(st().game, HOST_PID).name = v; pushAll(); }
      ui.sheet = null;
      A.save(); A.render();
    },
    olRebuy() { ui.sheet = { type: 'olRebuy' }; A.render(); },
    olRebuyDo() {
      const amt = Math.floor(Number(document.getElementById('ol-rebuy').value));
      if (!(amt > 0)) return A.toast('金額を入力してください');
      ui.sheet = null;
      if (isGuest()) N.sendHost({ t: 'addChips', amount: amt });
      else A.mutate((g) => { E.addChips(g, HOST_PID, amt); }, { undoable: false });
      A.render();
    },
    olSitout() {
      const g = st().game;
      const me = E.byId(g, myPid());
      if (isGuest()) N.sendHost({ t: 'sitout', on: !me.sitOut });
      else A.mutate((gg) => { const p = E.byId(gg, HOST_PID); p.sitOut = !p.sitOut; }, { undoable: false });
      ui.sheet = null; A.render();
    },
    olHostDeal() { if (isHost()) A.actions.deal(); },
  });

  // ---------- screens ----------
  const statusLabel = () => {
    const s = ui.netStatus;
    const map = { idle: '', loading: '通信ライブラリを読み込み中…', connecting: '接続中…', online: '', reconnecting: '再接続中…', 'waiting-host': 'ホストの接続を待っています…', error: '通信エラー' };
    return map[s] || '';
  };
  const connDot = () => {
    const ok = isHost() ? N.status === 'online' : N.connected;
    return `<span class="conn ${ok ? 'ok' : 'ng'}" title="${esc(N.status)}"></span>`;
  };

  A.screens.onlineHome = () => {
    const j = ui.join || {};
    const name = st().setup.olName || '';
    return `<div class="screen">
      <div class="topbar"><button class="icon" data-act="olBack">←</button><div class="info"><b>${t('各自のスマホで遊ぶ')}</b></div></div>
      <div class="card">
        <h3>${t('ルームを作る（ホスト）')}</h3>
        <div class="field"><label>${t('あなたの名前')}</label><input type="text" id="ol-name" value="${esc(name)}" maxlength="12" placeholder="Host"></div>
        <button class="primary big" style="width:100%" data-act="olCreate">${t('ルームを作る')}</button>
        <p class="hint">${t('ルーム番号とパスワードが発行されます。相手に番号を伝えるか、リンクを送ってください。')}</p>
      </div>
      <div class="card">
        <h3>${t('ルームに入る')}</h3>
        <div class="field"><label>${t('あなたの名前')}</label><input type="text" id="ol-name2" value="${esc(name)}" maxlength="12" placeholder="Guest"></div>
        <div class="row">
          <div class="field"><label>${t('ルーム番号（6桁）')}</label><input type="text" inputmode="numeric" id="ol-room" value="${esc(j.room || '')}" maxlength="6" placeholder="123456"></div>
          <div class="field"><label>${t('パスワード（4桁）')}</label><input type="text" inputmode="numeric" id="ol-pw" value="${esc(j.pw || '')}" maxlength="4" placeholder="0000"></div>
        </div>
        <button class="green big" style="width:100%" data-act="olJoin">${t('入室する')}</button>
      </div>
      <p class="hint">${t('スマホ同士を直接つなぎます（両方にインターネット接続が必要）。同じ部屋でも離れていても遊べます。')}</p>
    </div>`;
  };

  A.screens.lobby = () => {
    const o = ol();
    if (!o) { st().screen = 'setup'; return ''; }
    if (isHost()) {
      const s = st().setup;
      const rows = [{ name: o.name, connected: true, host: true }, ...o.lobby].map((x) => `<div class="lobby-row"><span class="conn ${x.connected ? 'ok' : 'ng'}"></span><span class="nm">${esc(x.name)}${x.host ? ` <small>(${t('ホスト')})</small>` : ''}</span>${x.host ? '' : `<button class="small ghost" data-act="olKick" data-token="${x.token}">✕</button>`}</div>`).join('');
      const n = 1 + o.lobby.filter((x) => x.connected).length;
      return `<div class="screen">
        <div class="topbar"><div class="info"><b>${t('ルーム')} ${o.room || '…'}</b><span>${t('パスワード')} ${o.pw} ${connDot()} ${esc(statusLabel())}</span></div><button class="icon" data-act="menu">☰</button></div>
        <div class="card roomcard">
          ${o.room ? `<div class="roomnum"><small>${t('ルーム番号')}</small><b>${o.room}</b></div>
          <div class="roomnum"><small>${t('パスワード')}</small><b>${o.pw}</b></div>
          <div class="row" style="margin-top:10px"><button class="primary" data-act="olShare">${t('リンクを送る')}</button><button data-act="olCopyLink">${t('リンクをコピー')}</button></div>` : `<div class="msg big">${t('ルームを作成中…')}</div><div class="dots"><i></i><i></i><i></i></div>`}
        </div>
        <div class="card">
          <h3>${t('参加者')} (${n})</h3>
          ${rows}
          <p class="hint">${t('相手が入室するとここに表示されます。')}</p>
        </div>
        ${A.renderModeCard(s)}
        ${A.renderGameCard(s)}
        <button class="primary big" data-act="olStart" ${n >= 2 ? '' : 'disabled'}>${t('ゲームを開始（{0}人）', n)}</button>
        <p class="hint" style="text-align:center">${t('カードはアプリが配ります。各自のスマホに自分の手札だけが表示されます。')}</p>
        <button class="small ghost" style="margin:8px auto 0;display:block" data-act="olLeave">${t('ルームを閉じる')}</button>
      </div>`;
    }
    const lb = ui.lobby;
    const rows = lb ? lb.players.map((x) => `<div class="lobby-row"><span class="conn ${x.connected ? 'ok' : 'ng'}"></span><span class="nm">${esc(x.name)}${x.host ? ` <small>(${t('ホスト')})</small>` : ''}</span></div>`).join('') : '';
    return `<div class="screen">
      <div class="topbar"><div class="info"><b>${t('ルーム')} ${o.room}</b><span>${connDot()} ${esc(statusLabel()) || t('接続済み')}</span></div><button class="icon" data-act="menu">☰</button></div>
      <div class="card">
        <h3>${t('参加者')}</h3>
        ${rows || `<p class="hint">${t('ホストに接続しています…')}</p>`}
      </div>
      <div class="card" style="text-align:center">
        ${ui.joinError ? `<div class="msg big" style="color:var(--gold)">${t('パスワードが違うか、入室できませんでした。ルーム番号とパスワードを確認してください。')}</div><button data-act="olRetryJoin">${t('ルーム番号・パスワードを入れ直す')}</button>`
          : `<div class="msg big">${!ui.welcomed ? t('ホストに接続しています…') : lb && lb.started ? t('ゲーム進行中。次のハンドから参加します') : t('ホストがゲームを開始するのを待っています')}</div><div class="dots"><i></i><i></i><i></i></div>`}
      </div>
      <button class="small ghost" style="margin:8px auto 0;display:block" data-act="olLeave">${t('ルームを退出')}</button>
    </div>`;
  };

  // ---------- immersive table ----------
  A.hooks.renderTable = () => (ol() ? renderTV() : null);

  function renderTV() {
    const g = st().game;
    const o = ol();
    if (!g) { st().screen = 'lobby'; return A.screens.lobby(); }
    const me = myPid();
    const h = g.hand;
    const meP = me != null ? E.byId(g, me) : null;
    if (!meP) {
      return `<div class="screen"><div class="topbar"><div class="info"><b>${t('ルーム')} ${o.room}</b><span>${connDot()} ${esc(statusLabel()) || t('接続中…')}</span></div><button class="icon" data-act="menu">☰</button></div>
        <div class="card" style="text-align:center"><div class="msg big">${t('ホストに接続しています…')}</div><div class="dots"><i></i><i></i><i></i></div></div></div>`;
    }
    const la = h && h.toAct != null ? E.legalActions(g) : null;
    const dealerId = h ? h.dealerId : (g.dealerIdx >= 0 ? g.players[g.dealerIdx].id : null);
    const revealed = h && h.board ? (isHost() && h.revealed != null ? Math.min(h.revealed, h.board.length) : h.board.length) : 0;
    const board = h && h.board ? h.board.slice(0, revealed) : [];
    const revealing = h && g.cards && ((isHost() && h.street === 'done' && h.revealed < h.board.length) || (isGuest() && h.pendingResult));
    const hidden = { ...h };
    const done = h && h.street === 'done' && !revealing;
    const showAll = done && h.result && h.result.hands;
    const myIdx = E.idxOf(g, me);
    const n = g.players.length;
    const others = [];
    for (let k = 1; k < n; k++) others.push(g.players[(myIdx + k) % n]);
    void hidden;

    const oppHtml = (p) => {
      const av = avatarOf(p);
      const inHand = h && h.inHandIds.includes(p.id) && !h.folded[p.id];
      const folded = h && h.inHandIds.includes(p.id) && h.folded[p.id];
      const shown = showAll && h.result.hands[p.id];
      const cls = ['opp'];
      if (h && h.toAct === p.id) cls.push('think');
      if (folded || p.out || p.sitOut || (h && !h.inHandIds.includes(p.id))) cls.push('dim');
      if (p.offline) cls.push('offline');
      const pn = done && h.result.net ? h.result.net[p.id] : undefined;
      if (pn > 0) cls.push('won');
      let tag = '';
      if (p.out) tag = t(g.mode === 'tournament' ? '敗退' : '退席');
      else if (p.offline) tag = t('接続待ち');
      else if (p.sitOut) tag = t('離席中');
      else if (folded) tag = t('フォールド');
      else if (h && h.allIn[p.id]) tag = t('オールイン');
      else if (h && h.toAct === p.id) tag = t('考え中…');
      const bet = h && h.bets[p.id] && h.street !== 'done' ? `<div class="opp-bet">${chipStack(h.bets[p.id], 'xs')}<b>${fmt(h.bets[p.id])}</b></div>` : '';
      const cards = inHand ? `<div class="opp-cards">${shown ? A.cardsHtml(shown.cards, 'sm') + `<span class="handname">${t(A.HAND_JA[shown.name])}</span>` : A.cardHtml(null, 'sm') + A.cardHtml(null, 'sm')}</div>` : '<div class="opp-cards"></div>';
      return `<div class="${cls.join(' ')}" data-act="player" data-id="${p.id}">
        <div class="bust"><div class="avatar" style="--c:${av.color}">${av.emoji}</div>${p.id === dealerId ? '<i class="dbtn">D</i>' : ''}</div>
        <div class="opp-name">${esc(p.name)}</div>
        <div class="opp-stack">${chipStack(p.stack, 'xs')}<b>${fmt(p.stack)}</b></div>
        ${tag ? `<div class="opp-tag">${tag}</div>` : ''}
        ${cards}
        ${pn != null ? `<div class="opp-won">${A.netHtml(pn)}</div>` : ''}
        ${bet}
      </div>`;
    };

    const pot = h ? E.totalPot(h) : 0;
    const timer = g.timer ? `<div class="timer ${g.timer.running ? '' : 'paused'}"><span class="t" id="timer">${A.mmss(g.timer.remainingMs)}</span>${isHost() ? `<button class="icon ghost" data-act="timer">${g.timer.running ? '⏸' : '▶'}</button>` : ''}</div>` : '';
    const header = `<div class="tv-top">
      <div class="info"><b>${A.blindsLabel(g.blinds, true)}</b><span>${g.mode === 'tournament' ? `Lv${g.levelIndex + 1} ・ ` : ''}#${h ? h.no : g.handNo + 1}${h && !done ? ' ・ ' + A.street(h.street === 'showdown' ? 'showdown' : h.street) : ''} ${connDot()}</span></div>
      ${timer}<button class="icon" data-act="menu">☰</button>
    </div>`;

    // my cards
    const myHole = h && h.hole && h.hole[me];
    const meIn = h && h.inHandIds.includes(me) && !h.folded[me];
    // on your own phone the cards are face-up by default; "伏せる" hides them for this hand (long press peeks)
    const up = ui.cardsDown !== (h ? h.no : 0);
    let cardsArea = '';
    if (g.cards && myHole && meIn) {
      cardsArea = `<div class="mycards" data-mycards>${myHole.map((c) => A.squeezeHtml(c, up || showAll)).join('')}<div class="foldhint" hidden>${t('もう一度上にスワイプでフォールド')}</div></div>
        <div class="cardtools"><button class="small ghost" data-act="olCardsUp">${up ? t('伏せる') : t('表にする')}</button><span class="hint">${up ? t('上に2回スワイプでフォールド') : t('長押しで見る ・ 上に2回スワイプでフォールド')}</span></div>`;
    } else if (h && h.inHandIds.includes(me) && h.folded[me]) {
      cardsArea = `<div class="mycards folded"><div class="sq off"></div><div class="sq off"></div></div><div class="cardtools"><span class="hint">${t('フォールドしました')}</span></div>`;
    }

    // action / status area
    let act = '';
    const myTurn = la && la.playerId === me;
    const proxyTurn = isHost() && la && la.playerId !== me && ui.proxy === la.playerId;
    if (!h) {
      act = isHost()
        ? `<button class="primary big" style="width:100%" data-act="olHostDeal" ${E.canStartHand(g) ? '' : 'disabled'}>${t(g.handNo === 0 ? '最初のハンドを配る' : '次のハンドを配る ▶')}</button>${E.canStartHand(g) ? '' : `<p class="hint" style="text-align:center">${t('プレイできる人が2人未満です。チップ追加や復帰をしてください。')}</p>`}`
        : `<div class="msg">${t('ホストの開始待ち')}</div>`;
    } else if (revealing) {
      act = `<div class="msg big">${t('ボードを公開中…')}</div>`;
    } else if (done) {
      const r = h.result;
      const rows = A.resultRows(g, r);
      const secs = h.nextAt ? Math.max(0, Math.ceil((h.nextAt - Date.now()) / 1000)) : null;
      const auto = isHost() ? o.autoNext : (ui.meta && ui.meta.autoNext);
      const rebuy = g.mode === 'cash' && meP && meP.stack === 0 ? `<button class="green" style="width:100%;margin-bottom:8px" data-act="olRebuy">${t('チップを追加（リバイ）')}</button>` : '';
      act = `<div class="results compact">${rows}</div>${rebuy}
        ${auto && secs != null ? `<div class="msg">${t('次のハンドまで {0} 秒', `<span id="nextcd">${secs}</span>`)}</div>` : ''}
        ${isHost() ? `<button class="primary big" style="width:100%" data-act="olNextNow" ${E.canStartHand(g) ? '' : 'disabled'}>${t('次のハンドへ ▶')}</button>` : (!auto ? `<div class="msg">${t('ホストが次のハンドを開始します')}</div>` : '')}`;
    } else if (myTurn || proxyTurn) {
      const p = E.byId(g, la.playerId);
      const callLabel = la.canCheck ? t('チェック') : la.callIsAllIn ? t('コール {0}（オールイン）', fmt(la.callAmount)) : t('コール {0}', fmt(la.callAmount));
      const raiseWord = la.currentBet === 0 ? 'ベット' : 'レイズ';
      act = `${proxyTurn ? `<div class="msg">${t('{0} の代理で操作中', esc(p.name))} <button class="small ghost" data-act="olProxy" data-id="${p.id}">✕</button></div>` : `<div class="who"><b>${t('あなたの番')}</b><span>${la.currentBet > 0 ? t('現在のベット {0}', fmt(la.currentBet)) + ' ・ ' : ''}${la.canRaise ? t('最低{0} {1}', A.pair(raiseWord), fmt(la.minRaiseTo)) : ''}</span></div>`}
        <div class="actions">
          <button class="big blue ${la.canCheck ? 'dim' : ''}" data-act="fold">${t('フォールド')}</button>
          <button class="big green" data-act="${la.canCheck ? 'check' : 'call'}">${callLabel}</button>
          <button class="big danger" data-act="raiseOpen" ${la.canRaise ? '' : 'disabled'}>${t(raiseWord)}</button>
          <button class="big purple" data-act="allin" ${la.stack > 0 && (la.canRaise || la.callIsAllIn) ? '' : 'disabled'}>${t('オールイン {0}', fmt(la.maxRaiseTo))}</button>
        </div>`;
    } else if (la) {
      const p = E.byId(g, la.playerId);
      act = `<div class="msg big wait">${t('{0} が考え中', esc(p.name))}<span class="dots"><i></i><i></i><i></i></span></div>
        ${isHost() ? `<div style="text-align:center"><button class="small ghost" data-act="olProxy" data-id="${p.id}">${p.offline ? t('接続待ち：代理で操作する') : t('代理で操作する')}</button></div>` : ''}`;
    } else {
      act = `<div class="msg">${t('待機中')}</div>`;
    }

    const myBet = h && h.bets[me] && h.street !== 'done' ? `<div class="mybet">${chipStack(h.bets[me], 'xs')}<b>${fmt(h.bets[me])}</b></div>` : '';
    const myNet = done && h.result.net && h.result.net[me] != null ? h.result.net[me] : null;
    const meStatus = myNet != null ? A.netHtml(myNet) : (meP && meP.offline ? '' : (h && h.allIn[me] ? `<span class="tag">${t('オールイン')}</span>` : ''));
    const overlay = (isGuest() && !N.connected) || (isHost() && N.status !== 'online') ? `<div class="netbar">${connDot()} ${esc(statusLabel()) || t('接続中…')}</div>` : '';

    return `<div class="tv ${others.length <= 1 ? 'hu' : ''} ${others.length >= 5 ? 'many' : ''}">
      <div class="tv-felt"></div>
      ${header}
      <div class="tv-opps">${others.map(oppHtml).join('')}</div>
      <div class="tv-center">
        <div class="tv-pot">${chipStack(pot, 'sm')}<b>${t('ポット')} ${fmt(pot)}</b></div>
        ${g.cards ? `<div class="board">${A.cardsHtml(board, 'md')}${'<span class="pcard slot md"></span>'.repeat(Math.max(0, 5 - board.length))}</div>` : ''}
      </div>
      <div class="tv-me">
        <div class="merow">
          <div class="meinfo"><span class="avatar sm" style="--c:${avatarOf(meP).color}">${avatarOf(meP).emoji}</span><div><div class="opp-name">${esc(meP.name)} ${me === dealerId ? '<i class="dbtn">D</i>' : ''} ${meStatus}</div><div class="opp-stack">${chipStack(meP.stack, 'xs')}<b>${fmt(meP.stack)}</b></div></div></div>
          ${myBet}
        </div>
        ${cardsArea}
        <div class="meact">${act}</div>
      </div>
      ${overlay}
    </div>`;
  }

  // ---------- sheets ----------
  A.sheets.olMenu = (s, close) => {
    const g = st().game;
    const o = ol();
    return `<h2>${t('メニュー')} ${close}</h2>
      <div class="menu">
        <button data-act="olRoomInfo">${t('ルーム情報・招待')} <small style="color:var(--muted)">${o.room}</small></button>
        <button data-act="shareSite">${t('このアプリのリンクを共有')} <small style="color:var(--muted)">${esc(A.siteUrl())}</small></button>
        <div class="row" style="margin-bottom:8px"><span style="flex:0 0 auto;color:var(--muted)">${t('言語')}${st().lang === 'ja' ? ' / 语言' : ''}</span>${A.langSeg()}</div>
        ${g && g.mode === 'cash' ? `<button data-act="olRebuy">${t('チップを追加（リバイ）')}</button>` : ''}
        ${g ? `<button data-act="olSitout">${E.byId(g, myPid()) && E.byId(g, myPid()).sitOut ? t('席に戻る') : t('一時離席（次のハンドから飛ばす）')}</button>` : ''}
        <button data-act="sheet" data-type="olName">${t('名前変更')}</button>
        ${isHost() ? `
          <button data-act="olToggleAuto">${t('次のハンドを自動で開始')}: ${o.autoNext ? 'ON' : 'OFF'}</button>
          ${g ? `<button data-act="sheet" data-type="blinds">${t('ブラインド・アンテを変更')}</button>` : ''}
          ${g && g.timer ? `<button data-act="sheet" data-type="levels">${t('レベル・タイマー')}</button>` : ''}
          ${g && g.hand && g.hand.street !== 'done' ? `<button data-act="cancelHand">${t('このハンドを中止（ミスディール：チップを返す）')}</button>` : ''}
          ${g ? `<button data-act="sheet" data-type="history">${t('ハンド履歴・復元')}</button>` : ''}
        ` : ''}
        ${g ? `<button data-act="summary">${t('集計を見る')}</button>` : ''}
        <button class="danger" data-act="olLeave">${isHost() ? t('ルームを閉じる') : t('ルームを退出')}</button>
      </div>`;
  };
  A.sheets.olRoom = (s, close) => {
    const o = ol();
    return `<h2>${t('ルーム情報・招待')} ${close}</h2>
      <div class="roomcard">
        <div class="roomnum"><small>${t('ルーム番号')}</small><b>${o.room}</b></div>
        <div class="roomnum"><small>${t('パスワード')}</small><b>${o.pw}</b></div>
      </div>
      <div class="row" style="margin:10px 0"><button class="primary" data-act="olShare">${t('リンクを送る')}</button><button data-act="olCopyLink">${t('リンクをコピー')}</button></div>
      <textarea readonly rows="2" class="backup" onclick="this.select()">${esc(roomLink(o))}</textarea>
      <p class="hint">${t('接続状態')}: ${esc(N.status)}</p>`;
  };
  A.sheets.olName = (s, close) => `<h2>${t('名前変更')} ${close}</h2>
      <div class="row"><input type="text" id="ol-rename" value="${esc(ol().name)}" maxlength="12"><button style="flex:0 0 auto" data-act="olRename">${t('変更')}</button></div>`;
  A.sheets.olRebuy = (s, close) => `<h2>${t('チップを追加（リバイ）')} ${close}</h2>
      <p class="hint">${t('ハンド中は次のハンドから反映されます。')}</p>
      <div class="pm"><button data-act="pm" data-target="#ol-rebuy" data-v="-100">－</button><input type="number" inputmode="numeric" id="ol-rebuy" value="${A.defaultBuyIn()}"><button data-act="pm" data-target="#ol-rebuy" data-v="100">＋</button></div>
      <button class="green big" style="width:100%" data-act="olRebuyDo">${t('チップを追加')}</button>`;
  A.sheets.olPlayer = (s, close) => {
    const g = st().game;
    const p = E.byId(g, s.id);
    if (!p) return '';
    const av = avatarOf(p);
    return `<h2><span class="avatar sm" style="--c:${av.color}">${av.emoji}</span> ${esc(p.name)} ${close}</h2>
      <div class="row"><div>${t('スタック {0}', `<b style="font-size:22px">${fmt(p.stack)}</b>`)}</div><div style="text-align:right;color:var(--muted)">${t('持込合計 {0}', fmt(p.buyIn))}</div></div>
      <div style="margin-top:10px">${chipStack(p.stack, 'sm')}</div>`;
  };

  // ---------- boot ----------
  (async function boot() {
    const q = new URLSearchParams(location.search);
    const room = q.get('room');
    const pw = q.get('pw');
    if (room) history.replaceState(null, '', location.pathname);
    const o = ol();
    if (o && o.role === 'host') {
      st().screen = st().game ? 'table' : 'lobby';
      try { A.render(); } catch (e) { console.error(e); }
      const ok = await startHosting(o);
      if (!ok) A.toast('ルームを開き直せませんでした。メニューからルームを閉じて作り直してください。');
      A.render();
      return;
    }
    if (o && o.role === 'guest' && (!room || room === o.room)) {
      st().screen = st().game ? 'table' : 'lobby';
      try { A.render(); } catch (e) { console.error(e); }
      ui.welcomed = false; ui.joinError = false; ui.helloAt = 0; ui.firstHelloAt = 0;
      await N.join(o.room, o.pw);
      return;
    }
    if (room) {
      ui.join = { room: room.replace(/\D/g, ''), pw: (pw || '').replace(/\D/g, '') };
      st().screen = 'onlineHome';
      A.render();
    }
  })();
})();
