#!/usr/bin/env node
// Linked servers UI mock: serves public/ and speaks enough of the Joind
// WebSocket and REST protocol to exercise the linked-servers web UI without
// the real server. No dependencies beyond Node (18 or later).
//
//   node tools/link-mock/mock-server.mjs [--port N] [--step-ms N] [--manual] [--name NAME]
//
// It binds 127.0.0.1 on a random port unless --port is given, and it refuses
// port 4200 (the live Joind). See README.md beside this file.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, '..', '..', 'public');
const TOKEN = 'a0b1c2d3e4f5a0b1c2d3e4f5';

// ---------- arguments ----------
const argv = process.argv.slice(2);
function argValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
const port = Number(argValue('--port') ?? 0);
const stepMs = Number(argValue('--step-ms') ?? 3000);
const manual = argv.includes('--manual');
const LOCAL_NAME = argValue('--name') ?? 'rami9ipro';
if (port === 4200) {
  console.error('Refusing port 4200: that is the live Joind.');
  process.exit(2);
}

// ---------- state ----------
const HOME = 'ramiy530';
const now = Date.now();
let viewer = 'human';
const links = [{ name: HOME, state: 'up', since: now - 2 * 3600 * 1000 }];

const conversations = [
  { id: 'c-2026-09-25T08-10-00-ab12', name: 'general', createdAt: now - 86400000, messageCount: 0, starred: true },
  { id: 'c-2026-09-25T09-30-00-cd34', name: 'joind-dev', createdAt: now - 3600000, messageCount: 0, starred: false },
];
const remoteConversations = [
  { id: HOME + ':cpm-engine', server: HOME, name: 'cpm-engine', messageCount: 0, starred: true, state: 'up' },
  { id: HOME + ':scratch', server: HOME, name: 'scratch', messageCount: 0, starred: false, state: 'up' },
];
const allMetas = () => conversations.concat(remoteConversations);
const metaOf = (id) => allMetas().find((c) => c.id === id);
const isRemote = (id) => remoteConversations.some((c) => c.id === id);

const messages = {};
const nextId = {};
const agentsByConv = {};
const pending = {}; // conv -> [{ clientId, sender, text, queuedAt }]
for (const c of allMetas()) { messages[c.id] = []; nextId[c.id] = 1; agentsByConv[c.id] = []; }

function agent(name, role) {
  return { name, role, pid: 0, joinedAt: now - 1800000, lastSeen: now - 60000, lastPostAt: now - 120000 };
}
agentsByConv[HOME + ':cpm-engine'] = [agent('jadzia', 'lead'), agent('curzon', 'engine'), agent('codex')];
agentsByConv[conversations[0].id] = [agent('claude', 'orchestrator')];

function addMessage(conv, sender, text, extra) {
  const msg = Object.assign({ id: nextId[conv]++, sender, text, timestamp: Date.now() }, extra || {});
  messages[conv].push(msg);
  const meta = metaOf(conv);
  if (meta) meta.messageCount = messages[conv].length;
  return msg;
}

// Seed history
addMessage(conversations[0].id, 'claude', 'Local room, unchanged by the link work.');
addMessage(HOME + ':cpm-engine', 'jadzia', 'Morning. The **engine run** for window 14 is on the Y530.', { timestamp: now - 600000 });
addMessage(HOME + ':cpm-engine', 'curzon', 'Reading the mirror from rami9ipro, no listen loop.', { timestamp: now - 540000 });
addMessage(HOME + ':cpm-engine', 'system', 'curzon joined (hosted on rami9ipro)', { timestamp: now - 530000 });
addMessage(HOME + ':cpm-engine', 'curzon', 'DM: I have the W14 inputs locally.', { timestamp: now - 500000, to: ['human'] });
addMessage(HOME + ':scratch', 'codex', 'Scratch room on the home server.', { timestamp: now - 300000 });
let active = HOME + ':cpm-engine';

