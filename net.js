/*
 * Relay transport over public MQTT brokers (WebSocket/TLS). No accounts, works across mobile carriers.
 * Payloads are AES-GCM encrypted with a key derived from room number + password.
 * API (used by online.js): on(), host(), join(), destroy(), kick(), send(), sendHost(), broadcast(), setMeta(), getMeta(),
 *                          status, role, room, connected, conns()
 */
window.PokerNet = (() => {
  'use strict';
  const LIB = 'https://cdnjs.cloudflare.com/ajax/libs/mqtt/5.15.2/mqtt.min.js';
  // Order matters: the first digit of the room number selects the broker (1 -> [0], 2 -> [1], 3 -> [2]).
  const BROKERS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://test.mosquitto.org:8081/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
  const HB_MS = 5000;        // host presence beacon
  const HOST_LOST_MS = 20000; // guest considers host gone
  const GUEST_LOST_MS = 30000; // host considers guest gone (guests ping every 10s)

  let client = null;
  let role = null;
  let status = 'idle'; // idle | loading | connecting | online | reconnecting | waiting-host | error
  let currentRoom = null;
  let topics = null;
  let key = null;
  let myCid = null;
  let hbTimer = null;
  let sweepTimer = null;
  let lastHostSeen = 0;
  let hostWasLost = true;
  const conns = new Map(); // cid -> conn {cid, meta, lastSeen}
  const handlers = {};

  const emit = (n, ...a) => { try { if (handlers[n]) handlers[n](...a); } catch (e) { console.error(e); } };
  const on = (map) => Object.assign(handlers, map);
  const setStatus = (s) => { if (status !== s) { status = s; emit('status', s); } };
  const rndId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const brokerIndex = (room) => Math.max(0, Math.min(BROKERS.length - 1, (Number(String(room)[0]) || 1) - 1));

  async function loadLib() {
    if (window.mqtt) return;
    setStatus('loading');
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = LIB;
      s.onload = res;
      s.onerror = () => rej(new Error('lib'));
      document.head.appendChild(s);
    });
  }

  // ---------- crypto ----------
  const te = new TextEncoder();
  const td = new TextDecoder();
  async function sha256hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', te.encode(str));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function deriveKey(room, secret) {
    const base = await crypto.subtle.importKey('raw', te.encode(`${room}:${secret}`), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: te.encode('pokerdealer:' + room), iterations: 60000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  const b64 = {
    enc: (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); },
    dec: (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
  };
  async function seal(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj))));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv, 0); out.set(ct, 12);
    return b64.enc(out);
  }
  async function open(str) {
    const buf = b64.dec(str);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.subarray(0, 12) }, key, buf.subarray(12));
    return JSON.parse(td.decode(pt));
  }

  // ---------- connection ----------
  function teardown() {
    clearInterval(hbTimer); clearInterval(sweepTimer);
    hbTimer = sweepTimer = null;
    if (client) { try { client.end(true); } catch (e) { /* ignore */ } }
    client = null;
    conns.clear();
    topics = null; key = null; currentRoom = null; role = null;
    lastHostSeen = 0; hostWasLost = true;
  }
  function destroy() { teardown(); setStatus('idle'); }

  function connect(url) {
    return new Promise((resolve, reject) => {
      const c = window.mqtt.connect(url, { connectTimeout: 9000, reconnectPeriod: 2000, keepalive: 30, clean: true, resubscribe: true, clientId: 'pk_' + rndId() });
      let settled = false;
      c.once('connect', () => { settled = true; resolve(c); });
      c.on('error', (e) => { if (!settled) { settled = true; try { c.end(true); } catch (x) { /* ignore */ } reject(e); } });
      setTimeout(() => { if (!settled) { settled = true; try { c.end(true); } catch (x) { /* ignore */ } reject(new Error('timeout')); } }, 10000);
    });
  }

  async function setupTopics(room) {
    const h = (await sha256hex('room:' + room)).slice(0, 20);
    topics = { toHost: `pkdlr/${h}/h`, guest: (cid) => `pkdlr/${h}/g/${cid}`, all: `pkdlr/${h}/all`, pres: `pkdlr/${h}/pres` };
  }

  function wire(c) {
    c.on('reconnect', () => setStatus('reconnecting'));
    c.on('offline', () => setStatus('reconnecting'));
    c.on('close', () => { if (client === c) setStatus('reconnecting'); });
    c.on('connect', () => { if (client === c) { setStatus(role === 'guest' && Date.now() - lastHostSeen > HOST_LOST_MS ? 'waiting-host' : 'online'); if (role === 'guest') { hostWasLost = true; } } });
    c.on('message', (topic, payload) => onRaw(topic, payload.toString()));
  }

  const publish = (topic, str) => { try { if (client && client.connected) client.publish(topic, str, { qos: 0 }); } catch (e) { /* ignore */ } };

  async function onRaw(topic, str) {
    if (!topics) return;
    if (topic === topics.pres) {
      if (role === 'guest') noteHost();
      return;
    }
    let env;
    try { env = await open(str); } catch (e) { return; } // wrong key or garbage
    if (!env || typeof env !== 'object') return;
    if (role === 'host') {
      if (topic !== topics.toHost || !env.from) return;
      let conn = conns.get(env.from);
      if (!conn) { conn = { cid: env.from, meta: {}, lastSeen: Date.now() }; conns.set(env.from, conn); emit('guestOpen', conn); }
      conn.lastSeen = Date.now();
      emit('message', conn, env.msg);
    } else if (role === 'guest') {
      noteHost();
      emit('message', null, env.msg);
    }
  }

  function noteHost() {
    lastHostSeen = Date.now();
    if (hostWasLost) {
      hostWasLost = false;
      setStatus('online');
      emit('open');
    }
  }

  /** Host a room. `room` null -> pick a reachable broker and generate a number whose first digit encodes it. Resolves the room number. */
  async function host(room, secret) {
    await loadLib();
    teardown();
    role = 'host';
    setStatus('connecting');
    let c = null;
    if (room) {
      c = await connect(BROKERS[brokerIndex(room)]);
    } else {
      let lastErr = null;
      for (let i = 0; i < BROKERS.length && !c; i++) {
        try { c = await connect(BROKERS[i]); room = String(i + 1) + String(10000 + Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] % 90000)); } catch (e) { lastErr = e; }
      }
      if (!c) { setStatus('error'); throw lastErr || new Error('no broker'); }
    }
    client = c;
    currentRoom = String(room);
    myCid = 'host';
    key = await deriveKey(currentRoom, secret);
    await setupTopics(currentRoom);
    wire(c);
    c.subscribe(topics.toHost, { qos: 0 });
    hbTimer = setInterval(() => publish(topics.pres, '1'), HB_MS);
    publish(topics.pres, '1');
    sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [cid, conn] of conns) {
        if (now - conn.lastSeen > GUEST_LOST_MS) { conns.delete(cid); emit('close', conn, conn.meta); }
      }
    }, 5000);
    setStatus('online');
    return currentRoom;
  }

  /** Join a room as guest. Keeps the connection alive; `open` fires whenever the host (re)appears. */
  async function join(room, secret) {
    await loadLib();
    teardown();
    role = 'guest';
    currentRoom = String(room);
    setStatus('connecting');
    myCid = rndId();
    key = await deriveKey(currentRoom, secret);
    await setupTopics(currentRoom);
    let c;
    try { c = await connect(BROKERS[brokerIndex(currentRoom)]); } catch (e) { setStatus('error'); emit('error', e); return; }
    client = c;
    wire(c);
    c.subscribe([topics.guest(myCid), topics.all, topics.pres], { qos: 0 });
    setStatus('waiting-host');
    hostWasLost = true;
    // announce ourselves right away; the host answers only if it is up and the key matches
    emit('open');
    sweepTimer = setInterval(() => {
      if (role !== 'guest') return;
      if (Date.now() - lastHostSeen > HOST_LOST_MS && !hostWasLost) { hostWasLost = true; setStatus(client && client.connected ? 'waiting-host' : 'reconnecting'); emit('hostLost'); }
    }, 2000);
  }

  /** Nudge the connection (foreground return): reconnect socket if needed and re-announce. */
  function kick() {
    if (!client) return;
    try { if (!client.connected && !client.reconnecting) client.reconnect(); } catch (e) { /* ignore */ }
    if (role === 'guest') emit('open');
  }

  async function send(conn, msg) {
    if (!client || !topics || !key) return;
    if (role === 'host') { if (!conn) return; publish(topics.guest(conn.cid), await seal({ msg })); }
    else publish(topics.toHost, await seal({ from: myCid, msg }));
  }
  const sendHost = (msg) => send(null, msg);
  async function broadcast(fn) {
    if (role !== 'host') return;
    for (const conn of [...conns.values()]) {
      const msg = typeof fn === 'function' ? fn(conn.meta, conn) : fn;
      if (msg) await send(conn, msg);
    }
  }
  const setMeta = (conn, m) => { if (conn) conn.meta = { ...(conn.meta || {}), ...m }; };
  const getMeta = (conn) => (conn ? conn.meta : null);

  return {
    on, host, join, destroy, kick, send, sendHost, broadcast, setMeta, getMeta,
    get status() { return status; },
    get role() { return role; },
    get room() { return currentRoom; },
    get connected() { return !!(client && client.connected) && (role === 'host' || Date.now() - lastHostSeen < HOST_LOST_MS); },
    get hostSeen() { return lastHostSeen; },
    conns: () => [...conns.values()].map((c) => [c, c.meta]),
  };
})();
