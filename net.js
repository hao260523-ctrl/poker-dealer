/* Thin PeerJS (WebRTC) wrapper: one host, many guests, auto-reconnect. */
window.PokerNet = (() => {
  'use strict';
  const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.4/peerjs.min.js';
  const ICE = {
    iceServers: [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    ],
  };
  let peer = null;
  let role = null;
  let status = 'idle'; // idle | loading | connecting | online | reconnecting | waiting-host | error
  let hostConn = null;
  let retryTimer = null;
  let currentRoom = null;
  const conns = new Map(); // DataConnection -> meta
  const handlers = {};

  const emit = (n, ...a) => { try { if (handlers[n]) handlers[n](...a); } catch (e) { console.error(e); } };
  const on = (map) => Object.assign(handlers, map);
  const setStatus = (s) => { if (status !== s) { status = s; emit('status', s); } };
  const peerId = (room) => 'pkdlr-' + room;

  async function loadLib() {
    if (window.Peer) return;
    setStatus('loading');
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = CDN;
      s.onload = res;
      s.onerror = () => rej(new Error('lib'));
      document.head.appendChild(s);
    });
  }

  function destroy() {
    clearTimeout(retryTimer);
    retryTimer = null;
    if (peer) { try { peer.destroy(); } catch (e) { /* ignore */ } }
    peer = null;
    hostConn = null;
    conns.clear();
    role = null;
    currentRoom = null;
    setStatus('idle');
  }

  function schedule(fn, ms) { clearTimeout(retryTimer); retryTimer = setTimeout(fn, ms); }

  /** Host a room. Resolves when registered with the signaling server. Rejects if the id is taken. */
  async function host(room) {
    await loadLib();
    destroy();
    role = 'host';
    currentRoom = room;
    setStatus('connecting');
    return new Promise((resolve, reject) => {
      let opened = false;
      peer = new Peer(peerId(room), { config: ICE });
      peer.on('open', () => { opened = true; setStatus('online'); resolve(); });
      peer.on('connection', (c) => {
        c.on('open', () => { conns.set(c, { token: null }); emit('guestOpen', c); });
        c.on('data', (d) => emit('message', c, d));
        c.on('close', () => { const m = conns.get(c); conns.delete(c); emit('close', c, m); });
        c.on('error', () => { /* close follows */ });
      });
      peer.on('error', (e) => {
        if (e.type === 'unavailable-id' && !opened) { reject(e); return; }
        if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error' || e.type === 'socket-closed') {
          setStatus('reconnecting');
          schedule(() => { try { peer && peer.reconnect(); } catch (x) { /* ignore */ } }, 2000);
          return;
        }
        emit('error', e);
      });
      peer.on('disconnected', () => {
        if (!peer || peer.destroyed) return;
        setStatus('reconnecting');
        schedule(() => { try { peer && peer.reconnect(); } catch (x) { /* ignore */ } }, 1500);
      });
    });
  }

  /** Join a room as guest; keeps retrying until the host appears. */
  async function join(room) {
    await loadLib();
    destroy();
    role = 'guest';
    currentRoom = room;
    setStatus('connecting');
    peer = new Peer({ config: ICE });
    const connect = () => {
      if (!peer || peer.destroyed || peer.disconnected) return;
      if (hostConn && hostConn.open) return;
      setStatus('connecting');
      const c = peer.connect(peerId(room), { reliable: true, serialization: 'json' });
      hostConn = c;
      let done = false;
      const fail = () => {
        if (done) return;
        done = true;
        if (hostConn === c) hostConn = null;
        setStatus('reconnecting');
        emit('hostLost');
        schedule(connect, 2500);
      };
      c.on('open', () => { setStatus('online'); emit('open', c); });
      c.on('data', (d) => emit('message', c, d));
      c.on('close', fail);
      c.on('error', fail);
      setTimeout(() => { if (!c.open) { try { c.close(); } catch (e) { /* ignore */ } fail(); } }, 10000);
    };
    peer.on('open', connect);
    peer.on('error', (e) => {
      if (e.type === 'peer-unavailable') { setStatus('waiting-host'); schedule(connect, 3000); return; }
      if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error' || e.type === 'socket-closed') {
        setStatus('reconnecting');
        schedule(() => { try { peer && peer.reconnect(); } catch (x) { /* ignore */ } }, 2000);
        return;
      }
      emit('error', e);
    });
    peer.on('disconnected', () => {
      if (!peer || peer.destroyed) return;
      setStatus('reconnecting');
      schedule(() => { try { peer && peer.reconnect(); } catch (x) { /* ignore */ } }, 1500);
    });
  }

  /** Force a reconnect attempt now (e.g. when the app comes back to the foreground). */
  function kick() {
    if (!peer) return;
    if (peer.disconnected && !peer.destroyed) { try { peer.reconnect(); } catch (e) { /* ignore */ } }
    if (role === 'guest' && (!hostConn || !hostConn.open) && currentRoom) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => join(currentRoom), 50);
    }
  }

  function send(c, msg) { try { if (c && c.open) c.send(msg); } catch (e) { /* ignore */ } }
  const sendHost = (msg) => send(hostConn, msg);
  function broadcast(fn) { for (const [c, meta] of conns) send(c, typeof fn === 'function' ? fn(meta, c) : fn); }
  const setMeta = (c, m) => conns.set(c, { ...(conns.get(c) || {}), ...m });
  const getMeta = (c) => conns.get(c);

  return {
    on, host, join, destroy, kick, send, sendHost, broadcast, setMeta, getMeta,
    get status() { return status; },
    get role() { return role; },
    get room() { return currentRoom; },
    get connected() { return role === 'host' ? status === 'online' : !!(hostConn && hostConn.open); },
    conns: () => [...conns.entries()],
  };
})();