// ---------- WebSocket (RFC 6455, text frames only) ----------
const sockets = new Set();

function wsFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// Decode client frames (always masked). Returns [frames, rest].
function wsDecode(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length - p < 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    const masked = (b1 & 0x80) !== 0;
    const maskLen = masked ? 4 : 0;
    if (buf.length - p < maskLen + len) break;
    const mask = masked ? buf.subarray(p, p + 4) : null;
    p += maskLen;
    const data = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    frames.push({ opcode: b0 & 0x0f, data });
    off = p + len;
  }
  return [frames, buf.subarray(off)];
}

function send(sock, obj) {
  if (!sock.destroyed) sock.write(wsFrame(JSON.stringify(obj)));
}
function broadcast(obj) {
  for (const s of sockets) send(s, obj);
}

function initPayload() {
  const pendingList = [];
  for (const conv of Object.keys(pending)) {
    for (const p of pending[conv]) pendingList.push(Object.assign({ conversationId: conv }, p));
  }
  return {
    type: 'init',
    data: {
      serverNow: Date.now(),
      agents: agentsByConv[active] || [],
      messages: messages[active] || [],
      conversations,
      activeConversation: metaOf(active) || null,
      openTaskCount: 0,
      hasUrgentTask: false,
      turnGuard: { enabled: false, limit: 20 },
      roles: { preset: [], custom: [] },
      reactions: [],
      links,
      remoteConversations,
      pending: pendingList,
    },
  };
}

function onUpgrade(req, sock) {
  const key = req.headers['sec-websocket-key'];
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname !== '/ws' || !key) { sock.destroy(); return; }
  const name = u.searchParams.get('name');
  if (name) viewer = name;
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sockets.add(sock);
  let rest = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    const [frames, left] = wsDecode(Buffer.concat([rest, chunk]));
    rest = left;
    for (const f of frames) {
      if (f.opcode === 0x8) { sock.end(Buffer.from([0x88, 0])); sockets.delete(sock); return; }
      if (f.opcode === 0x9) { sock.write(Buffer.concat([Buffer.from([0x8a, f.data.length]), f.data])); continue; }
      if (f.opcode === 0x1) {
        try {
          const msg = JSON.parse(f.data.toString('utf8'));
          if (msg.type === 'web-rename' && msg.name) {
            viewer = msg.name;
            send(sock, { type: 'web-rename-ok', data: { name: viewer } });
          }
        } catch { /* ignore malformed */ }
      }
    }
  });
  sock.on('close', () => sockets.delete(sock));
  sock.on('error', () => sockets.delete(sock));
  send(sock, initPayload());
  startScript();
}

