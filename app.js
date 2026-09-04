/* Poker dealer UI. Renders from `state`, persists to localStorage. */
(() => {
  'use strict';
  const E = window.PokerEngine;
  const DICT = window.POKER_I18N || {};
  const KEY = 'pokerDealer.v1';
  const MAX_HISTORY = 40;
  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');

  // ---------- state ----------
  function defaultSetup() {
    return {
      mode: 'cash',
      cards: false,
      count: 4,
      names: ['', '', '', '', '', '', '', '', '', ''],
      startStack: 1000,
      sb: 5,
      bb: 10,
      anteMode: 'bb',
      ante: 10,
      tStartStack: 10000,
      tAnteMode: 'bb',
      levelMinutes: 15,
      levels: E.defaultLevels(15),
      levelsOpen: false,
    };
  }

  let state = load() || { screen: 'setup', game: null, history: [], setup: defaultSetup(), flip: false, lang: 'ja' };
  if (!state.setup) state.setup = defaultSetup();
  if (!state.lang) state.lang = 'ja';
  const ui = { sheet: null, showdown: {}, raiseTo: null, saveError: false };
  const screens = {};   // extra screens: name -> () => html
  const sheets = {};    // extra sheets: type -> (sheet) => body html
  const hooks = { renderTable: null, tick: null, afterMutate: [] };

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; }
  }

  // IndexedDB mirror: survives in browsers that drop localStorage, and lets us ask for persistent storage.
  const idb = {
    open() {
      return new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) return reject(new Error('no idb'));
        const req = indexedDB.open('pokerDealer', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },
    async get(key) {
      const db = await idb.open();
      return new Promise((resolve, reject) => {
        const r = db.transaction('kv').objectStore('kv').get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    },
    async set(key, val) {
      const db = await idb.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(val, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };

  let saveSeq = 0;
  function save() {
    state.savedAt = Date.now();
    const json = JSON.stringify(state);
    let okLocal = true;
    try { localStorage.setItem(KEY, json); } catch (e) { okLocal = false; }
    const seq = ++saveSeq;
    idb.set(KEY, json).then(() => {
      if (seq === saveSeq && ui.saveError) { ui.saveError = false; renderSaveBanner(); }
    }).catch(() => {
      if (!okLocal && seq === saveSeq) { ui.saveError = true; renderSaveBanner(); }
    });
    if (!okLocal) { ui.saveError = true; renderSaveBanner(); }
  }

  function renderSaveBanner() {
    let el = document.getElementById('savebanner');
    if (!ui.saveError) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'savebanner'; el.className = 'savebanner'; document.body.appendChild(el); }
    el.innerHTML = t('保存できていません。ブラウザの設定（サイトデータのブロック／シークレットモード）を確認してください。');
  }

  /** Adopt the IndexedDB copy if it is newer than what localStorage gave us (e.g. localStorage was wiped). */
  async function recoverFromIdb() {
    try {
      const json = await idb.get(KEY);
      if (!json) return;
      const other = JSON.parse(json);
      const mine = state.savedAt || 0;
      if ((other.savedAt || 0) > mine && (other.game || other.archive)) {
        state = other;
        if (!state.setup) state.setup = defaultSetup();
        if (!state.lang) state.lang = 'ja';
        render();
        toast('保存データを復元しました');
      }
    } catch (e) { /* ignore */ }
  }

  function requestPersistentStorage() {
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* ignore */ }
  }

  // ---------- i18n ----------
  /** args may be strings or {ja, zh} pairs (see pair()); `which` picks the side for bilingual output. */
  const fill = (tpl, args, which = 'ja') => tpl.replace(/\{(\d+)\}/g, (_, i) => {
    const a = args[i];
    if (a == null) return '';
    return typeof a === 'object' ? a[which] : a;
  });

  /** Find the translation for a Japanese template (exact, or with numbers normalised to placeholders). */
  function lookup(ja) {
    const d = DICT[state.lang];
    if (!d) return null;
    if (d[ja]) return { ja, zh: d[ja], args: [] };
    // engine messages arrive with numbers already filled in
    const nums = [];
    const norm = ja.replace(/\d[\d,]*/g, (m) => { nums.push(m); return `{${nums.length - 1}}`; });
    if (d[norm]) return { ja: norm, zh: d[norm], args: nums };
    return null;
  }

  /** HTML: Japanese, or stacked Chinese + small Japanese in zh mode. args must already be HTML-safe. */
  function t(ja, ...args) {
    if (state.lang === 'ja') return fill(ja, args);
    const hit = lookup(ja);
    if (!hit) return fill(ja, args);
    const a = hit.args.length ? hit.args : args;
    return `<span class="bi"><span class="zh">${fill(hit.zh, a, 'zh')}</span><span class="ja">${fill(hit.ja, a, 'ja')}</span></span>`;
  }

  /** A word that must be translated on each side of a bilingual template. */
  function pair(ja) {
    const hit = lookup(ja);
    return { ja, zh: hit ? hit.zh : ja };
  }

  /** Plain text (attributes, document.title). */
  function tt(ja, ...args) {
    if (state.lang === 'ja') return fill(ja, args);
    const hit = lookup(ja);
    if (!hit) return fill(ja, args);
    const a = hit.args.length ? hit.args : args;
    return fill(hit.zh, a, 'zh');
  }

  // ---------- helpers ----------
  const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString('ja-JP'));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STREET_JA = { preflop: 'プリフロップ', flop: 'フロップ', turn: 'ターン', river: 'リバー', showdown: 'ショーダウン', done: 'ハンド終了' };
  const ANTE_JA = { bb: 'BBアンテ', all: '全員アンテ', none: 'アンテなし' };
  const street = (s) => t(STREET_JA[s]);
  const HAND_JA = { high_card: 'ハイカード', pair: 'ワンペア', two_pair: 'ツーペア', three_kind: 'スリーカード', straight: 'ストレート', flush: 'フラッシュ', full_house: 'フルハウス', four_kind: 'フォーカード', straight_flush: 'ストレートフラッシュ' };
  const SUIT_SYM = { s: '♠', h: '♥', d: '♦', c: '♣' };
  function cardHtml(c, cls = '') {
    if (!c) return `<span class="pcard back ${cls}"></span>`;
    const r = c[0] === 'T' ? '10' : c[0];
    return `<span class="pcard ${c[1] === 'h' || c[1] === 'd' ? 'red' : ''} ${cls}"><b>${r}</b><i>${SUIT_SYM[c[1]]}</i></span>`;
  }
  const cardsHtml = (arr, cls = '') => (arr || []).map((c) => cardHtml(c, cls)).join('');
  /** Signed net amount with colour class. */
  const netHtml = (n) => `<b class="net ${n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero'}">${n > 0 ? '+' : ''}${fmt(n)}</b>`;
  /** Result rows for a finished hand: everyone dealt in, sorted by net (then by hand strength). */
  function resultRows(g, r) {
    const net = r.net || {};
    const ids = Object.keys(net).length ? Object.keys(net) : Object.keys(r.won);
    ids.sort((x, y) => (net[y] || 0) - (net[x] || 0) || ((r.hands && r.hands[y] ? r.hands[y].score : 0) - (r.hands && r.hands[x] ? r.hands[x].score : 0)));
    return ids.map((id) => {
      const p = E.byId(g, Number(id));
      const hd = r.hands && r.hands[id];
      const n = net[id] != null ? net[id] : (r.won[id] || 0);
      return `<div class="${n > 0 ? 'win' : n < 0 ? 'lose' : ''}"><span>${esc(p ? p.name : '?')}${hd ? ` <span class="cards-inline">${cardsHtml(hd.cards, 'sm')}</span> <small>${t(HAND_JA[hd.name])}</small>` : ''}</span>${netHtml(n)}</div>`;
    }).join('');
  }
  /** Face-down card that can be "squeezed" (class peel) or turned over (class up). */
  function squeezeHtml(c, up) {
    const red = c && (c[1] === 'h' || c[1] === 'd');
    const r = c ? (c[0] === 'T' ? '10' : c[0]) : '';
    const s = c ? SUIT_SYM[c[1]] : '';
    return `<div class="sq ${up ? 'up' : ''}"><div class="sq-face ${red ? 'red' : ''}"><span class="ix tl"><b>${r}</b><i>${s}</i></span><span class="pip">${s}</span><span class="ix br"><b>${r}</b><i>${s}</i></span></div><div class="sq-back"></div></div>`;
  }
  const b64u = {
    enc: (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    dec: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
  };
  async function encodeState(obj) {
    const json = new TextEncoder().encode(JSON.stringify(obj));
    if (typeof CompressionStream === 'function') {
      try {
        const ab = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
        return 'd.' + b64u.enc(new Uint8Array(ab));
      } catch (e) { /* fall through */ }
    }
    return 'j.' + b64u.enc(json);
  }
  async function decodeState(str) {
    const kind = str.slice(0, 2);
    let bytes = b64u.dec(str.slice(2));
    if (kind === 'd.') bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  const siteUrl = () => `${location.origin}${location.pathname}`;
  function handoffPayload() {
    const g = E.clone(state.game);
    if (g) { g.handLog = (g.handLog || []).slice(-30); if (g.hand) delete g.hand.actions; }
    return { v: 1, game: g, lang: state.lang, at: Date.now() };
  }

  let toastTimer = null;
  /** msg is a Japanese template; args must be HTML-safe. */
  function toast(msg, args = [], gold = false) {
    $toast.innerHTML = t(msg, ...args);
    $toast.className = 'toast' + (gold ? ' gold' : '');
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $toast.hidden = true; }, gold ? 4000 : 2400);
  }

  function pushHistory() {
    state.history.push(E.clone(state.game));
    if (state.history.length > MAX_HISTORY) state.history.shift();
  }

  /** Run a mutation on the game with undo + persistence. */
  function mutate(fn, opts = {}) {
    const undoable = opts.undoable !== false;
    if (undoable) pushHistory();
    let ok = true;
    try {
      fn(state.game);
    } catch (e) {
      ok = false;
      if (undoable) state.history.pop();
      toast(esc(e.message || String(e)));
    }
    if (ok) for (const f of hooks.afterMutate) { try { f(); } catch (e) { console.error(e); } }
    save();
    render();
  }

  function undo() {
    const g = state.history.pop();
    if (!g) return toast('戻せる操作がありません');
    state.game = g;
    ui.sheet = null;
    ui.showdown = {};
    save();
    render();
    toast('1つ戻しました');
  }

  function blindsLabel(b, compact) {
    let s = compact ? `${fmt(b.sb)}/${fmt(b.bb)}` : `${fmt(b.sb)} / ${fmt(b.bb)}`;
    if (b.anteMode !== 'none' && b.ante > 0) s += compact ? ` ${b.anteMode === 'bb' ? 'BBA' : 'A'}${fmt(b.ante)}` : `  ${tt(b.anteMode === 'bb' ? 'BBアンテ' : 'アンテ')} ${fmt(b.ante)}`;
    return s;
  }

  function mmss(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // ---------- render ----------
  function render() {
    let html = '';
    if (state.screen === 'setup') html = renderSetup();
    else if (state.screen === 'table') html = (hooks.renderTable && hooks.renderTable()) || renderTable();
    else if (state.screen === 'summary') html = renderSummary(state.game, false);
    else if (state.screen === 'archiveSummary' && state.archive) html = renderSummary(state.archive.game, true);
    else if (screens[state.screen]) html = screens[state.screen]();
    if (ui.sheet) html += renderSheet();
    $app.innerHTML = html;
    $app.classList.toggle('flip', !!state.flip && state.screen === 'table');
    document.documentElement.lang = state.lang === 'zh' ? 'zh-Hans' : 'ja';
    document.documentElement.classList.toggle('lang-zh', state.lang === 'zh');
    document.title = tt('ポーカーディーラー');
  }

  function langSeg() {
    return `<div class="seg lang">
      <button data-act="lang" data-v="ja" class="${state.lang === 'ja' ? 'on' : ''}">日本語</button>
      <button data-act="lang" data-v="zh" class="${state.lang === 'zh' ? 'on' : ''}">中文</button>
    </div>`;
  }

  // ----- setup -----
  const anteSeg = (field, cur) => `
      <div class="seg">
        ${['bb', 'all', 'none'].map((m) => `<button data-act="set" data-field="${field}" data-v="${m}" class="${cur === m ? 'on' : ''}">${t(ANTE_JA[m])}</button>`).join('')}
      </div>`;

  function renderSetup() {
    const s = state.setup;
    const tour = s.mode === 'tournament';
    let resume = '';
    if (state.game) {
      resume = `<button class="primary big" data-act="resume">${t('前回のゲームを続ける (ハンド {0})', state.game.handNo)}</button><p class="hint" style="text-align:center;margin-bottom:12px">${t('新しく始めると前回のデータは消えます')}</p>`;
    } else if (state.archive && state.archive.game) {
      const a = state.archive;
      resume = `<div class="card archive">
        <h3>${t('前回のゲーム')}</h3>
        <p class="hint" style="margin:0 0 10px">${t(a.game.mode === 'tournament' ? 'トーナメント' : 'キャッシュゲーム')} ・ ${t('{0} ハンド', a.game.handNo)} ・ ${new Date(a.endedAt).toLocaleString()}</p>
        <div class="row">
          <button data-act="archiveSummary">${t('結果を見る')}</button>
          <button data-act="restoreArchive">${t('復元して続ける')}</button>
        </div>
        <p class="hint">${t('次のゲームが終わるまで保管されます。')}</p>
      </div>`;
    }
    const names = Array.from({ length: s.count }, (_, i) => `
      <div class="nm"><span>${i + 1}</span><input type="text" data-field="name" data-i="${i}" value="${esc(s.names[i] || '')}" placeholder="P${i + 1}" maxlength="10" enterkeyhint="next"></div>`).join('');
    const gameCard = renderGameCard(s);
    return `
    <div class="screen">
      <h1 class="title">♠ ${t('ポーカーディーラー')}</h1>
      <p class="subtitle">${t('テーブルの真ん中に置いて使うチップ＆手番マネージャー')}</p>
      ${resume}
      <div class="card">
        <div class="row"><h3 style="margin:0">${t('言語')}${state.lang === 'ja' ? ' / 语言' : ''}</h3><div style="flex:0 0 auto;min-width:200px">${langSeg()}</div></div>
      </div>
      <div class="card">
        <h3>${t('遊び方')}</h3>
        <div class="row">
          <button class="big" style="flex:1" data-act="olHome">${t('各自のスマホで（ルーム）')}</button>
        </div>
        <p class="hint">${t('友達と同じリンクを開き、ルーム番号とパスワードで集まって遊びます。手札は自分のスマホにだけ表示されます。下は「この1台で遊ぶ」設定です。')}</p>
      </div>
      ${renderModeCard(s)}
      ${renderCardsCard(s)}
      <div class="card">
        <h3>${t('プレイヤー')}</h3>
        <div class="row" style="margin-bottom:10px">
          <label style="flex:1;color:var(--muted)">${t('人数')}</label>
          <div class="stepper" style="flex:0 0 auto">
            <button data-act="count" data-v="-1" ${s.count <= 2 ? 'disabled' : ''}>－</button>
            <div class="val">${s.count}</div>
            <button data-act="count" data-v="1" ${s.count >= 10 ? 'disabled' : ''}>＋</button>
          </div>
        </div>
        <div class="names">${names}</div>
        <p class="hint">${t('1番から時計回りに座っている順に入力してください。')}</p>
      </div>
      ${gameCard}
      <button class="primary big" data-act="start">${t('ゲームを始める')}</button>
      <p class="hint" style="text-align:center">${t('画面は端末に自動保存されます。ブラウザを閉じても続きから再開できます。')}</p>
      <div class="row" style="margin-top:6px"><button class="small ghost" data-act="shareSite">${t('このアプリのリンクを共有')}</button><button class="small ghost" data-act="sheet" data-type="restoreBackup">${t('バックアップ文字列から復元')}</button></div>
    </div>`;
  }

  function renderModeCard(s) {
    const tour = s.mode === 'tournament';
    return `<div class="card">
        <h3>${t('ゲーム形式')}</h3>
        <div class="seg">
          <button data-act="set" data-field="mode" data-v="cash" class="${!tour ? 'on' : ''}">${t('キャッシュゲーム')}</button>
          <button data-act="set" data-field="mode" data-v="tournament" class="${tour ? 'on' : ''}">${t('トーナメント')}</button>
        </div>
      </div>`;
  }

  function renderCardsCard(s) {
    return `<div class="card">
        <h3>${t('カード')}</h3>
        <div class="seg">
          <button data-act="setCards" data-v="0" class="${!s.cards ? 'on' : ''}">${t('トランプを使う')}</button>
          <button data-act="setCards" data-v="1" class="${s.cards ? 'on' : ''}">${t('アプリが配る')}</button>
        </div>
        <p class="hint">${t(s.cards ? 'アプリがカードを配り、役の判定と配分も自動で行います。自分の手札は手番のときに「手札を見る」を長押しして確認します。' : 'カードは実物のトランプで配ります。アプリはチップと手番だけを管理し、勝者はタップで選びます。')}</p>
      </div>`;
  }

  function renderGameCard(s) {
    const tour = s.mode === 'tournament';
    let gameCard;
    if (!tour) {
      gameCard = `
      <div class="card">
        <h3>${t('キャッシュゲーム設定')}</h3>
        <div class="row">
          <div class="field"><label>${t('初期スタック')}</label><input type="number" inputmode="numeric" data-field="startStack" value="${s.startStack}"></div>
        </div>
        <div class="row">
          <div class="field"><label>SB</label><input type="number" inputmode="numeric" data-field="sb" value="${s.sb}"></div>
          <div class="field"><label>BB</label><input type="number" inputmode="numeric" data-field="bb" value="${s.bb}"></div>
        </div>
        <div class="field"><label>${t('アンテ')}</label>${anteSeg('anteMode', s.anteMode)}</div>
        ${s.anteMode !== 'none' ? `<div class="field"><label>${t(s.anteMode === 'bb' ? 'アンテ額（BBが全員分まとめて払う）' : 'アンテ額（全員が毎ハンド払う）')}</label><input type="number" inputmode="numeric" data-field="ante" value="${s.ante}"></div>` : ''}
        <p class="hint">${t('ブラインドやアンテはゲーム中もメニューから変更できます。')}</p>
      </div>`;
    } else {
      const rows = s.levels.map((l, i) => `
        <tr>
          <td>${i + 1}</td>
          <td><input type="number" inputmode="numeric" data-field="lv" data-i="${i}" data-k="sb" value="${l.sb}"></td>
          <td><input type="number" inputmode="numeric" data-field="lv" data-i="${i}" data-k="bb" value="${l.bb}"></td>
          ${s.tAnteMode !== 'none' ? `<td><input type="number" inputmode="numeric" data-field="lv" data-i="${i}" data-k="ante" value="${l.ante}"></td>` : ''}
          <td><input type="number" inputmode="numeric" data-field="lv" data-i="${i}" data-k="minutes" value="${l.minutes}"></td>
        </tr>`).join('');
      gameCard = `
      <div class="card">
        <h3>${t('トーナメント設定')}</h3>
        <div class="row">
          <div class="field"><label>${t('初期スタック')}</label><input type="number" inputmode="numeric" data-field="tStartStack" value="${s.tStartStack}"></div>
          <div class="field"><label>${t('1レベルの時間（分）')}</label><input type="number" inputmode="numeric" data-field="levelMinutes" value="${s.levelMinutes}"></div>
        </div>
        <div class="field"><label>${t('アンテ')}</label>${anteSeg('tAnteMode', s.tAnteMode)}</div>
        <button class="small" data-act="toggleLevels">${s.levelsOpen ? t('ブラインド構成を閉じる') : t('ブラインド構成を編集（{0}レベル、開始 {1}）', s.levels.length, `${fmt(s.levels[0].sb)}/${fmt(s.levels[0].bb)}`)}</button>
        ${s.levelsOpen ? `
        <div class="scrollx" style="margin-top:10px">
          <table class="levels">
            <thead><tr><th>Lv</th><th>SB</th><th>BB</th>${s.tAnteMode !== 'none' ? `<th>${t('アンテ')}</th>` : ''}<th>${t('分')}</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="row" style="margin-top:8px">
          <button class="small" data-act="lvAdd">${t('＋ レベル追加')}</button>
          <button class="small" data-act="lvRemove" ${s.levels.length <= 1 ? 'disabled' : ''}>${t('－ 最後を削除')}</button>
          <button class="small" data-act="lvReset">${t('初期構成に戻す')}</button>
        </div>
        <p class="hint">${t('アンテ列を空欄にせず 0 にするとそのレベルはアンテなしです。')}</p>` : ''}
      </div>`;
    }
    return gameCard;
  }

  // ----- table -----
  function renderTable() {
    const g = state.game;
    const h = g.hand;
    const la = h && h.toAct != null ? E.legalActions(g) : null;
    const dealerId = h ? h.dealerId : (g.dealerIdx >= 0 ? g.players[g.dealerIdx].id : null);

    // header
    let timer = '';
    if (g.timer) {
      const cls = ['timer', g.timer.running ? '' : 'paused', g.timer.remainingMs < 60000 ? 'warn' : ''].join(' ');
      timer = `<div class="${cls}"><span class="t" id="timer">${mmss(g.timer.remainingMs)}</span><button class="icon ghost" data-act="timer">${g.timer.running ? '⏸' : '▶'}</button></div>`;
    }
    const header = `
      <div class="topbar">
        <div class="info" data-act="sheet" data-type="blinds" role="button">
          <b>${blindsLabel(g.blinds, true)} <small class="edit">✎</small></b>
          <span>${g.mode === 'tournament' ? `Lv${g.levelIndex + 1} ・ ` : ''}#${h ? h.no : g.handNo + 1} ・ ${h ? street(h.street) : t('待機中')}</span>
        </div>
        ${timer}
        <button class="icon" data-act="menu">☰</button>
      </div>`;

    // pot
    let pot = '';
    if (h) {
      const total = E.totalPot(h);
      const streetBets = Object.values(h.bets).reduce((a, b) => a + b, 0);
      const board = g.cards ? `<div class="board">${cardsHtml(h.board, 'md')}${'<span class="pcard slot md"></span>'.repeat(Math.max(0, 5 - (h.board || []).length))}</div>` : '';
      pot = `<div class="potbox">
        <div class="street">${street(h.street)}</div>
        <div class="pot"><small>POT</small>${fmt(total)}</div>
        ${board}
        ${streetBets > 0 && h.street !== 'done' ? `<div class="sub">${t('前のストリートまで {0} ＋ 今のベット {1}', fmt(total - streetBets), fmt(streetBets))}</div>` : ''}
      </div>`;
    } else {
      pot = `<div class="potbox"><div class="street">${t(g.handNo === 0 ? 'ゲーム開始前' : '次のハンド待ち')}</div><div class="pot"><small>POT</small>0</div></div>`;
    }

    // players
    const players = g.players.map((p) => {
      const cls = ['pl'];
      const pos = [];
      if (p.id === dealerId) pos.push('<i class="d">D</i>');
      if (h && p.id === h.sbId && h.sbId !== h.dealerId) pos.push('<i>SB</i>');
      if (h && p.id === h.bbId) pos.push('<i>BB</i>');
      let tag = '';
      if (p.out) { cls.push('out'); tag = `<span class="tag sit">${t(g.mode === 'tournament' ? '敗退' : '退席')}</span>`; }
      else if (p.sitOut) { cls.push('out'); tag = `<span class="tag sit">${t('離席中')}</span>`; }
      else if (h && h.inHandIds.includes(p.id)) {
        if (h.folded[p.id]) { cls.push('folded'); tag = `<span class="tag fold">${t('フォールド')}</span>`; }
        else if (h.street === 'done' && h.result && h.result.net && h.result.net[p.id] != null) { const n = h.result.net[p.id]; if (n > 0) cls.push('winner'); tag = `<span class="tag ${n > 0 ? 'win' : n < 0 ? 'lose' : 'sit'}">${n > 0 ? '+' : ''}${fmt(n)}</span>`; }
        else if (h.allIn[p.id]) { cls.push('allin'); tag = `<span class="tag">${t('オールイン')}</span>`; }
        else if (h.toAct === p.id) { cls.push('toact'); tag = `<span class="tag act">${t('アクション')}</span>`; }
      } else if (h && !h.inHandIds.includes(p.id)) { cls.push('out'); tag = `<span class="tag sit">${t('不参加')}</span>`; }
      else if (p.stack === 0) { tag = `<span class="tag sit">${t('チップ 0')}</span>`; }
      const bet = h && h.bets[p.id] && h.street !== 'done' ? `<div class="bet">${fmt(h.bets[p.id])}</div>` : '';
      let mini = '';
      if (g.cards && h && h.inHandIds.includes(p.id) && !h.folded[p.id]) {
        const shown = h.street === 'done' && h.result && h.result.hands && h.result.hands[p.id];
        mini = `<div class="mini">${shown ? cardsHtml(shown.cards, 'sm') : cardHtml(null, 'sm') + cardHtml(null, 'sm')}${shown ? `<span class="handname">${t(HAND_JA[shown.name])}</span>` : ''}</div>`;
      }
      return `<div class="${cls.join(' ')}" data-act="player" data-id="${p.id}">
        <div class="pos">${pos.join('')}</div>
        <div class="name">${esc(p.name)}</div>
        <div class="stack">${fmt(p.stack)}</div>
        ${tag}${mini}${bet}
      </div>`;
    }).join('');

    // action panel
    let panel = '';
    if (!h) {
      const can = E.canStartHand(g);
      const alive = g.players.filter((p) => !p.out);
      if (g.mode === 'tournament' && alive.length === 1) {
        panel = `<div class="panel"><div class="msg big">${t('🏆 {0} の優勝！', esc(alive[0].name))}</div><button class="primary big" style="width:100%" data-act="summary">${t('結果を見る')}</button></div>`;
      } else {
        panel = `<div class="panel">
          ${g.lastResult ? `<div class="results">${resultRows(g, g.lastResult)}</div>` : ''}
          ${!can ? `<div class="msg">${t('プレイできる人が2人未満です。チップ追加や復帰をしてください。')}</div>` : ''}
          <button class="primary big" style="width:100%" data-act="deal" ${can ? '' : 'disabled'}>${t(g.handNo === 0 ? '最初のハンドを配る' : '次のハンドを配る ▶')}</button>
          ${g.handNo === 0 ? `<p class="hint" style="text-align:center">${t('ディーラーはランダムに決まります。指定したい場合はプレイヤーをタップ。')}</p>` : ''}
        </div>`;
      }
    } else if (h.street === 'done') {
      const r = h.result;
      const rows = resultRows(g, r);
      panel = `<div class="panel">
        <div class="msg big">${t(r.showdown ? 'ショーダウン' : 'ハンド終了')}</div>
        <div class="results">${rows}</div>
        <button class="primary big" style="width:100%" data-act="nextHand">${t('次のハンドへ ▶')}</button>
      </div>`;
    } else if (h.street === 'showdown') {
      const pots = E.computePots(g);
      pots.forEach((pt, i) => { if (pt.eligible.length === 1) ui.showdown[i] = pt.eligible.slice(); });
      const rows = pots.map((pt, i) => {
        const sel = ui.showdown[i] || [];
        const label = pots.length === 1 ? t('ポット') : i === 0 ? t('メインポット') : t('サイドポット {0}', i);
        return `<div class="pot-row">
          <div class="lbl"><span>${label}</span><b>${fmt(pt.amount)}</b></div>
          <div class="chips">${pt.eligible.map((id) => `<button data-act="pickWinner" data-pot="${i}" data-id="${id}" class="${sel.includes(id) ? 'on' : ''}" ${pt.eligible.length === 1 ? 'disabled' : ''}>${esc(E.byId(g, id).name)}${pt.eligible.length === 1 ? t('（返却）') : ''}</button>`).join('')}</div>
        </div>`;
      }).join('');
      const ready = pots.every((pt, i) => (ui.showdown[i] || []).length > 0);
      panel = `<div class="panel">
        <div class="msg big">${t('ショーダウン')}</div>
        ${h.runout ? `<div class="msg">${t('残りのボードを配ってください。')}</div>` : ''}
        <div class="msg">${t('勝った人をタップ（引き分けは複数選択）')}</div>
        <div class="pots">${rows}</div>
        <button class="green big" style="width:100%" data-act="award" ${ready ? '' : 'disabled'}>${t('ポットを配分する')}</button>
      </div>`;
    } else if (la) {
      const p = E.byId(g, la.playerId);
      const callLabel = la.canCheck ? t('チェック') : la.callIsAllIn ? t('コール {0}（オールイン）', fmt(la.callAmount)) : t('コール {0}', fmt(la.callAmount));
      const raiseWord = la.currentBet === 0 ? 'ベット' : 'レイズ';
      let info;
      if (la.currentBet > 0 && la.canRaise) info = t('スタック {0} ・ 現在のベット {1} ・ 最低{2} {3}', fmt(la.stack), fmt(la.currentBet), pair(raiseWord), fmt(la.minRaiseTo));
      else if (la.currentBet > 0) info = t('スタック {0} ・ 現在のベット {1}', fmt(la.stack), fmt(la.currentBet));
      else if (la.canRaise) info = t('スタック {0} ・ 最低{1} {2}', fmt(la.stack), pair(raiseWord), fmt(la.minRaiseTo));
      else info = t('スタック {0}', fmt(la.stack));
      const peek = g.cards ? `<div class="peekwrap"><div class="hole" id="hole-view"></div><button class="peek" data-peek="${p.id}">👁 ${t('手札を見る（長押し）')}</button></div>` : '';
      panel = `<div class="panel">
        <div class="who">${t('{0} の番', `<b>${esc(p.name)}</b>`)}<span>${info}</span></div>
        ${peek}
        <div class="actions">
          <button class="big blue ${la.canCheck ? 'dim' : ''}" data-act="fold">${t('フォールド')}</button>
          <button class="big green" data-act="${la.canCheck ? 'check' : 'call'}">${callLabel}</button>
          <button class="big danger" data-act="raiseOpen" ${la.canRaise ? '' : 'disabled'}>${t(raiseWord)}</button>
          <button class="big purple" data-act="allin" ${la.stack > 0 && (la.canRaise || la.callIsAllIn) ? '' : 'disabled'}>${t('オールイン {0}', fmt(la.maxRaiseTo))}</button>
        </div>
      </div>`;
    }

    const bottom = `<div class="bottombar">
      <button class="undo" data-act="undo" ${state.history.length ? '' : 'disabled'}>${t('↶ 戻す')}</button>
      <div class="spacer"></div>
      ${h && h.street !== 'done' ? `<span class="hint">${t('最後: {0}', lastActionLabel(g))}</span>` : ''}
    </div>`;

    return `<div class="screen">${header}${pot}<div class="players">${players}</div><div class="spacer"></div>${panel}${bottom}</div>`;
  }

  function lastActionLabel(g) {
    const a = g.hand && g.hand.lastAction;
    if (!a) return tt('ブラインド投入');
    const n = esc(E.byId(g, a.id).name);
    const tpl = { fold: 'フォールド', check: 'チェック', call: 'コール {0}', raise: 'レイズ → {0}', allin: 'オールイン → {0}' }[a.type] || a.type;
    return `${n} ${tt(tpl, fmt(a.amount))}${a.allIn && a.type !== 'allin' ? tt('（オールイン）') : ''}`;
  }

  // ----- summary -----
  function renderSummary(g, isArchive) {
    const rows = E.summary(g).map((r, i) => `<tr><td>${i + 1}. ${esc(r.name)}${r.out && g.mode === 'tournament' ? `<br><small style="color:var(--muted)">${t('ハンド {0} で敗退', r.bustHand)}</small>` : ''}</td><td>${fmt(r.buyIn)}</td><td>${fmt(r.stack)}</td><td class="${r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : ''}">${r.net > 0 ? '+' : ''}${fmt(r.net)}</td></tr>`).join('');
    return `<div class="screen summary">
      <h1 class="title">${t('集計')}</h1>
      <p class="subtitle">${t(g.mode === 'tournament' ? 'トーナメント' : 'キャッシュゲーム')} ・ ${t('{0} ハンド', g.handNo)}</p>
      <div class="card">
        <table><thead><tr><th>${t('プレイヤー')}</th><th>${t('持込')}</th><th>${t('最終')}</th><th>${t('収支')}</th></tr></thead><tbody>${rows}</tbody></table>
      </div>
      ${isArchive ? `<button class="big" data-act="backToSetup">${t('設定に戻る')}</button>` : `<button class="big" data-act="backToTable">${t('テーブルに戻る')}</button>
      <div style="height:10px"></div>
      <button class="primary big" data-act="newGame">${t('新しいゲームを始める')}</button>`}
    </div>`;
  }

  // ----- sheets -----
  function renderSheet() {
    const g = state.game;
    const s = ui.sheet;
    const close = '<button class="icon ghost" data-act="closeSheet">✕</button>';
    let body = '';
    if (s.type === 'menu') {
      body = `<h2>${t('メニュー')} ${close}</h2>
      <div class="menu">
        <button data-act="sheet" data-type="blinds">${t('ブラインド・アンテを変更')} <small style="color:var(--muted)">（${blindsLabel(g.blinds)}）</small></button>
        ${g.timer ? `<button data-act="sheet" data-type="levels">${t('レベル・タイマー')}</button>` : ''}
        <button data-act="sheet" data-type="addPlayer">${t('プレイヤーを追加')}</button>
        <button data-act="toggleFlip">${t('画面を180°回転')} ${state.flip ? t('（ON）') : ''}</button>
        <div class="row" style="margin-bottom:8px"><span style="flex:0 0 auto;color:var(--muted)">${t('言語')}${state.lang === 'ja' ? ' / 语言' : ''}</span>${langSeg()}</div>
        ${g.hand && g.hand.street !== 'done' ? `<button data-act="cancelHand">${t('このハンドを中止（ミスディール：チップを返す）')}</button>` : ''}
        <button data-act="sheet" data-type="history">${t('ハンド履歴・復元')} <small style="color:var(--muted)">（${t('{0} ハンド', (g.handLog || []).length)}）</small></button>
        <button data-act="shareSite">${t('このアプリのリンクを共有')} <small style="color:var(--muted)">${esc(siteUrl())}</small></button>
        <button data-act="handoff">${t('別の携帯に引き継ぐ（リンク）')}</button>
        <button data-act="copyBackup">${t('バックアップ文字列をコピー')}</button>
        <button data-act="summary">${t('集計を見る')}</button>
        <button class="danger" data-act="newGameConfirm">${t('ゲームを終了して新規作成')}</button>
      </div>`;
    } else if (s.type === 'blinds') {
      const b = s.draft;
      body = `<h2>${t('ブラインド・アンテ')} ${close}</h2>
      <div class="row">
        <div class="field"><label>SB</label><input type="number" inputmode="numeric" data-draft="sb" value="${b.sb}"></div>
        <div class="field"><label>BB</label><input type="number" inputmode="numeric" data-draft="bb" value="${b.bb}"></div>
      </div>
      <div class="field"><label>${t('アンテ')}</label><div class="seg">${['bb', 'all', 'none'].map((m) => `<button data-act="draftAnteMode" data-v="${m}" class="${b.anteMode === m ? 'on' : ''}">${t(ANTE_JA[m])}</button>`).join('')}</div></div>
      ${b.anteMode !== 'none' ? `<div class="field"><label>${t('アンテ額')}</label><input type="number" inputmode="numeric" data-draft="ante" value="${b.ante}"></div>` : ''}
      <p class="hint">${t('次のハンドから適用されます。')}${g.timer ? t('トーナメントではレベルが変わると上書きされます。') : ''}</p>
      <button class="primary big" style="width:100%" data-act="applyBlinds">${t('適用')}</button>`;
    } else if (s.type === 'levels') {
      const rows = g.levels.map((l, i) => `<tr class="${i === g.levelIndex ? 'cur' : ''}" data-act="setLevel" data-i="${i}"><td>${i + 1}</td><td>${fmt(l.sb)}</td><td>${fmt(l.bb)}</td><td>${fmt(l.ante)}</td><td>${l.minutes}</td></tr>`).join('');
      body = `<h2>${t('レベル・タイマー')} ${close}</h2>
      <div class="row" style="margin-bottom:10px">
        <button data-act="timer">${t(g.timer.running ? '⏸ 一時停止' : '▶ 再開')}</button>
        <button data-act="timerReset">${t('残り時間をリセット')}</button>
      </div>
      <div class="row" style="margin-bottom:10px">
        <button data-act="levelDelta" data-v="-1" ${g.levelIndex === 0 ? 'disabled' : ''}>${t('◀ 前のレベル')}</button>
        <button data-act="levelDelta" data-v="1" ${g.levelIndex >= g.levels.length - 1 ? 'disabled' : ''}>${t('次のレベル ▶')}</button>
      </div>
      <div class="scrollx"><table class="levels"><thead><tr><th>Lv</th><th>SB</th><th>BB</th><th>${t('アンテ')}</th><th>${t('分')}</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="hint">${t('行をタップするとそのレベルに移動します（次のハンドから）。')}</p>`;
    } else if (s.type === 'addPlayer') {
      body = `<h2>${t('プレイヤーを追加')} ${close}</h2>
      <div class="field"><label>${t('名前')}</label><input type="text" id="np-name" placeholder="P${g.players.length + 1}" maxlength="10"></div>
      <div class="field"><label>${t('スタック')}</label><input type="number" inputmode="numeric" id="np-stack" value="${s.defaultStack}"></div>
      <p class="hint">${t('最後の席（{0} の左隣）に座ります。次のハンドから参加。', esc(g.players[g.players.length - 1].name))}</p>
      <button class="primary big" style="width:100%" data-act="doAddPlayer">${t('追加')}</button>`;
    } else if (s.type === 'player') {
      const p = E.byId(g, s.id);
      const h = g.hand;
      const inLiveHand = h && h.street !== 'done' && h.inHandIds.includes(p.id) && !h.folded[p.id];
      const idx = E.idxOf(g, p.id);
      const canPeek = g.cards && h && h.street !== 'done' && h.hole && h.hole[p.id] && h.inHandIds.includes(p.id) && !h.folded[p.id];
      body = `<h2>${esc(p.name)} ${close}</h2>
      <div class="row" style="margin-bottom:12px"><div>${t('スタック {0}', `<b style="font-size:22px">${fmt(p.stack)}</b>`)}</div><div style="text-align:right;color:var(--muted)">${t('持込合計 {0}', fmt(p.buyIn))}</div></div>
      ${canPeek ? `<div class="peekwrap" style="margin-bottom:12px"><div class="hole" id="hole-view"></div><button class="peek" data-peek="${p.id}">👁 ${t('手札を見る（長押し）')}</button></div>` : ''}
      ${inLiveHand ? `<p class="hint">${t('ハンド中のプレイヤーはチップ操作できません。ハンド終了後に行ってください。')}</p>` : `
      <div class="field"><label>${t('チップ追加（リバイ／アドオン）')}</label>
        <div class="pm"><button data-act="pm" data-target="#chip-amt" data-v="-100">－</button><input type="number" inputmode="numeric" id="chip-amt" value="${s.defaultStack}"><button data-act="pm" data-target="#chip-amt" data-v="100">＋</button></div>
        <button class="green" data-act="doAddChips" data-id="${p.id}">${t('チップを追加')}</button>
      </div>`}
      <div class="field"><label>${t('名前変更')}</label><div class="row"><input type="text" id="rename" value="${esc(p.name)}" maxlength="10"><button style="flex:0 0 auto" data-act="doRename" data-id="${p.id}">${t('変更')}</button></div></div>
      <div class="menu" style="margin-top:8px">
        ${!p.out ? `<button data-act="toggleSit" data-id="${p.id}" ${inLiveHand ? 'disabled' : ''}>${t(p.sitOut ? '席に戻る' : '一時離席（次のハンドから飛ばす）')}</button>` : ''}
        ${!h || h.street === 'done' ? `<button data-act="setDealer" data-i="${idx}" ${p.out || p.sitOut ? 'disabled' : ''}>${t('次のハンドのディーラーにする')}</button>` : ''}
        ${g.mode === 'cash' ? (p.out ? `<button data-act="rejoin" data-id="${p.id}">${t('復帰する')}</button>` : `<button class="ghost" data-act="leave" data-id="${p.id}" ${inLiveHand ? 'disabled' : ''}>${t('退席する（集計には残ります）')}</button>`) : ''}
        ${g.mode === 'tournament' && p.out ? `<button data-act="rejoin" data-id="${p.id}">${t('復帰させる（リエントリー：上のチップ追加も使用）')}</button>` : ''}
      </div>`;
    } else if (s.type === 'raise') {
      const la = E.legalActions(g);
      const to = clampRaise(ui.raiseTo, la);
      const pot = la.pot;
      const potTo = (frac) => clampRaise(la.myBet + la.callAmount + Math.round(frac * (pot + la.callAmount)), la);
      const bb = g.hand.blinds.bb;
      const raiseWord = la.currentBet === 0 ? 'ベット' : 'レイズ';
      body = `<h2>${t('{0}額を決める', pair(raiseWord))} ${close}</h2>
      <div class="raise-amt" id="raise-amt">${fmt(to)}</div>
      <div class="raise-sub" id="raise-sub">${raiseSub(to, la)}</div>
      <input type="range" id="raise-range" min="${la.minRaiseTo}" max="${la.maxRaiseTo}" step="1" value="${to}">
      <div class="quick">
        <button data-act="raiseSet" data-v="${la.minRaiseTo}">${t('最小')}</button>
        <button data-act="raiseSet" data-v="${potTo(0.5)}">1/2 Pot</button>
        <button data-act="raiseSet" data-v="${potTo(0.75)}">3/4 Pot</button>
        <button data-act="raiseSet" data-v="${potTo(1)}">Pot</button>
        <button data-act="raiseSet" data-v="${la.maxRaiseTo}">${t('全額')}</button>
      </div>
      <div class="pm">
        <button data-act="raiseDelta" data-v="${-bb}">－${fmt(bb)}</button>
        <input type="number" inputmode="numeric" id="raise-input" value="${to}">
        <button data-act="raiseDelta" data-v="${bb}">＋${fmt(bb)}</button>
      </div>
      <button class="${to >= la.maxRaiseTo ? 'purple' : 'primary'} big" style="width:100%" data-act="raiseConfirm">${raiseConfirmLabel(to, la)}</button>`;
    } else if (s.type === 'history') {
      const log = (g.handLog || []).slice().reverse();
      const rows = log.map((r) => {
        const src = r.net && Object.keys(r.net).length ? r.net : r.won;
        const winners = Object.keys(src).sort((x, y) => src[y] - src[x]).map((id) => { const p = E.byId(g, Number(id)); const n = src[id]; return `<span class="net ${n > 0 ? 'pos' : n < 0 ? 'neg' : 'zero'}">${esc(p ? p.name : '?')} ${n > 0 ? '+' : ''}${fmt(n)}</span>`; }).join('　');
        const stacks = r.stacks.map(([id, st]) => { const p = E.byId(g, id); return `${esc(p ? p.name : '?')} ${fmt(st)}`; }).join(' / ');
        return `<div class="hist">
          <div class="hist-top"><b>#${r.no}</b><span>${winners}</span><button class="small" data-act="restoreHand" data-no="${r.no}">${t('ここに戻す')}</button></div>
          <div class="hist-stacks">${stacks}</div>
        </div>`;
      }).join('');
      body = `<h2>${t('ハンド履歴・復元')} ${close}</h2>
      <p class="hint" style="margin:0 0 10px">${t('各ハンド終了直後のスタックです。「ここに戻す」でその時点からやり直せます（進行中のハンドは中止されます）。')}</p>
      ${rows || `<p class="hint">${t('まだ終了したハンドがありません。')}</p>`}`;
    } else if (s.type === 'handoff') {
      body = `<h2>${t('別の携帯に引き継ぐ（リンク）')} ${close}</h2>
      <p class="hint" style="margin:0 0 10px">${t('このリンクを LINE などで送ると、開いた携帯で今のゲームを続きから再開できます（進行中のハンドの手札も含みます）。')}</p>
      <div class="row" style="margin-bottom:10px">
        ${navigator.share ? `<button class="primary" data-act="shareHandoff">${t('共有する')}</button>` : ''}
        <button data-act="copyHandoff">${t('リンクをコピー')}</button>
      </div>
      <textarea readonly rows="4" class="backup" onclick="this.select()">${esc(s.url)}</textarea>
      <p class="hint">${t('リンクの長さ: {0} 文字', s.url.length)}</p>`;
    } else if (s.type === 'importConfirm') {
      const gg = s.payload.game;
      const names = gg ? gg.players.map((p) => esc(p.name)).join(', ') : '';
      body = `<h2>${t('引き継ぎデータを読み込む')} ${close}</h2>
      <p>${gg ? `${t(gg.mode === 'tournament' ? 'トーナメント' : 'キャッシュゲーム')} ・ ${t('{0} ハンド', gg.handNo)}<br><small style="color:var(--muted)">${names}</small>` : ''}</p>
      ${state.game ? `<p class="hint">${t('今のゲームは「前回のゲーム」として保管されます。')}</p>` : ''}
      <div class="row"><button data-act="closeSheet">${t('キャンセル')}</button><button class="primary" data-act="doImport">${t('読み込む')}</button></div>`;
    } else if (s.type === 'showSite') {
      body = `<h2>${t('このアプリのリンクを共有')} ${close}</h2>
      <p class="hint" style="margin:0 0 8px">${t('下のリンクを選択してコピーしてください。')}</p>
      <textarea readonly rows="2" class="backup" onclick="this.select()">${esc(s.url)}</textarea>`;
    } else if (s.type === 'showBackup') {
      body = `<h2>${t('バックアップ文字列をコピー')} ${close}</h2>
      <p class="hint" style="margin:0 0 8px">${t('下の文字列を全選択してコピーしてください。')}</p>
      <textarea readonly rows="6" class="backup" onclick="this.select()">${esc(s.payload)}</textarea>`;
    } else if (s.type === 'restoreBackup') {
      body = `<h2>${t('バックアップ文字列から復元')} ${close}</h2>
      <p class="hint" style="margin:0 0 8px">${t('メニューの「バックアップ文字列をコピー」で取った文字列を貼り付けてください。')}</p>
      <textarea id="backup-text" rows="6" class="backup" placeholder="{...}"></textarea>
      <button class="primary big" style="width:100%;margin-top:10px" data-act="doRestoreBackup">${t('復元する')}</button>`;
    } else if (sheets[s.type]) {
      body = sheets[s.type](s, close);
    } else if (s.type === 'confirm') {
      body = `<h2>${t(s.title)} ${close}</h2>
      <p>${t(s.text, ...(s.args || []))}</p>
      <div class="row"><button data-act="closeSheet">${t('キャンセル')}</button><button class="${s.act === 'allinConfirm' ? 'purple' : s.act === 'foldConfirm' ? 'blue' : 'danger'}" data-act="${s.act}">${t(s.ok)}</button></div>`;
    }
    return `<div class="overlay" data-act="overlay"><div class="sheet">${body}</div></div>`;
  }

  function clampRaise(v, la) {
    v = Math.floor(Number(v) || la.minRaiseTo);
    return Math.max(la.minRaiseTo, Math.min(la.maxRaiseTo, v));
  }
  function raiseSub(to, la) {
    const add = to - la.myBet;
    if (la.currentBet > 0) return t('追加で {0} ・ 上乗せ {1} ・ 残り {2}', fmt(add), fmt(to - la.currentBet), fmt(la.stack - add));
    return t('追加で {0} ・ 残り {1}', fmt(add), fmt(la.stack - add));
  }
  function raiseConfirmLabel(to, la) {
    const raiseWord = la.currentBet === 0 ? 'ベット' : 'レイズ';
    return to >= la.maxRaiseTo ? t('オールイン {0}', fmt(to)) : t('{0} {1} で確定', pair(raiseWord), fmt(to));
  }
  function updateRaiseSheet(to) {
    const la = E.legalActions(state.game);
    to = clampRaise(to, la);
    ui.raiseTo = to;
    const a = document.getElementById('raise-amt');
    if (a) a.textContent = fmt(to);
    const sub = document.getElementById('raise-sub');
    if (sub) sub.innerHTML = raiseSub(to, la);
    const r = document.getElementById('raise-range');
    if (r && Number(r.value) !== to) r.value = to;
    const inp = document.getElementById('raise-input');
    if (inp && document.activeElement !== inp && Number(inp.value) !== to) inp.value = to;
    const btn = document.querySelector('[data-act="raiseConfirm"]');
    if (btn) {
      btn.className = (to >= la.maxRaiseTo ? 'purple' : 'primary') + ' big';
      btn.innerHTML = raiseConfirmLabel(to, la);
    }
  }

  // ---------- setup helpers ----------
  function readNum(v, fallback) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  /** Validate the setup form and build an engine config (players filled by caller). Returns null after toasting an error. */
  function buildGameConfig() {
    const s = state.setup;
    const tour = s.mode === 'tournament';
    const stack = tour ? s.tStartStack : s.startStack;
    if (!(stack > 0)) { toast('初期スタックを入力してください'); return null; }
    if (!tour && !(s.bb > 0 && s.sb > 0)) { toast('SB / BB を入力してください'); return null; }
    if (!tour && s.sb > s.bb) { toast('SB は BB 以下にしてください'); return null; }
    if (tour && s.levels.some((l) => !(l.bb > 0 && l.sb > 0 && l.minutes > 0))) { toast('ブラインド構成に不正な値があります'); return null; }
    const cfg = {
      mode: s.mode, players: [], cards: !!s.cards, stack,
      sb: s.sb, bb: s.bb, anteMode: s.anteMode, ante: s.anteMode === 'none' ? 0 : s.ante,
    };
    if (tour) {
      cfg.anteMode = s.tAnteMode;
      cfg.levelMinutes = s.levelMinutes;
      cfg.levels = s.levels.map((l) => ({ ...l, ante: s.tAnteMode === 'none' ? 0 : l.ante }));
    }
    return cfg;
  }

  function startGame() {
    const s = state.setup;
    const cfg = buildGameConfig();
    if (!cfg) return;
    cfg.players = Array.from({ length: s.count }, (_, i) => ({ name: s.names[i], stack: cfg.stack }));
    if (state.game) state.archive = { game: state.game, endedAt: Date.now() };
    state.game = E.createGame(cfg);
    state.history = [];
    state.screen = 'table';
    ui.sheet = null;
    save();
    render();
    requestWakeLock();
    requestPersistentStorage();
  }

  function nextLevelGuess(levels) {
    const last = levels[levels.length - 1];
    const bb = Math.round((last.bb * 1.5) / 100) * 100 || last.bb * 2;
    return { sb: bb / 2, bb, ante: last.ante > 0 ? bb : 0, minutes: last.minutes };
  }

  const anteFor = (mode, bb) => (mode === 'none' ? 0 : mode === 'bb' ? bb : Math.max(1, Math.round(bb / 10)));

  // ---------- game actions ----------
  const actions = {
    // setup
    lang(d) { state.lang = d.v; save(); render(); },
    setCards(d) { state.setup.cards = d.v === '1'; save(); render(); },
    async shareSite() {
      const url = siteUrl();
      const text = tt('ポーカーディーラー：ブラウザで動くポーカーのディーラーアプリ。トランプが無くても遊べます。');
      if (navigator.share) {
        try { await navigator.share({ title: tt('ポーカーディーラー'), text, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
      }
      try { await navigator.clipboard.writeText(url); toast('リンクをコピーしました'); }
      catch (e) { ui.sheet = { type: 'showSite', url }; render(); }
    },
    async handoff() {
      const url = `${location.origin}${location.pathname}#s=${await encodeState(handoffPayload())}`;
      ui.sheet = { type: 'handoff', url };
      render();
    },
    async shareHandoff() {
      try { await navigator.share({ title: tt('ポーカーディーラー'), text: tt('ポーカーの続きはこちら'), url: ui.sheet.url }); } catch (e) { /* cancelled */ }
    },
    async copyHandoff() {
      try { await navigator.clipboard.writeText(ui.sheet.url); toast('リンクをコピーしました'); } catch (e) { toast('コピーできませんでした。下の文字列を選択してコピーしてください。'); }
    },
    doImport() {
      const p = ui.sheet.payload;
      ui.sheet = null;
      if (state.game) state.archive = { game: state.game, endedAt: Date.now() };
      state.game = p.game;
      state.history = [];
      state.screen = 'table';
      if (p.lang) state.lang = p.lang;
      save(); render(); requestWakeLock();
      toast('引き継ぎました');
    },
    set(d) {
      const s = state.setup;
      s[d.field] = d.v;
      if (d.field === 'anteMode' && d.v !== 'none') s.ante = anteFor(d.v, s.bb);
      if (d.field === 'tAnteMode') s.levels = s.levels.map((l) => ({ ...l, ante: anteFor(d.v, l.bb) }));
      save(); render();
    },
    count(d) { state.setup.count = Math.max(2, Math.min(10, state.setup.count + Number(d.v))); save(); render(); },
    toggleLevels() { state.setup.levelsOpen = !state.setup.levelsOpen; save(); render(); },
    lvAdd() { state.setup.levels.push(nextLevelGuess(state.setup.levels)); save(); render(); },
    lvRemove() { if (state.setup.levels.length > 1) state.setup.levels.pop(); save(); render(); },
    lvReset() {
      const s = state.setup;
      s.levels = E.defaultLevels(s.levelMinutes || 15).map((l) => ({ ...l, ante: anteFor(s.tAnteMode, l.bb) }));
      save(); render();
    },
    start() { startGame(); },
    resume() { state.screen = 'table'; save(); render(); requestWakeLock(); },
    archiveSummary() { state.screen = 'archiveSummary'; save(); render(); },
    backToSetup() { state.screen = 'setup'; save(); render(); },
    restoreArchive() {
      if (!state.archive || !state.archive.game) return;
      state.game = state.archive.game;
      state.archive = null;
      state.history = [];
      state.screen = 'table';
      save(); render(); requestWakeLock();
      toast('前回のゲームを復元しました');
    },
    restoreHand(d) {
      ui.sheet = { type: 'confirm', title: 'ハンド履歴・復元', text: 'ハンド #{0} 終了直後の状態に戻します。それ以降の結果は消えます。', args: [d.no], ok: 'ここに戻す', act: 'restoreHandConfirm', no: Number(d.no) };
      render();
    },
    restoreHandConfirm() {
      const no = ui.sheet.no;
      ui.sheet = null;
      mutate((g) => { E.restoreToHand(g, no); ui.showdown = {}; toast('ハンド #{0} の終了時点に戻しました', [no]); });
    },
    async copyBackup() {
      const payload = JSON.stringify({ v: 1, game: state.game, archive: state.archive || null, at: Date.now() });
      ui.sheet = null;
      try {
        await navigator.clipboard.writeText(payload);
        toast('コピーしました。メモ帳などに貼り付けて保存してください。');
      } catch (e) {
        ui.sheet = { type: 'showBackup', payload };
      }
      render();
    },
    doRestoreBackup() {
      let data;
      try { data = JSON.parse(document.getElementById('backup-text').value.trim()); } catch (e) { return toast('文字列を読み取れませんでした'); }
      if (!data || !data.game || !Array.isArray(data.game.players)) return toast('文字列を読み取れませんでした');
      if (state.game) state.archive = { game: state.game, endedAt: Date.now() };
      else if (data.archive) state.archive = data.archive;
      state.game = data.game;
      state.history = [];
      state.screen = 'table';
      ui.sheet = null;
      save(); render(); requestWakeLock();
      toast('バックアップから復元しました');
    },

    // table
    deal() { mutate((g) => { E.startHand(g); ui.showdown = {}; announceDealer(g); }); },
    nextHand() { mutate((g) => { E.endHand(g); E.startHand(g); ui.showdown = {}; announceDealer(g); }); },
    fold() {
      const la = E.legalActions(state.game);
      if (la && la.canCheck) {
        ui.sheet = { type: 'confirm', title: 'フォールド', text: 'チェックできます。本当にフォールドしますか？', ok: 'フォールドする', act: 'foldConfirm' };
        return render();
      }
      mutate((g) => E.act(g, 'fold'));
    },
    foldConfirm() { ui.sheet = null; mutate((g) => E.act(g, 'fold')); },
    check() { mutate((g) => E.act(g, 'check')); },
    call() { mutate((g) => E.act(g, 'call')); },
    allin() {
      const la = E.legalActions(state.game);
      ui.sheet = { type: 'confirm', title: 'オールイン', text: '{0} が {1} でオールインします。', args: [esc(E.byId(state.game, la.playerId).name), fmt(la.maxRaiseTo)], ok: 'オールイン', act: 'allinConfirm' };
      render();
    },
    allinConfirm() { ui.sheet = null; mutate((g) => E.act(g, 'allin')); },
    raiseOpen() {
      const la = E.legalActions(state.game);
      ui.raiseTo = la.minRaiseTo;
      ui.sheet = { type: 'raise' };
      render();
    },
    raiseSet(d) { updateRaiseSheet(Number(d.v)); },
    raiseDelta(d) { updateRaiseSheet((ui.raiseTo || 0) + Number(d.v)); },
    raiseConfirm() {
      const to = ui.raiseTo;
      ui.sheet = null;
      mutate((g) => E.act(g, 'raise', to));
    },
    pickWinner(d) {
      const i = Number(d.pot), id = Number(d.id);
      const sel = ui.showdown[i] || [];
      ui.showdown[i] = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
      render();
    },
    award() {
      const pots = E.computePots(state.game);
      const winners = pots.map((_, i) => ui.showdown[i] || []);
      mutate((g) => { E.awardPots(g, winners); ui.showdown = {}; });
    },
    undo() { undo(); },
    timer() {
      mutate((g) => { if (g.timer.running) E.pauseTimer(g); else E.startTimer(g); }, { undoable: false });
    },
    timerReset() { mutate((g) => { g.timer.remainingMs = g.levels[g.levelIndex].minutes * 60000; g.timer.lastTick = g.timer.running ? Date.now() : null; }, { undoable: false }); },
    levelDelta(d) { mutate((g) => { E.setLevel(g, g.levelIndex + Number(d.v)); }, { undoable: false }); },
    setLevel(d) { mutate((g) => E.setLevel(g, Number(d.i)), { undoable: false }); },
    player(d) { ui.sheet = { type: 'player', id: Number(d.id), defaultStack: defaultBuyIn() }; render(); },
    menu() { ui.sheet = { type: 'menu' }; render(); },
    sheet(d) {
      const g = state.game;
      if (d.type === 'blinds') ui.sheet = { type: 'blinds', draft: { ...g.blinds } };
      else if (d.type === 'addPlayer') ui.sheet = { type: 'addPlayer', defaultStack: defaultBuyIn() };
      else ui.sheet = { type: d.type };
      render();
    },
    closeSheet() { ui.sheet = null; render(); },
    overlay(d, ev) { if (ev.target.classList.contains('overlay')) { ui.sheet = null; render(); } },
    draftAnteMode(d) {
      const b = ui.sheet.draft;
      b.anteMode = d.v;
      if (d.v !== 'none' && !(b.ante > 0)) b.ante = anteFor(d.v, b.bb);
      render();
    },
    applyBlinds() {
      const b = ui.sheet.draft;
      if (!(b.sb > 0 && b.bb > 0) || b.sb > b.bb) return toast('SB / BB の値を確認してください');
      ui.sheet = null;
      mutate((g) => E.setBlinds(g, b.sb, b.bb, b.anteMode === 'none' ? 0 : b.ante, b.anteMode), { undoable: false });
      toast('次のハンドから適用します');
    },
    doAddPlayer() {
      const name = document.getElementById('np-name').value;
      const stack = readNum(document.getElementById('np-stack').value, 0);
      if (!(stack > 0)) return toast('スタックを入力してください');
      ui.sheet = null;
      mutate((g) => E.addPlayer(g, name, stack));
    },
    pm(d) {
      const inp = document.querySelector(d.target);
      inp.value = Math.max(0, readNum(inp.value, 0) + Number(d.v));
    },
    doAddChips(d) {
      const amt = readNum(document.getElementById('chip-amt').value, 0);
      if (!(amt > 0)) return toast('金額を入力してください');
      ui.sheet = null;
      mutate((g) => { E.addChips(g, Number(d.id), amt); toast('{0} に {1} 追加', [esc(E.byId(g, Number(d.id)).name), fmt(amt)]); });
    },
    doRename(d) {
      const v = document.getElementById('rename').value.trim();
      if (!v) return toast('名前を入力してください');
      mutate((g) => { E.byId(g, Number(d.id)).name = v; }, { undoable: false });
      ui.sheet = null; render();
    },
    toggleSit(d) { ui.sheet = null; mutate((g) => { const p = E.byId(g, Number(d.id)); p.sitOut = !p.sitOut; }, { undoable: false }); },
    leave(d) { ui.sheet = null; mutate((g) => { E.byId(g, Number(d.id)).out = true; }, { undoable: false }); },
    rejoin(d) { ui.sheet = null; mutate((g) => { const p = E.byId(g, Number(d.id)); p.out = false; p.sitOut = false; }, { undoable: false }); },
    setDealer(d) {
      const i = Number(d.i);
      ui.sheet = null;
      mutate((g) => {
        if (g.hand) E.endHand(g);
        if (g.handNo === 0) g.firstDealer = i;
        else g.dealerIdx = (i - 1 + g.players.length) % g.players.length;
        toast('{0} が次のディーラーです', [esc(g.players[i].name)]);
      }, { undoable: false });
    },
    toggleFlip() { state.flip = !state.flip; ui.sheet = null; save(); render(); },
    cancelHand() {
      ui.sheet = { type: 'confirm', title: 'ハンドを中止', text: 'このハンドで出したチップを全員に返し、同じディーラーで配り直します。', ok: '中止する', act: 'cancelHandConfirm' };
      render();
    },
    cancelHandConfirm() { ui.sheet = null; mutate((g) => { E.cancelHand(g); ui.showdown = {}; }); },
    summary() { ui.sheet = null; state.screen = 'summary'; save(); render(); },
    backToTable() { state.screen = 'table'; save(); render(); },
    newGameConfirm() {
      ui.sheet = { type: 'confirm', title: 'ゲームを終了', text: '現在のゲームを終了して設定画面に戻ります。集計はここで確認しておいてください。', ok: '終了する', act: 'newGame' };
      render();
    },
    newGame() {
      ui.sheet = null;
      const g = state.game;
      if (g) {
        const alive = g.players.filter((p) => !p.out || g.mode === 'tournament');
        state.setup.count = Math.max(2, Math.min(10, alive.length));
        alive.slice(0, 10).forEach((p, i) => { state.setup.names[i] = p.name; });
      }
      if (g) state.archive = { game: g, endedAt: Date.now() };
      state.game = null;
      state.history = [];
      state.screen = 'setup';
      save(); render();
    },
  };

  function defaultBuyIn() {
    const s = state.setup;
    return state.game && state.game.mode === 'tournament' ? s.tStartStack : s.startStack;
  }

  function announceDealer(g) {
    if (g.hand && g.hand.no === 1) toast('ディーラーは {0} です', [esc(E.byId(g, g.hand.dealerId).name)], true);
  }

  // ---------- events ----------
  $app.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'overlay' && ev.target !== el) return;
    if (!actions[act]) return;
    ev.preventDefault();
    actions[act](el.dataset, ev);
  });

  $app.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.id === 'raise-range' || el.id === 'raise-input') {
      if (el.id === 'raise-input' && el.value === '') return;
      updateRaiseSheet(el.value);
      return;
    }
    if (el.dataset.draft && ui.sheet && ui.sheet.draft) {
      const d = ui.sheet.draft;
      d[el.dataset.draft] = readNum(el.value, 0);
      if (el.dataset.draft === 'bb' && d.anteMode === 'bb') {
        d.ante = d.bb;
        const a = document.querySelector('input[data-draft="ante"]');
        if (a) a.value = d.bb;
      }
      return;
    }
    const f = el.dataset.field;
    if (!f) return;
    const s = state.setup;
    if (f === 'name') s.names[Number(el.dataset.i)] = el.value;
    else if (f === 'lv') s.levels[Number(el.dataset.i)][el.dataset.k] = readNum(el.value, 0);
    else if (f === 'levelMinutes') { s.levelMinutes = readNum(el.value, 15); s.levels.forEach((l) => { l.minutes = s.levelMinutes; }); }
    else s[f] = readNum(el.value, 0);
    if (f === 'bb' && s.anteMode === 'bb') s.ante = s.bb;
    save();
  });
  $app.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.id === 'raise-input') updateRaiseSheet(el.value);
    if (el.dataset.field === 'levelMinutes' || (el.dataset.field === 'bb' && state.setup.anteMode === 'bb')) render();
  });

  // ---------- peek (press and hold to see own hole cards) ----------
  function showHole(id) {
    const g = state.game;
    const h = g && g.hand;
    const el = document.getElementById('hole-view');
    if (!el || !h || !h.hole || !h.hole[id]) return;
    el.innerHTML = h.hole[id].map((c) => squeezeHtml(c, false)).join('');
    el.classList.add('show');
    requestAnimationFrame(() => el.querySelectorAll('.sq').forEach((q) => q.classList.add('peel')));
  }
  function hideHole() {
    const el = document.getElementById('hole-view');
    if (el) { el.classList.remove('show'); el.innerHTML = ''; }
  }
  $app.addEventListener('pointerdown', (ev) => {
    const b = ev.target.closest('[data-peek]');
    if (!b) return;
    ev.preventDefault();
    try { b.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    showHole(Number(b.dataset.peek));
  });
  ['pointerup', 'pointercancel'].forEach((n) => $app.addEventListener(n, (ev) => { if (ev.target.closest('[data-peek]')) hideHole(); }));
  $app.addEventListener('contextmenu', (ev) => { if (ev.target.closest('[data-peek]')) ev.preventDefault(); });
  window.addEventListener('blur', hideHole);

  async function checkHashImport() {
    const m = location.hash.match(/^#s=([A-Za-z0-9._-]+)$/);
    if (!m) return;
    history.replaceState(null, '', location.pathname + location.search);
    try {
      const payload = await decodeState(m[1]);
      if (!payload || !payload.game || !Array.isArray(payload.game.players)) throw new Error('bad');
      ui.sheet = { type: 'importConfirm', payload };
      render();
    } catch (e) {
      toast('引き継ぎリンクを読み取れませんでした');
    }
  }

  // ---------- timer loop ----------
  setInterval(() => {
    if (hooks.tick && hooks.tick()) return;
    const g = state.game;
    if (!g || !g.timer || !g.timer.running || state.screen !== 'table') return;
    const changed = E.tickTimer(g);
    save();
    if (changed) {
      toast('ブラインドアップ！ レベル {0}: {1}（次のハンドから）', [g.levelIndex + 1, blindsLabel(g.blinds)], true);
      vibrate([200, 100, 200]);
      render();
    } else {
      const el = document.getElementById('timer');
      if (el) {
        el.textContent = mmss(g.timer.remainingMs);
        el.parentElement.classList.toggle('warn', g.timer.remainingMs < 60000);
      }
    }
  }, 1000);

  function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch (e) { /* ignore */ } }

  // ---------- wake lock ----------
  let wakeLock = null;
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && state.screen === 'table') wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      requestWakeLock();
      if (state.game && state.game.timer) render();
    }
  });

  window.PokerApp = {
    get state() { return state; },
    set state(v) { state = v; },
    ui, screens, sheets, hooks, actions, E,
    render, save, mutate, toast, t, tt, pair, esc, fmt, mmss, blindsLabel, street, langSeg,
    cardHtml, cardsHtml, squeezeHtml, netHtml, resultRows, HAND_JA, STREET_JA, ANTE_JA,
    renderModeCard, renderCardsCard, renderGameCard, defaultBuyIn, requestWakeLock, requestPersistentStorage, vibrate,
    startGameConfig: () => buildGameConfig(),
    siteUrl,
  };

  render();
  renderSaveBanner();
  if (state.screen === 'table') requestWakeLock();
  recoverFromIdb().then(checkHashImport);
  window.addEventListener('hashchange', checkHashImport);
})();
