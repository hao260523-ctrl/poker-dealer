/* Poker dealer UI. Renders from `state`, persists to localStorage. */
(() => {
  'use strict';
  const E = window.PokerEngine;
  const KEY = 'pokerDealer.v1';
  const MAX_HISTORY = 40;
  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');

  // ---------- state ----------
  function defaultSetup() {
    return {
      mode: 'cash',
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

  let state = load() || { screen: 'setup', game: null, history: [], setup: defaultSetup(), flip: false };
  if (!state.setup) state.setup = defaultSetup();
  const ui = { sheet: null, showdown: {}, raiseTo: null, editName: '' };

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  // ---------- helpers ----------
  const fmt = (n) => (n == null ? '-' : Number(n).toLocaleString('ja-JP'));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STREET_JA = { preflop: 'プリフロップ', flop: 'フロップ', turn: 'ターン', river: 'リバー', showdown: 'ショーダウン', done: 'ハンド終了' };
  const ANTE_JA = { bb: 'BBアンテ', all: '全員アンテ', none: 'アンテなし' };

  let toastTimer = null;
  function toast(msg, gold) {
    $toast.textContent = msg;
    $toast.className = 'toast' + (gold ? ' gold' : '');
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $toast.hidden = true; }, gold ? 4000 : 2200);
  }

  function pushHistory() {
    state.history.push(E.clone(state.game));
    if (state.history.length > MAX_HISTORY) state.history.shift();
  }

  /** Run a mutation on the game with undo + persistence. */
  function mutate(fn, opts = {}) {
    const undoable = opts.undoable !== false;
    if (undoable) pushHistory();
    try {
      fn(state.game);
    } catch (e) {
      if (undoable) state.history.pop();
      toast(e.message || String(e));
    }
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
    if (b.anteMode !== 'none' && b.ante > 0) s += compact ? ` ${b.anteMode === 'bb' ? 'BBA' : 'A'}${fmt(b.ante)}` : `  ${b.anteMode === 'bb' ? 'BBアンテ' : 'アンテ'} ${fmt(b.ante)}`;
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
    else if (state.screen === 'table') html = renderTable();
    else if (state.screen === 'summary') html = renderSummary();
    if (ui.sheet) html += renderSheet();
    $app.innerHTML = html;
    $app.classList.toggle('flip', !!state.flip && state.screen === 'table');
  }

  // ----- setup -----
  function renderSetup() {
    const s = state.setup;
    const tour = s.mode === 'tournament';
    const resume = state.game ? `<button class="primary big" data-act="resume">前回のゲームを続ける (ハンド ${state.game.handNo})</button><p class="hint" style="text-align:center;margin-bottom:12px">新しく始めると前回のデータは消えます</p>` : '';
    const names = Array.from({ length: s.count }, (_, i) => `
      <div class="nm"><span>${i + 1}</span><input type="text" data-field="name" data-i="${i}" value="${esc(s.names[i] || '')}" placeholder="P${i + 1}" maxlength="10" enterkeyhint="next"></div>`).join('');
    const anteMode = tour ? s.tAnteMode : s.anteMode;
    const anteSeg = (field, cur) => `
      <div class="seg">
        ${['bb', 'all', 'none'].map((m) => `<button data-act="set" data-field="${field}" data-v="${m}" class="${cur === m ? 'on' : ''}">${ANTE_JA[m]}</button>`).join('')}
      </div>`;
    let gameCard;
    if (!tour) {
      gameCard = `
      <div class="card">
        <h3>キャッシュゲーム設定</h3>
        <div class="row">
          <div class="field"><label>初期スタック</label><input type="number" inputmode="numeric" data-field="startStack" value="${s.startStack}"></div>
        </div>
        <div class="row">
          <div class="field"><label>SB</label><input type="number" inputmode="numeric" data-field="sb" value="${s.sb}"></div>
          <div class="field"><label>BB</label><input type="number" inputmode="numeric" data-field="bb" value="${s.bb}"></div>
        </div>
        <div class="field"><label>アンテ</label>${anteSeg('anteMode', s.anteMode)}</div>
        ${s.anteMode !== 'none' ? `<div class="field"><label>アンテ額${s.anteMode === 'bb' ? '（BBが全員分まとめて払う）' : '（全員が毎ハンド払う）'}</label><input type="number" inputmode="numeric" data-field="ante" value="${s.ante}"></div>` : ''}
        <p class="hint">ブラインドやアンテはゲーム中もメニューから変更できます。</p>
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
        <h3>トーナメント設定</h3>
        <div class="row">
          <div class="field"><label>初期スタック</label><input type="number" inputmode="numeric" data-field="tStartStack" value="${s.tStartStack}"></div>
          <div class="field"><label>1レベルの時間（分）</label><input type="number" inputmode="numeric" data-field="levelMinutes" value="${s.levelMinutes}"></div>
        </div>
        <div class="field"><label>アンテ</label>${anteSeg('tAnteMode', s.tAnteMode)}</div>
        <button class="small" data-act="toggleLevels">${s.levelsOpen ? 'ブラインド構成を閉じる' : `ブラインド構成を編集（${s.levels.length}レベル、開始 ${fmt(s.levels[0].sb)}/${fmt(s.levels[0].bb)}）`}</button>
        ${s.levelsOpen ? `
        <div class="scrollx" style="margin-top:10px">
          <table class="levels">
            <thead><tr><th>Lv</th><th>SB</th><th>BB</th>${s.tAnteMode !== 'none' ? '<th>アンテ</th>' : ''}<th>分</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div class="row" style="margin-top:8px">
          <button class="small" data-act="lvAdd">＋ レベル追加</button>
          <button class="small" data-act="lvRemove" ${s.levels.length <= 1 ? 'disabled' : ''}>－ 最後を削除</button>
          <button class="small" data-act="lvReset">初期構成に戻す</button>
        </div>
        <p class="hint">アンテ列を空欄にせず 0 にするとそのレベルはアンテなしです。</p>` : ''}
      </div>`;
    }
    return `
    <div class="screen">
      <h1 class="title">♠ ポーカーディーラー</h1>
      <p class="subtitle">テーブルの真ん中に置いて使うチップ＆手番マネージャー</p>
      ${resume}
      <div class="card">
        <h3>ゲーム形式</h3>
        <div class="seg">
          <button data-act="set" data-field="mode" data-v="cash" class="${!tour ? 'on' : ''}">キャッシュゲーム</button>
          <button data-act="set" data-field="mode" data-v="tournament" class="${tour ? 'on' : ''}">トーナメント</button>
        </div>
      </div>
      <div class="card">
        <h3>プレイヤー</h3>
        <div class="row" style="margin-bottom:10px">
          <label style="flex:1;color:var(--muted)">人数</label>
          <div class="stepper" style="flex:0 0 auto">
            <button data-act="count" data-v="-1" ${s.count <= 2 ? 'disabled' : ''}>－</button>
            <div class="val">${s.count}</div>
            <button data-act="count" data-v="1" ${s.count >= 10 ? 'disabled' : ''}>＋</button>
          </div>
        </div>
        <div class="names">${names}</div>
        <p class="hint">1番から時計回りに座っている順に入力してください。</p>
      </div>
      ${gameCard}
      <button class="primary big" data-act="start">ゲームを始める</button>
      <p class="hint" style="text-align:center">画面は端末に自動保存されます。ブラウザを閉じても続きから再開できます。</p>
    </div>`;
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
        <div class="info">
          <b>${blindsLabel(g.blinds, true)}</b>
          <span>${g.mode === 'tournament' ? `Lv${g.levelIndex + 1} ・ ` : ''}#${h ? h.no : g.handNo + 1}${h ? ' ・ ' + STREET_JA[h.street] : ' ・ 待機中'}</span>
        </div>
        ${timer}
        <button class="icon" data-act="menu">☰</button>
      </div>`;

    // pot
    let pot = '';
    if (h) {
      const total = E.totalPot(h);
      const streetBets = Object.values(h.bets).reduce((a, b) => a + b, 0);
      pot = `<div class="potbox">
        <div class="street">${STREET_JA[h.street]}</div>
        <div class="pot"><small>POT</small>${fmt(total)}</div>
        ${streetBets > 0 && h.street !== 'done' ? `<div class="sub">前のストリートまで ${fmt(total - streetBets)} ＋ 今のベット ${fmt(streetBets)}</div>` : ''}
      </div>`;
    } else {
      pot = `<div class="potbox"><div class="street">${g.handNo === 0 ? 'ゲーム開始前' : '次のハンド待ち'}</div><div class="pot"><small>POT</small>0</div></div>`;
    }

    // players
    const players = g.players.map((p) => {
      const cls = ['pl'];
      const pos = [];
      if (p.id === dealerId) pos.push('<i class="d">D</i>');
      if (h && p.id === h.sbId && h.sbId !== h.dealerId) pos.push('<i>SB</i>');
      if (h && p.id === h.bbId) pos.push('<i>BB</i>');
      let tag = '';
      if (p.out) { cls.push('out'); tag = `<span class="tag sit">${g.mode === 'tournament' ? '敗退' : '退席'}</span>`; }
      else if (p.sitOut) { cls.push('out'); tag = '<span class="tag sit">離席中</span>'; }
      else if (h && h.inHandIds.includes(p.id)) {
        if (h.folded[p.id]) { cls.push('folded'); tag = '<span class="tag fold">フォールド</span>'; }
        else if (h.street === 'done' && h.result && h.result.won[p.id]) { cls.push('winner'); tag = `<span class="tag win">＋${fmt(h.result.won[p.id])}</span>`; }
        else if (h.allIn[p.id]) { cls.push('allin'); tag = '<span class="tag">オールイン</span>'; }
        else if (h.toAct === p.id) { cls.push('toact'); tag = '<span class="tag act">アクション</span>'; }
      } else if (h && !h.inHandIds.includes(p.id)) { cls.push('out'); tag = '<span class="tag sit">不参加</span>'; }
      else if (p.stack === 0) { tag = '<span class="tag sit">チップ 0</span>'; }
      const bet = h && h.bets[p.id] && h.street !== 'done' ? `<div class="bet">${fmt(h.bets[p.id])}</div>` : '';
      return `<div class="${cls.join(' ')}" data-act="player" data-id="${p.id}">
        <div class="pos">${pos.join('')}</div>
        <div class="name">${esc(p.name)}</div>
        <div class="stack">${fmt(p.stack)}</div>
        ${tag}${bet}
      </div>`;
    }).join('');

    // action panel
    let panel = '';
    if (!h) {
      const can = E.canStartHand(g);
      const alive = g.players.filter((p) => !p.out);
      if (g.mode === 'tournament' && alive.length === 1) {
        panel = `<div class="panel"><div class="msg big">🏆 ${esc(alive[0].name)} の優勝！</div><button class="primary big" style="width:100%" data-act="summary">結果を見る</button></div>`;
      } else {
        panel = `<div class="panel">
          ${g.lastResult ? `<div class="results">${Object.keys(g.lastResult.won).map((id) => `<div><span>${esc(E.byId(g, Number(id)).name)}</span><b>＋${fmt(g.lastResult.won[id])}</b></div>`).join('')}</div>` : ''}
          ${!can ? '<div class="msg">プレイできる人が2人未満です。チップ追加や復帰をしてください。</div>' : ''}
          <button class="primary big" style="width:100%" data-act="deal" ${can ? '' : 'disabled'}>${g.handNo === 0 ? '最初のハンドを配る' : '次のハンドを配る ▶'}</button>
          ${g.handNo === 0 ? '<p class="hint" style="text-align:center">ディーラーはランダムに決まります。指定したい場合はプレイヤーをタップ。</p>' : ''}
        </div>`;
      }
    } else if (h.street === 'done') {
      const r = h.result;
      panel = `<div class="panel">
        <div class="msg big">ハンド終了</div>
        <div class="results">${Object.keys(r.won).map((id) => `<div><span>${esc(E.byId(g, Number(id)).name)}</span><b>＋${fmt(r.won[id])}</b></div>`).join('')}</div>
        <button class="primary big" style="width:100%" data-act="nextHand">次のハンドへ ▶</button>
      </div>`;
    } else if (h.street === 'showdown') {
      const pots = E.computePots(g);
      pots.forEach((pt, i) => { if (pt.eligible.length === 1) ui.showdown[i] = pt.eligible.slice(); });
      const rows = pots.map((pt, i) => {
        const sel = ui.showdown[i] || [];
        return `<div class="pot-row">
          <div class="lbl"><span>${pots.length === 1 ? 'ポット' : i === 0 ? 'メインポット' : `サイドポット ${i}`}</span><b>${fmt(pt.amount)}</b></div>
          <div class="chips">${pt.eligible.map((id) => `<button data-act="pickWinner" data-pot="${i}" data-id="${id}" class="${sel.includes(id) ? 'on' : ''}" ${pt.eligible.length === 1 ? 'disabled' : ''}>${esc(E.byId(g, id).name)}${pt.eligible.length === 1 ? '（返却）' : ''}</button>`).join('')}</div>
        </div>`;
      }).join('');
      const ready = pots.every((pt, i) => (ui.showdown[i] || []).length > 0);
      panel = `<div class="panel">
        <div class="msg big">ショーダウン</div>
        ${h.runout ? '<div class="msg">残りのボードを配ってください。</div>' : ''}
        <div class="msg">勝った人をタップ（引き分けは複数選択）</div>
        <div class="pots">${rows}</div>
        <button class="green big" style="width:100%" data-act="award" ${ready ? '' : 'disabled'}>ポットを配分する</button>
      </div>`;
    } else if (la) {
      const p = E.byId(g, la.playerId);
      const callLabel = la.canCheck ? 'チェック' : la.callIsAllIn ? `コール ${fmt(la.callAmount)}（オールイン）` : `コール ${fmt(la.callAmount)}`;
      const raiseLabel = la.currentBet === 0 ? 'ベット' : 'レイズ';
      panel = `<div class="panel">
        <div class="who"><b>${esc(p.name)}</b> の番<span>スタック ${fmt(la.stack)}${la.currentBet > 0 ? ` ・ 現在のベット ${fmt(la.currentBet)}` : ''}${la.canRaise ? ` ・ 最低${raiseLabel} ${fmt(la.minRaiseTo)}` : ''}</span></div>
        <div class="actions">
          <button class="big" data-act="fold">フォールド</button>
          <button class="big blue" data-act="${la.canCheck ? 'check' : 'call'}">${callLabel}</button>
          <button class="big" data-act="raiseOpen" ${la.canRaise ? '' : 'disabled'}>${raiseLabel}</button>
          <button class="big danger" data-act="allin" ${la.stack > 0 && (la.canRaise || la.callIsAllIn) ? '' : 'disabled'}>オールイン ${fmt(la.maxRaiseTo)}</button>
        </div>
      </div>`;
    }

    const bottom = `<div class="bottombar">
      <button class="undo" data-act="undo" ${state.history.length ? '' : 'disabled'}>↶ 戻す</button>
      <div class="spacer"></div>
      ${h && h.street !== 'done' ? `<span class="hint">最後: ${lastActionLabel(g)}</span>` : ''}
    </div>`;

    return `<div class="screen">${header}${pot}<div class="players">${players}</div><div class="spacer"></div>${panel}${bottom}</div>`;
  }

  function lastActionLabel(g) {
    const a = g.hand && g.hand.lastAction;
    if (!a) return 'ブラインド投入';
    const n = esc(E.byId(g, a.id).name);
    const t = { fold: 'フォールド', check: 'チェック', call: `コール ${fmt(a.amount)}`, raise: `レイズ → ${fmt(a.amount)}`, allin: `オールイン → ${fmt(a.amount)}` }[a.type] || a.type;
    return `${n} ${t}${a.allIn && a.type !== 'allin' ? '（オールイン）' : ''}`;
  }

  // ----- summary -----
  function renderSummary() {
    const g = state.game;
    const rows = E.summary(g).map((r, i) => `<tr><td>${i + 1}. ${esc(r.name)}${r.out && g.mode === 'tournament' ? `<br><small style="color:var(--muted)">ハンド ${r.bustHand} で敗退</small>` : ''}</td><td>${fmt(r.buyIn)}</td><td>${fmt(r.stack)}</td><td class="${r.net > 0 ? 'pos' : r.net < 0 ? 'neg' : ''}">${r.net > 0 ? '+' : ''}${fmt(r.net)}</td></tr>`).join('');
    return `<div class="screen summary">
      <h1 class="title">集計</h1>
      <p class="subtitle">${g.mode === 'tournament' ? 'トーナメント' : 'キャッシュゲーム'} ・ ${g.handNo} ハンド</p>
      <div class="card">
        <table><thead><tr><th>プレイヤー</th><th>持込</th><th>最終</th><th>収支</th></tr></thead><tbody>${rows}</tbody></table>
      </div>
      <button class="big" data-act="backToTable">テーブルに戻る</button>
      <div style="height:10px"></div>
      <button class="primary big" data-act="newGame">新しいゲームを始める</button>
    </div>`;
  }

  // ----- sheets -----
  function renderSheet() {
    const g = state.game;
    const s = ui.sheet;
    let body = '';
    if (s.type === 'menu') {
      body = `<h2>メニュー <button class="icon ghost" data-act="closeSheet">✕</button></h2>
      <div class="menu">
        <button data-act="sheet" data-type="blinds">ブラインド・アンテを変更 <small style="color:var(--muted)">（${blindsLabel(g.blinds)}）</small></button>
        ${g.timer ? '<button data-act="sheet" data-type="levels">レベル・タイマー</button>' : ''}
        <button data-act="sheet" data-type="addPlayer">プレイヤーを追加</button>
        <button data-act="toggleFlip">画面を180°回転 ${state.flip ? '（ON）' : ''}</button>
        ${g.hand && g.hand.street !== 'done' ? '<button data-act="cancelHand">このハンドを中止（ミスディール：チップを返す）</button>' : ''}
        <button data-act="summary">集計を見る</button>
        <button class="danger" data-act="newGameConfirm">ゲームを終了して新規作成</button>
      </div>`;
    } else if (s.type === 'blinds') {
      const b = s.draft;
      body = `<h2>ブラインド・アンテ <button class="icon ghost" data-act="closeSheet">✕</button></h2>
      <div class="row">
        <div class="field"><label>SB</label><input type="number" inputmode="numeric" data-draft="sb" value="${b.sb}"></div>
        <div class="field"><label>BB</label><input type="number" inputmode="numeric" data-draft="bb" value="${b.bb}"></div>
      </div>
      <div class="field"><label>アンテ</label><div class="seg">${['bb', 'all', 'none'].map((m) => `<button data-act="draftAnteMode" data-v="${m}" class="${b.anteMode === m ? 'on' : ''}">${ANTE_JA[m]}</button>`).join('')}</div></div>
      ${b.anteMode !== 'none' ? `<div class="field"><label>アンテ額</label><input type="number" inputmode="numeric" data-draft="ante" value="${b.ante}"></div>` : ''}
      <p class="hint">次のハンドから適用されます。${g.timer ? 'トーナメントではレベルが変わると上書きされます。' : ''}</p>
      <button class="primary big" style="width:100%" data-act="applyBlinds">適用</button>`;
    } else if (s.type === 'levels') {
      const rows = g.levels.map((l, i) => `<tr class="${i === g.levelIndex ? 'cur' : ''}" data-act="setLevel" data-i="${i}"><td>${i + 1}</td><td>${fmt(l.sb)}</td><td>${fmt(l.bb)}</td><td>${fmt(l.ante)}</td><td>${l.minutes}</td></tr>`).join('');
      body = `<h2>レベル・タイマー <button class="icon ghost" data-act="closeSheet">✕</button></h2>
      <div class="row" style="margin-bottom:10px">
        <button data-act="timer">${g.timer.running ? '⏸ 一時停止' : '▶ 再開'}</button>
        <button data-act="timerReset">残り時間をリセット</button>
      </div>
      <div class="row" style="margin-bottom:10px">
        <button data-act="levelDelta" data-v="-1" ${g.levelIndex === 0 ? 'disabled' : ''}>◀ 前のレベル</button>
        <button data-act="levelDelta" data-v="1" ${g.levelIndex >= g.levels.length - 1 ? 'disabled' : ''}>次のレベル ▶</button>
      </div>
      <div class="scrollx"><table class="levels"><thead><tr><th>Lv</th><th>SB</th><th>BB</th><th>アンテ</th><th>分</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="hint">行をタップするとそのレベルに移動します（次のハンドから）。</p>`;
    } else if (s.type === 'addPlayer') {
      body = `<h2>プレイヤーを追加 <button class="icon ghost" data-act="closeSheet">✕</button></h2>
      <div class="field"><label>名前</label><input type="text" id="np-name" placeholder="P${g.players.length + 1}" maxlength="10"></div>
      <div class="field"><label>スタック</label><input type="number" inputmode="numeric" id="np-stack" value="${s.defaultStack}"></div>
      <p class="hint">最後の席（${esc(g.players[g.players.length - 1].name)} の左隣）に座ります。次のハンドから参加。</p>
      <button class="primary big" style="width:100%" data-act="doAddPlayer">追加</button>`;
    } else if (s.type === 'player') {
      const p = E.byId(g, s.id);
      const h = g.hand;
      const inLiveHand = h && h.street !== 'done' && h.inHandIds.includes(p.id) && !h.folded[p.id];
      const idx = E.idxOf(g, p.id);
      body = `<h2>${esc(p.name)} <button class="icon ghost" data-act="closeSheet">✕</button></h2>
      <div class="row" style="margin-bottom:12px"><div>スタック <b style="font-size:22px">${fmt(p.stack)}</b></div><div style="text-align:right;color:var(--muted)">持込合計 ${fmt(p.buyIn)}</div></div>
      ${inLiveHand ? '<p class="hint">ハンド中のプレイヤーはチップ操作できません。ハンド終了後に行ってください。</p>' : `
      <div class="field"><label>チップ追加（リバイ／アドオン）</label>
        <div class="pm"><button data-act="pm" data-target="#chip-amt" data-v="-100">－</button><input type="number" inputmode="numeric" id="chip-amt" value="${s.defaultStack}"><button data-act="pm" data-target="#chip-amt" data-v="100">＋</button></div>
        <button class="green" data-act="doAddChips" data-id="${p.id}">チップを追加</button>
      </div>`}
      <div class="field"><label>名前変更</label><div class="row"><input type="text" id="rename" value="${esc(p.name)}" maxlength="10"><button style="flex:0 0 auto" data-act="doRename" data-id="${p.id}">変更</button></div></div>
      <div class="menu" style="margin-top:8px">
        ${!p.out ? `<button data-act="toggleSit" data-id="${p.id}" ${inLiveHand ? 'disabled' : ''}>${p.sitOut ? '席に戻る' : '一時離席（次のハンドから飛ばす）'}</button>` : ''}
        ${!h || h.street === 'done' ? `<button data-act="setDealer" data-i="${idx}" ${p.out || p.sitOut ? 'disabled' : ''}>次のハンドのディーラーにする</button>` : ''}
        ${g.mode === 'cash' ? (p.out ? `<button data-act="rejoin" data-id="${p.id}">復帰する</button>` : `<button class="ghost" data-act="leave" data-id="${p.id}" ${inLiveHand ? 'disabled' : ''}>退席する（集計には残ります）</button>`) : ''}
        ${g.mode === 'tournament' && p.out ? `<button data-act="rejoin" data-id="${p.id}">復帰させる（リエントリー：上のチップ追加も使用）</button>` : ''}
      </div>`;
    } else if (s.type === 'raise') {
      const la = E.legalActions(g);
      const to = clampRaise(ui.raiseTo, la);
      const pot = la.pot;
      const potTo = (frac) => clampRaise(la.myBet + la.callAmount + Math.round(frac * (pot + la.callAmount)), la);
      const bb = g.hand.blinds.bb;
      const isAllIn = to >= la.maxRaiseTo;
      const label = la.currentBet === 0 ? 'ベット' : 'レイズ';
      body = `<h2>${label}額を決める <button class="icon ghost" data-act="closeSheet">✕</button></h2>
      <div class="raise-amt" id="raise-amt">${fmt(to)}</div>
      <div class="raise-sub" id="raise-sub">${raiseSub(to, la)}</div>
      <input type="range" id="raise-range" min="${la.minRaiseTo}" max="${la.maxRaiseTo}" step="1" value="${to}">
      <div class="quick">
        <button data-act="raiseSet" data-v="${la.minRaiseTo}">最小</button>
        <button data-act="raiseSet" data-v="${potTo(0.5)}">1/2 Pot</button>
        <button data-act="raiseSet" data-v="${potTo(0.75)}">3/4 Pot</button>
        <button data-act="raiseSet" data-v="${potTo(1)}">Pot</button>
        <button data-act="raiseSet" data-v="${la.maxRaiseTo}">全額</button>
      </div>
      <div class="pm">
        <button data-act="raiseDelta" data-v="${-bb}">－${fmt(bb)}</button>
        <input type="number" inputmode="numeric" id="raise-input" value="${to}">
        <button data-act="raiseDelta" data-v="${bb}">＋${fmt(bb)}</button>
      </div>
      <button class="${isAllIn ? 'danger' : 'primary'} big" style="width:100%" data-act="raiseConfirm">${isAllIn ? `オールイン ${fmt(to)}` : `${label} ${fmt(to)} で確定`}</button>`;
    } else if (s.type === 'confirm') {
      body = `<h2>${esc(s.title)} <button class="icon ghost" data-act="closeSheet">✕</button></h2>
      <p>${esc(s.text)}</p>
      <div class="row"><button data-act="closeSheet">キャンセル</button><button class="danger" data-act="${s.act}">${esc(s.ok)}</button></div>`;
    }
    return `<div class="overlay" data-act="overlay"><div class="sheet">${body}</div></div>`;
  }

  function clampRaise(v, la) {
    v = Math.floor(Number(v) || la.minRaiseTo);
    return Math.max(la.minRaiseTo, Math.min(la.maxRaiseTo, v));
  }
  function raiseSub(to, la) {
    const add = to - la.myBet;
    const parts = [`追加で ${fmt(add)}`];
    if (la.currentBet > 0) parts.push(`上乗せ ${fmt(to - la.currentBet)}`);
    parts.push(`残り ${fmt(la.stack - add)}`);
    return parts.join(' ・ ');
  }
  function updateRaiseSheet(to) {
    const la = E.legalActions(state.game);
    to = clampRaise(to, la);
    ui.raiseTo = to;
    const a = document.getElementById('raise-amt');
    if (a) a.textContent = fmt(to);
    const sub = document.getElementById('raise-sub');
    if (sub) sub.textContent = raiseSub(to, la);
    const r = document.getElementById('raise-range');
    if (r && Number(r.value) !== to) r.value = to;
    const inp = document.getElementById('raise-input');
    if (inp && document.activeElement !== inp && Number(inp.value) !== to) inp.value = to;
    const btn = document.querySelector('[data-act="raiseConfirm"]');
    if (btn) {
      const isAllIn = to >= la.maxRaiseTo;
      const label = la.currentBet === 0 ? 'ベット' : 'レイズ';
      btn.className = (isAllIn ? 'danger' : 'primary') + ' big';
      btn.textContent = isAllIn ? `オールイン ${fmt(to)}` : `${label} ${fmt(to)} で確定`;
    }
  }

  // ---------- setup helpers ----------
  function readNum(v, fallback) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  function startGame() {
    const s = state.setup;
    const tour = s.mode === 'tournament';
    const stack = tour ? s.tStartStack : s.startStack;
    if (!(stack > 0)) return toast('初期スタックを入力してください');
    if (!tour && !(s.bb > 0 && s.sb > 0)) return toast('SB / BB を入力してください');
    if (!tour && s.sb > s.bb) return toast('SB は BB 以下にしてください');
    if (tour && s.levels.some((l) => !(l.bb > 0 && l.sb > 0 && l.minutes > 0))) return toast('ブラインド構成に不正な値があります');
    const players = Array.from({ length: s.count }, (_, i) => ({ name: s.names[i], stack }));
    const cfg = {
      mode: s.mode, players,
      sb: s.sb, bb: s.bb, anteMode: s.anteMode, ante: s.anteMode === 'none' ? 0 : s.ante,
    };
    if (tour) {
      cfg.anteMode = s.tAnteMode;
      cfg.levelMinutes = s.levelMinutes;
      cfg.levels = s.levels.map((l) => ({ ...l, ante: s.tAnteMode === 'none' ? 0 : l.ante }));
    }
    state.game = E.createGame(cfg);
    state.history = [];
    state.screen = 'table';
    ui.sheet = null;
    save();
    render();
    requestWakeLock();
  }

  function nextLevelGuess(levels) {
    const last = levels[levels.length - 1];
    const bb = Math.round((last.bb * 1.5) / 100) * 100 || last.bb * 2;
    return { sb: bb / 2, bb, ante: last.ante > 0 ? bb : 0, minutes: last.minutes };
  }

  // ---------- game actions ----------
  const actions = {
    // setup
    set(d) {
      const s = state.setup;
      s[d.field] = d.v;
      if (d.field === 'anteMode' && d.v !== 'none') s.ante = d.v === 'bb' ? s.bb : Math.max(1, Math.round(s.bb / 10));
      if (d.field === 'tAnteMode') s.levels = s.levels.map((l) => ({ ...l, ante: d.v === 'none' ? 0 : d.v === 'bb' ? l.bb : Math.max(1, Math.round(l.bb / 10)) }));
      save(); render();
    },
    count(d) { state.setup.count = Math.max(2, Math.min(10, state.setup.count + Number(d.v))); save(); render(); },
    toggleLevels() { state.setup.levelsOpen = !state.setup.levelsOpen; save(); render(); },
    lvAdd() { state.setup.levels.push(nextLevelGuess(state.setup.levels)); save(); render(); },
    lvRemove() { if (state.setup.levels.length > 1) state.setup.levels.pop(); save(); render(); },
    lvReset() {
      const s = state.setup;
      s.levels = E.defaultLevels(s.levelMinutes || 15).map((l) => ({ ...l, ante: s.tAnteMode === 'none' ? 0 : s.tAnteMode === 'bb' ? l.bb : Math.max(1, Math.round(l.bb / 10)) }));
      save(); render();
    },
    start() { startGame(); },
    resume() { state.screen = 'table'; save(); render(); requestWakeLock(); },

    // table
    deal() { mutate((g) => { E.startHand(g); ui.showdown = {}; announceDealer(g); }); },
    nextHand() { mutate((g) => { E.endHand(g); E.startHand(g); ui.showdown = {}; announceDealer(g); }); },
    fold() { mutate((g) => E.act(g, 'fold')); },
    check() { mutate((g) => E.act(g, 'check')); },
    call() { mutate((g) => E.act(g, 'call')); },
    allin() {
      const la = E.legalActions(state.game);
      ui.sheet = { type: 'confirm', title: 'オールイン', text: `${E.byId(state.game, la.playerId).name} が ${fmt(la.maxRaiseTo)} でオールインします。`, ok: 'オールイン', act: 'allinConfirm' };
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
    levelDelta(d) { mutate((g) => { E.setLevel(g, g.levelIndex + Number(d.v)); ui.sheet.type = 'levels'; }, { undoable: false }); },
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
      if (d.v !== 'none' && !(b.ante > 0)) b.ante = d.v === 'bb' ? b.bb : Math.max(1, Math.round(b.bb / 10));
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
      mutate((g) => { E.addChips(g, Number(d.id), amt); toast(`${E.byId(g, Number(d.id)).name} に ${fmt(amt)} 追加`); });
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
        toast(`${g.players[i].name} が次のディーラーです`);
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
        // carry names into setup for convenience
        const alive = g.players.filter((p) => !p.out || g.mode === 'tournament');
        state.setup.count = Math.max(2, Math.min(10, alive.length));
        alive.slice(0, 10).forEach((p, i) => { state.setup.names[i] = p.name; });
      }
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
    if (g.hand && g.hand.no === 1) toast(`ディーラーは ${E.byId(g, g.hand.dealerId).name} です`, true);
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

  // ---------- timer loop ----------
  setInterval(() => {
    const g = state.game;
    if (!g || !g.timer || !g.timer.running || state.screen !== 'table') return;
    const changed = E.tickTimer(g);
    save();
    if (changed) {
      toast(`ブラインドアップ！ レベル ${g.levelIndex + 1}: ${blindsLabel(g.blinds)}（次のハンドから）`, true);
      vibrate([200, 100, 200]);
      render();
    } else {
      const t = document.getElementById('timer');
      if (t) {
        t.textContent = mmss(g.timer.remainingMs);
        t.parentElement.classList.toggle('warn', g.timer.remainingMs < 60000);
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

  render();
  if (state.screen === 'table') requestWakeLock();
})();