// ---------- the scripted timeline ----------
function linkEvent(state) {
  links[0] = { name: HOME, state, since: Date.now() };
  for (const c of remoteConversations) c.state = state;
  broadcast({ type: 'link', data: links[0] });
}
function mirroredMessage(conv, sender, text) {
  const msg = addMessage(conv, sender, text);
  broadcast({ type: 'message', conversationId: conv, data: msg });
  return msg;
}
// Local-only system line in the mirror (not written home)
function localSystem(conv, text) {
  const msg = addMessage(conv, 'system', text);
  broadcast({ type: 'message', conversationId: conv, data: msg });
}
function queue(conv, sender, text, to) {
  const p = { clientId: crypto.randomUUID(), sender, text, queuedAt: Date.now() };
  if (to && to.length) p.to = to; // a queued DM
  (pending[conv] ||= []).push(p);
  broadcast({ type: 'pending', conversationId: conv, data: Object.assign({ conversationId: conv }, p) });
  return p;
}
// Dispatch one queued entry. messageFirst flips the arrival order so the UI
// is exercised both ways (the contract does not fix the order).
function dispatch(conv, p, messageFirst) {
  pending[conv] = (pending[conv] || []).filter((x) => x.clientId !== p.clientId);
  const msg = addMessage(conv, p.sender, p.text, p.to ? { to: p.to } : undefined);
  const dispatched = { type: 'pending-dispatched', conversationId: conv, data: { conversationId: conv, clientId: p.clientId, id: msg.id } };
  const real = { type: 'message', conversationId: conv, data: msg };
  if (messageFirst) { broadcast(real); broadcast(dispatched); }
  else { broadcast(dispatched); setTimeout(() => broadcast(real), 300); }
}
function fmt(ts) {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

const ROOM = HOME + ':cpm-engine';
let flying = null; // the one message queued while the link is up
const steps = [
  ['mirrored message', () => mirroredMessage(ROOM, 'jadzia', '@curzon the window 14 run finished. Critical path moved to the facade package.')],
  ['pending from the viewer (link up)', () => { flying = queue(ROOM, viewer, 'On it, reading the facade fragnet now.'); }],
  ['pending-dispatched then message', () => { if (flying) dispatch(ROOM, flying, false); flying = null; }],
  ['link down', () => {
    linkEvent('down');
    localSystem(ROOM, 'link to ' + HOME + ' down since ' + fmt(links[0].since) + '; messages you send here will be queued');
  }],
  ['pending while down (viewer)', () => { queue(ROOM, viewer, 'Queued while the Y530 is away: the facade float is 12 days.'); }],
  ['pending while down (curzon, no delete for the viewer)', () => { queue(ROOM, 'curzon', 'Agree, and the MEP fragnet carries it.'); }],
  ['pending DM from the viewer to curzon while down (mailbox only)', () => { queue(ROOM, viewer, 'Private: can you rerun W14 with the revised facade durations?', ['curzon']); }],
  ['link up and drain', () => {
    const q = (pending[ROOM] || []).slice();
    linkEvent('up');
    q.forEach((p, i) => dispatch(ROOM, p, i % 2 === 1));
    localSystem(ROOM, 'link to ' + HOME + ' restored; ' + q.length + ' queued messages sent');
  }],
];
let stepIndex = 0;
let scriptStarted = false;
function runStep() {
  if (stepIndex >= steps.length) return null;
  const [label, fn] = steps[stepIndex++];
  fn();
  console.log('[mock] step ' + stepIndex + '/' + steps.length + ': ' + label);
  return label;
}
function startScript() {
  if (scriptStarted || manual) return;
  scriptStarted = true;
  const timer = setInterval(() => { if (runStep() === null) clearInterval(timer); }, stepMs);
}

// ---------- REST ----------
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.mp3': 'audio/mpeg', '.json': 'application/json', '.ico': 'image/x-icon' };

async function api(req, res, u) {
  const p = u.pathname;
  const m = req.method;
  if (m === 'POST' && p === '/api/web/register') {
    const b = await readBody(req);
    if (b.name) viewer = b.name;
    return json(res, 200, { ok: true, name: viewer });
  }
  if (p === '/api/instance') return json(res, 200, { name: LOCAL_NAME, port: server.address().port, dataDir: '(mock)' });
  if (p === '/api/notifications') {
    return json(res, 200, { generation: 'mock-1', unread: 1, notifications: [
      { id: 1, kind: 'action-required', text: 'jadzia asked curzon for a decision', conversationId: ROOM, conversationName: 'cpm-engine', timestamp: now - 400000, read: false },
    ] });
  }
  if (p === '/api/notifications/read') return json(res, 200, { ok: true, unread: 0 });
  if (p === '/api/conversations' && m === 'GET') {
    return json(res, 200, { conversations, active: metaOf(active) || null, links, remoteConversations });
  }
  if (p === '/api/conversations/select') {
    const b = await readBody(req);
    if (!metaOf(b.id)) return json(res, 404, { error: 'Conversation not found' });
    active = b.id;
    return json(res, 200, {
      conversation: metaOf(active),
      messages: messages[active],
      agents: agentsByConv[active] || [],
      pending: (pending[active] || []).map((x) => Object.assign({ conversationId: active }, x)),
    });
  }
  if (p === '/api/send') {
    const b = await readBody(req);
    if (!b.sender || !b.text) return json(res, 400, { error: 'sender and text required' });
    if (isRemote(active) && links[0].state !== 'up') {
      const q = queue(active, b.sender, b.text);
      return json(res, 200, { queued: true, clientId: q.clientId });
    }
    const msg = mirroredMessage(active, b.sender, b.text);
    return json(res, 200, { id: msg.id, sender: msg.sender, text: msg.text });
  }
  if (p === '/api/pending/delete') {
    const b = await readBody(req);
    const list = pending[b.conversation] || [];
    const hit = list.find((x) => x.clientId === b.clientId);
    if (!hit) return json(res, 404, { error: 'not queued (already dispatched?)' });
    if (hit.sender !== viewer) return json(res, 403, { error: 'only the author may delete' });
    pending[b.conversation] = list.filter((x) => x.clientId !== b.clientId);
    broadcast({ type: 'pending-deleted', conversationId: b.conversation, data: { conversationId: b.conversation, clientId: b.clientId } });
    return json(res, 200, { ok: true });
  }
  if (p === '/api/dms') {
    // DMs involving the viewer, across every room (the mailbox view)
    const dms = [];
    for (const conv of Object.keys(messages)) {
      for (const m of messages[conv]) {
        if (m.to && (m.sender === viewer || m.to.includes(viewer))) dms.push(Object.assign({ conversationId: conv }, m));
      }
    }
    const partnerOf = (m) => (m.sender === viewer ? m.to.find((t) => t !== viewer) : m.sender);
    const withName = u.searchParams.get('with');
    if (withName) return json(res, 200, { partner: withName, messages: dms.filter((m) => partnerOf(m) === withName) });
    const partners = [...new Set(dms.map(partnerOf).filter(Boolean))].map((partner) => ({ partner }));
    return json(res, 200, { partners });
  }
  if (p === '/api/decisions') return json(res, 200, { decisions: [], for: viewer, state: 'open' });
  if (p === '/api/tasks/count') return json(res, 200, { count: 0, hasUrgent: false });
  if (p === '/api/tasks') return json(res, 200, []);
  if (p === '/api/templates' || p === '/api/sessions' || p === '/api/terminals' || p === '/api/crew' ||
      p === '/api/launcher/terminals' || p === '/api/harnesses') return json(res, 200, []);
  if (p === '/api/roles') return json(res, 200, { preset: [], custom: [] });
  if (p === '/api/turn-guard') return json(res, 200, { enabled: false, limit: 20 });
  if (p === '/api/search') return json(res, 200, []);
  // Anything else the UI might touch: a harmless success.
  return json(res, 200, { ok: true });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/mock/advance') {
    const label = runStep();
    return json(res, 200, { step: stepIndex, of: steps.length, label });
  }
  if (u.pathname === '/mock/state') {
    return json(res, 200, { viewer, active, links, pending, step: stepIndex, of: steps.length });
  }
  if (u.pathname.startsWith('/api/')) return api(req, res, u);
  let rel = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname);
  const file = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  let body = fs.readFileSync(file);
  if (rel === '/index.html') {
    const html = body.toString('utf8');
    const snippet = '<script>window.__JOIND_TOKEN="' + TOKEN + '";</script>';
    const idx = html.indexOf('</head>');
    body = Buffer.from(idx < 0 ? html + snippet : html.slice(0, idx) + snippet + html.slice(idx), 'utf8');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(body);
});
server.on('upgrade', onUpgrade);
server.listen(port, '127.0.0.1', () => {
  const addr = server.address();
  console.log('[mock] Joind link mock on http://127.0.0.1:' + addr.port + '/ (' + (manual ? 'manual: GET /mock/advance' : 'step every ' + stepMs + ' ms after the first connection') + ')');
});
