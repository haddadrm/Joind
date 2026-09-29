/**
 * Joind Web UI — real-time chat via WebSocket
 * Features: markdown, code copy, @mention autocomplete, rename, roles, sound notifications
 */

var ALL_MENTION_COLOR = '#7c3aed';

var SENDER_COLORS = {
  all: ALL_MENTION_COLOR,
  system: '#555570', human: '#4ecdc4', rami: '#4ecdc4',
  claude: '#da7756', commander: '#da7756', 'commander-claude': '#da7756',
  codex: '#10a37f', gemini: '#4285f4', paris: '#4285f4',
  openclaw: '#9b59b6', jadzia: '#9b59b6',
  copilot: '#1f6feb',
};

var availableRoles = { preset: [], custom: [] };

var SOUNDS = ['soft-chime','bright-ping','gentle-pop','alert-tone','pluck','click','warm-bell','none'];
var soundCache = {};
var soundSettings = JSON.parse(localStorage.getItem('joind-sounds') || '{}');
// soundSettings: { _global: 'soft-chime', agentName: 'bright-ping', ... }
if (!soundSettings._global) soundSettings._global = 'soft-chime';

var ws = null;
var agents = [];
// The room `agents` (and the loaded messages) belong to. During a room
// switch the new room is active before its members arrive; until then the
// members button and panel show nothing rather than the old room.
var agentsConv = null;
var clockOffset = 0; // server clock minus browser clock; ages are computed against server time
function serverNow() { return Date.now() + clockOffset; }
function touchAgent(name, fields) {
  // Merge fresh timestamps into the cached agent list so pill ages stay live
  // between join events (messages, typing and heartbeats all count).
  var hit = false;
  agents = agents.map(function(a) {
    if (a.name !== name) return a;
    hit = true;
    var next = Object.assign({}, a);
    if (fields.lastSeen != null) next.lastSeen = Math.max(a.lastSeen || 0, fields.lastSeen);
    if (fields.lastPostAt != null) next.lastPostAt = Math.max(a.lastPostAt || 0, fields.lastPostAt);
    return next;
  });
  return hit;
}
var onlineNames = new Set();
var mentionMenuIndex = -1;
var openPopover = null;
var popoverAnchor = null; // what opened the popover, for focus on Escape
var lastSender = null; // for message grouping
var lastScanResults = []; // cached scan results for auto-refresh
var isMuted = JSON.parse(localStorage.getItem('joind-muted') || 'false');
var allMessages = []; // all messages for reply lookup
var replyingTo = null; // current reply target (message object or null)
var typingNames = new Set(); // agents currently typing
var staleNames = new Set(); // agents marked as stale
var autoScroll = true; // tracks if user is near bottom
var unreadCount = 0; // messages received while scrolled up

if (typeof marked !== 'undefined') { marked.setOptions({ breaks: true, gfm: true }); }

// Load saved color overrides
try {
  var savedColors = JSON.parse(localStorage.getItem('joind-colors') || '{}');
  Object.keys(savedColors).forEach(function(k) { SENDER_COLORS[k] = savedColors[k]; });
} catch(e) {}

// --- Sound ---
var audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  // Create and play a silent buffer to unlock audio context
  var ctx = new (window.AudioContext || window.webkitAudioContext)();
  var buf = ctx.createBuffer(1, 1, 22050);
  var src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0);
  audioUnlocked = true;
  document.removeEventListener('click', unlockAudio);
  document.removeEventListener('keydown', unlockAudio);
}
document.addEventListener('click', unlockAudio);
document.addEventListener('keydown', unlockAudio);

function playSound(sender) {
  if (isMuted) return;
  var soundName = soundSettings[sender] || soundSettings._global || 'soft-chime';
  if (soundName === 'none') return;
  try {
    if (!soundCache[soundName]) {
      soundCache[soundName] = new Audio('/sounds/' + soundName + '.mp3');
      soundCache[soundName].volume = 0.6;
    }
    var audio = soundCache[soundName];
    audio.currentTime = 0;
    var p = audio.play();
    if (p && p.catch) p.catch(function() {
      // Retry after user gesture unlock
      unlockAudio();
    });
  } catch(e) {}
}

function toggleMute() {
  isMuted = !isMuted;
  localStorage.setItem('joind-muted', JSON.stringify(isMuted));
  updateMuteBtn();
}

function updateMuteBtn() {
  var btn = document.getElementById('mute-btn');
  if (btn) {
    btn.innerHTML = isMuted ? '<i data-lucide="volume-x" width="18" height="18" aria-hidden="true"></i>' : '<i data-lucide="volume-2" width="18" height="18" aria-hidden="true"></i>';
    btn.style.opacity = isMuted ? '0.5' : '1';
    btn.title = isMuted ? 'Unmute' : 'Mute';
    btn.setAttribute('aria-label', isMuted ? 'Unmute' : 'Mute');
    btn.setAttribute('aria-pressed', isMuted ? 'true' : 'false');
    if (window.lucide) lucide.createIcons({ root: btn });
  }
}

function saveSoundSettings() {
  localStorage.setItem('joind-sounds', JSON.stringify(soundSettings));
}

// --- WebSocket ---
// Name the socket opened with; tracked as the last server-accepted name.
// connect() reuses it so a reconnect never claims an unregistered name.
var wsName = null;
// Set when a rename lands while no OPEN socket can carry it; onopen re-checks.
var pendingRename = false;
// Previous registered name, remembered while a web-rename request is in flight.
var renameAttempt = null;
// Consecutive 4401/4403 closes; after a few, a user-supplied token is re-asked.
var wsAuthFailures = 0;

// Server-issued token: injected into index.html when generated, otherwise the
// browser supplies it once per tab session (sessionStorage) via a prompt.
function webToken() {
  var stored = '';
  try { stored = sessionStorage.getItem('joind-web-token') || ''; } catch (e) { /* storage unavailable */ }
  return window.__JOIND_TOKEN || stored;
}

// Every request this page makes to its own /api/ carries the web token in
// the X-Joind-Token header: the server refuses web writes without it. Only
// same-origin relative URLs get it, never another host.
(function() {
  var nativeFetch = window.fetch;
  if (typeof nativeFetch !== 'function') return;
  window.fetch = function(input, init) {
    if (typeof input === 'string' && input.indexOf('/api/') === 0) {
      var token = webToken();
      if (token) {
        init = init || {};
        var headers = new Headers(init.headers || {});
        if (!headers.has('X-Joind-Token')) headers.set('X-Joind-Token', token);
        init = Object.assign({}, init, { headers: headers });
      }
    }
    return nativeFetch.call(window, input, init);
  };
})();

// Ask for the web token (user-set mode). Reuses the existing modal classes.
// `after` runs once a token is stored.
function promptWebToken(after) {
  var overlay = document.createElement('div');
  overlay.className = 'session-modal-overlay';
  var modal = document.createElement('div');
  modal.className = 'session-modal';
  var title = document.createElement('h3');
  title.textContent = 'Web token required';
  var hint = document.createElement('p');
  hint.textContent = 'This Joind uses a user-set web token. Enter it to view DMs (kept for this tab session only).';
  hint.style.fontSize = 'var(--fs-ui)';
  hint.style.opacity = '0.8';
  var input = document.createElement('input');
  input.type = 'password';
  input.className = 'launch-input';
  input.placeholder = 'web token';
  var btnRow = document.createElement('div');
  btnRow.style.marginTop = '10px';
  btnRow.style.textAlign = 'right';
  var okBtn = document.createElement('button');
  okBtn.className = 'btn btn-primary';
  okBtn.textContent = 'Connect';
  function submit() {
    var value = input.value.trim();
    if (!value) return;
    sessionStorage.setItem('joind-web-token', value);
    overlay.remove();
    if (after) after();
  }
  okBtn.addEventListener('click', submit);
  input.addEventListener('keydown', function(e) { if (e.key === 'Enter') submit(); });
  btnRow.appendChild(okBtn);
  modal.appendChild(title); modal.appendChild(hint); modal.appendChild(input); modal.appendChild(btnRow);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  input.focus();
}

// Ensure a token exists before connecting; prompt only when neither the
// injected value nor sessionStorage has one.
function ensureWebToken(after) {
  if (webToken()) { if (after) after(); return; }
  promptWebToken(after);
}

// Register the current human name against the token. The server only accepts
// a WS ?name= equal to this registration. `after` runs either way: on failure
// we still connect and let the server fail closed (4403/reconnect).
function registerWebName(after) {
  fetch('/api/web/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: webToken(), name: myName() }) })
    .then(function(r) { if (after) after(r.ok); })
    .catch(function() { if (after) after(false); });
}

// A rejected rename: go back to the last registered name everywhere, without
// firing input events (no loops). Server-side registration is untouched.
function revertRename() {
  if (!renameAttempt) return;
  var prev = renameAttempt;
  renameAttempt = null;
  wsName = prev;
  localStorage.setItem('joind-sender-name', prev);
  var senderInput = document.getElementById('sender-name');
  if (senderInput) senderInput.value = prev;
  var display = document.getElementById('you-name-display');
  if (display) display.textContent = prev;
  var avatar = document.getElementById('you-avatar');
  if (avatar) {
    avatar.textContent = prev.charAt(0).toUpperCase();
    avatar.style.background = getSenderColor(prev);
  }
  var pill = document.getElementById('you-pill');
  if (pill) {
    pill.title = 'You: ' + prev;
    pill.setAttribute('aria-label', 'Your menu, ' + prev);
  }
  syncUserMenuName(prev);
}

function connect() {
  if (signedOut) return; // a reconnect timer that fires after sign out
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Always claim the last server-accepted name; renames flow through
  // web-rename on the open socket, never through a fresh ?name=.
  wsName = wsName || myName();
  ws = new WebSocket(proto + '//' + location.host + '/ws?token=' + encodeURIComponent(webToken()) + '&name=' + encodeURIComponent(wsName));
  var dot = document.getElementById('connection-dot');

  ws.onopen = function() {
    dot.classList.remove('disconnected');
    dot.title = 'Connected';
    dot.setAttribute('aria-label', 'Connected');
    wsAuthFailures = 0;
    // Reconcile the decisions badge and mailbox partners after every (re)connection.
    if (typeof refreshDecisionsBadge === 'function') refreshDecisionsBadge();
    if (typeof fetchDmPartners === 'function') fetchDmPartners();
    // A rename that landed while the socket was down is applied in place:
    // this socket is bound to the previously accepted name, which is allowed
    // to rename. Exactly one web-rename goes out; wsName updates on -ok.
    if (pendingRename || myName() !== wsName) {
      pendingRename = false;
      renameAttempt = wsName;
      ws.send(JSON.stringify({ type: 'web-rename', name: myName() }));
    }
    // Reconcile the bell after every (re)connection: alerts that arrived
    // while the socket was down exist only server-side until this fetch.
    if (typeof loadNotifications === 'function') loadNotifications();
  };
  ws.onmessage = function(e) {
    var event = JSON.parse(e.data);
    switch (event.type) {
      case 'init':
        if (typeof event.data.serverNow === 'number') clockOffset = event.data.serverNow - Date.now();
        agents = event.data.agents;
        agentsConv = event.data.activeConversation ? event.data.activeConversation.id : null;
        onlineNames = new Set(agents.map(function(a) { return a.name; }));
        allMessages = (event.data.messages || []).slice();
        historyView = null;
        jumpSeq++;
        historyExitSeq++;
        activeConversation = event.data.activeConversation || null;
        conversationList = event.data.conversations || [];
        // A (re)connect is a new generation: HTTP responses to requests made
        // before it are ignored for pending state.
        bumpPendingGeneration();
        socketInitCount += 1;
        applyLinkPayload(event.data, true);
        initTaskCount = event.data.openTaskCount || 0;
        initHasUrgent = event.data.hasUrgentTask || false;
        if (event.data.turnGuard) initTurnGuard(event.data.turnGuard);
        if (event.data.roles) {
          availableRoles = event.data.roles;
          // Roles may have changed while this socket was down: an open
          // Settings modal catches up (at once, or after focus leaves it).
          if (settingsOverlay) refreshSettingsPart(document.getElementById('settings-roles'), renderRolesInto);
        }
        if (event.data.reactions) allReactions = event.data.reactions;
        if (activeConversation) {
          renderPills();
          if (activeDm) {
            // A mailbox was open across the (re)connect: refetch its
            // cross-conversation thread instead of painting the active
            // room's messages into the pane. refreshDmThread leaves the
            // composer (draft image, reply target) untouched.
            refreshDmThread(activeDm);
          } else {
            renderMessages(event.data.messages || []);
            renderPendingForActive();
          }
          renderTaskBadgeFromCount(initTaskCount, initHasUrgent);
          // Task ids are per room: a reconnect that lands in a room other
          // than the one the task list belongs to must not keep its cards.
          if (tasksConvId === null) tasksConvId = activeConversation.id;
          else if (tasksConvId !== activeConversation.id) resetRoomTasks(activeConversation.id);
        } else {
          showNoConversation();
          renderTaskBadgeFromCount(0, false);
        }
        renderConversationList();
        renderDmList();
        break;
      case 'conversation-created':
      case 'conversation-renamed':
      case 'conversation-deleted':
        loadConversations();
        break;
      case 'message':
        // Proof of life first, before any view-specific early return: a post
        // in the active room refreshes the sender's pill ages (server time).
        if (activeConversation && (!event.conversationId || event.conversationId === activeConversation.id) &&
            event.data && event.data.sender && event.data.sender !== 'system' && typeof event.data.timestamp === 'number') {
          if (touchAgent(event.data.sender, { lastSeen: event.data.timestamp, lastPostAt: event.data.timestamp })) renderPills();
        }
        // A fresh ask anywhere refreshes the decisions badge, even for
        // conversations that are not on screen.
        if (event.data && event.data.ask && event.data.ask.state === 'open') {
          refreshDecisionsBadge();
        }
        // DMs involving the viewer are mailbox traffic and conversation-
        // independent: handle them BEFORE the active-conversation filter so
        // a DM arriving from a background room still lands in its thread
        // and bumps its unread badge. (The server only fans out targeted
        // messages the viewer may see, so any DM event here involves us.)
        if (event.data && event.data.to && event.data.sender !== 'system') {
          var meNow = myName();
          // Every mailbox this message belongs to: all non-viewer recipients
          // of an outgoing group DM, or the sender of an incoming one.
          var dmPartners = [];
          if (event.data.sender === meNow) {
            for (var di = 0; di < event.data.to.length; di++) {
              if (event.data.to[di] !== meNow && dmPartners.indexOf(event.data.to[di]) < 0) dmPartners.push(event.data.to[di]);
            }
          } else if (event.data.to.indexOf(meNow) >= 0) {
            dmPartners.push(event.data.sender);
          }
          if (dmPartners.length > 0) {
            var dmMsg = event.data;
            if (!dmMsg.conversationId && event.conversationId) dmMsg.conversationId = event.conversationId;
            settlePendingFor(dmMsg.conversationId, dmMsg);
            if (activeConversation && event.conversationId === activeConversation.id) {
              allMessages.push(dmMsg);
            }
            if (activeDm && dmPartners.indexOf(activeDm) >= 0) {
              // Dedupe against a snapshot that may already carry this message
              var already = dmThread.some(function(m) { return dmKey(m) === dmKey(dmMsg); });
              if (!already) {
                dmThread.push(dmMsg);
                hideWelcome();
                appendMessage(dmMsg);
              }
              if (dmMsg.sender !== meNow) playSound(dmMsg.sender);
            } else if (dmMsg.sender !== meNow) {
              playSound(dmMsg.sender);
              dmPartners.forEach(function(p) { dmUnread[p] = (dmUnread[p] || 0) + 1; });
            }
            dmPartners.forEach(function(p) {
              if (dmPartnersCache.indexOf(p) < 0) dmPartnersCache.push(p);
            });
            renderDmList();
            break;
          }
        }
        // Filter: only render messages for the active conversation; a
        // message in another room counts toward its unread badge.
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) {
          if (event.conversationId) noteRoomMessage(event.conversationId, event.data);
          break;
        }
        // A dispatched undelivered message is replaced by its real copy here
        settlePendingFor(event.conversationId || activeConversation.id, event.data);
        if (historyView && historyView.conv === activeConversation.id) {
          // The pane shows older messages: count the new one; "Jump to
          // latest" reloads the latest page, this message included.
          if (messageInCurrentView(event.data)) {
            historyView.newCount += 1;
            renderHistoryChrome();
            if (event.data.sender !== 'system') playSound(event.data.sender);
          }
          if (activeConversation) activeConversation.messageCount = (activeConversation.messageCount || 0) + 1;
          break;
        }
        allMessages.push(event.data);
        // Filter: only render messages that belong to the current view
        // (channel view skips DMs; DM view skips channel traffic)
        if (!messageInCurrentView(event.data)) {
          // A DM is open: a public message in the selected room is unread
          // there until the room is back on screen.
          if (activeDm) noteRoomMessage(activeConversation.id, event.data);
          break;
        }
        hideWelcome();
        appendMessage(event.data);
        if (event.data.sender !== 'system') playSound(event.data.sender);
        if (activeConversation) {
          activeConversation.messageCount = (activeConversation.messageCount || 0) + 1;
        }
        break;
      case 'join':
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) break;
        onlineNames.add(event.data.name);
        staleNames.delete(event.data.name);
        agents = agents.filter(function(a) { return a.name !== event.data.name; });
        agents.push(event.data); renderPills();
        renderDmList();
        if (lastScanResults.length > 0) renderTerminals(lastScanResults);
        break;
      case 'leave':
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) break;
        onlineNames.delete(event.data.name);
        staleNames.delete(event.data.name);
        typingNames.delete(event.data.name);
        agents = agents.filter(function(a) { return a.name !== event.data.name; });
        renderPills();
        renderDmList();
        renderTypingBar();
        if (lastScanResults.length > 0) renderTerminals(lastScanResults);
        break;
      case 'rename':
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) break;
        var d = event.data;
        onlineNames.delete(d.oldName); onlineNames.add(d.newName);
        agents = agents.filter(function(a) { return a.name !== d.oldName; });
        agents.push(d.agent); renderPills();
        renderDmList();
        // Update cached terminal data with new name
        lastScanResults.forEach(function(t) {
          if (t.tabTitle === d.oldName) t.tabTitle = d.newName;
          if (t.pid === d.agent.pid) t.tabTitle = d.newName;
          // A pane is the pair (GUI instance, pane number): a bare number matches nothing.
          if (t.weztermPaneId != null && t.weztermGui != null &&
              t.weztermPaneId === d.agent.weztermPaneId && t.weztermGui === d.agent.weztermGui) t.tabTitle = d.newName;
        });
        if (lastScanResults.length > 0) renderTerminals(lastScanResults);
        break;
      case 'role':
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) break;
        agents = agents.map(function(a) { return a.name === event.data.name ? event.data : a; });
        renderPills();
        break;
      case 'presence':
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) break;
        if (touchAgent(event.data.name, { lastSeen: event.data.lastSeen, lastPostAt: event.data.lastPostAt })) renderPills();
        break;
      case 'typing':
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) break;
        touchAgent(event.data.name, { lastSeen: serverNow() });
        if (event.data.typing) {
          typingNames.add(event.data.name);
        } else {
          typingNames.delete(event.data.name);
        }
        renderPills();
        break;
      case 'stale':
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) break;
        staleNames.add(event.data.name);
        renderPills();
        break;
      case 'message-choice':
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) break;
        var chId = event.data.id;
        var chMsg = allMessages.find(function(m) { return m.id === chId; });
        if (chMsg) chMsg.choiceResponse = event.data.response;
        var chEl = document.querySelector('.message[data-id="' + chId + '"][data-conv="' + event.conversationId + '"] .msg-choices');
        if (chEl && chMsg) renderChoices(chEl, chMsg);
        break;
      case 'message-deleted':
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) break;
        var delId = event.data.id;
        allMessages = allMessages.filter(function(m) { return m.id !== delId; });
        var delEl = document.querySelector('.message[data-id="' + delId + '"][data-conv="' + event.conversationId + '"]');
        if (delEl) {
          delEl.style.transition = 'opacity 0.2s, max-height 0.3s';
          delEl.style.opacity = '0';
          delEl.style.maxHeight = delEl.offsetHeight + 'px';
          setTimeout(function() { delEl.style.maxHeight = '0'; delEl.style.padding = '0'; delEl.style.margin = '0'; }, 200);
          setTimeout(function() { delEl.remove(); }, 500);
        }
        break;
      case 'task-created':
        scheduleBoardReload(); // the board spans every room
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) break;
        tasks.push(event.data);
        renderTaskBadge();
        if (taskPanelOpen) renderTaskPanel();
        if (event.data.priority === 'urgent') playSound('alert-tone');
        break;
      case 'task-updated':
        scheduleBoardReload();
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) break;
        tasks = tasks.map(function(t) { return t.id === event.data.id ? event.data : t; });
        renderTaskBadge();
        if (taskPanelOpen) renderTaskPanel();
        break;
      case 'turn-guard':
        initTurnGuard(event.data);
        break;
      case 'notification':
        onNotification(event.data, event.generation);
        break;
      case 'ask-resolved':
        if (event.data && event.data.id != null) {
          decisionsSeq++;
          applyAskResolution(event.data.id, { state: 'resolved', resolvedBy: event.data.by }, event.conversationId);
          decisionsCache = decisionsCache.filter(function(x) {
            return !(x.messageId === event.data.id && x.conversationId === event.conversationId);
          });
          refreshDecisionsBadge();
          if (decisionsPanelOpen) renderDecisionsPanel();
        }
        break;
      case 'roles-updated':
        availableRoles = event.data;
        // An open Settings modal shows the new roles, at once or when focus leaves the section.
        refreshSettingsPart(document.getElementById('settings-roles'), renderRolesInto);
        break;
      case 'web-rename-ok':
        // Server re-registered the name and rebound this socket; nothing else needed.
        renameAttempt = null;
        // The server replies { type, name } (top level); older code read
        // event.data.name, never found it, and kept the old name, so a later
        // rename back to it was skipped and the server kept the other name.
        if (typeof event.name === 'string' && event.name) wsName = event.name;
        else if (event.data && event.data.name) wsName = event.data.name;
        break;
      case 'web-rename-error':
        revertRename();
        break;
      case 'agent-status':
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) break;
        agents = agents.map(function(a) { return a.name === event.data.name ? event.data : a; });
        renderPills();
        break;
      case 'reaction':
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) break;
        // Update local reaction cache
        if (event.data.action === 'added') {
          allReactions.push({ messageId: event.data.messageId, emoji: event.data.emoji, sender: event.data.sender, timestamp: Date.now() });
        } else {
          allReactions = allReactions.filter(function(r) {
            return !(r.messageId === event.data.messageId && r.emoji === event.data.emoji && r.sender === event.data.sender);
          });
        }
        var rRow = document.querySelector('.message[data-id="' + event.data.messageId + '"][data-conv="' + event.conversationId + '"] .msg-reactions');
        if (rRow) {
          var msgR = allReactions.filter(function(r) { return r.messageId === event.data.messageId; });
          renderReactionRow(rRow, event.data.messageId, msgR);
        }
        break;
      case 'message-edited':
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) break;
        handleMessageEdited(event.data);
        break;
      // Linked servers: link state and the undelivered queue of remote rooms
      case 'link':
        onLinkEvent(event.data);
        break;
      case 'pending':
        onPendingEvent(event);
        break;
      case 'pending-dispatched':
        onPendingDispatched(event);
        break;
      case 'pending-deleted':
        onPendingDeleted(event);
        break;
    }
  };
  ws.onclose = function(e) {
    dot.classList.add('disconnected');
    dot.title = signedOut ? 'Signed out' : 'Disconnected, reconnecting';
    dot.setAttribute('aria-label', dot.title);
    if (signedOut) return; // signed out: no reconnect
    // Repeated auth rejections with a user-supplied token: drop it and ask
    // again (covers typos and stale sessionStorage tokens). Injected-token
    // mode keeps the plain reconnect loop.
    if (e && (e.code === 4401 || e.code === 4403)) {
      wsAuthFailures++;
      if (wsAuthFailures >= 3 && !window.__JOIND_TOKEN) {
        wsAuthFailures = 0;
        sessionStorage.removeItem('joind-web-token');
        promptWebToken(function() { connect(); });
        return;
      }
    }
    setTimeout(connect, 2000);
  };
}

// --- Agent pills with popover ---
function formatAge(ms) {
  var m = Math.round(ms / 60000);
  if (m < 60) return m + 'm';
  var h = Math.floor(m / 60);
  if (h < 48) return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
  return Math.floor(h / 24) + 'd';
}

// Ages drift while nothing else re-renders; keep them honest once a minute.
var membersTick = setInterval(function() { if (activeConversation && !signedOut) renderPills(); }, 60000);

// --- Members: the toolbar button and the right side panel (redesign lane 2) ---
// The header no longer carries a pill per agent. The members button shows
// up to four stacked avatars (presence order, then offline) and a count of
// everyone the panel lists; it never clips, because overflow is the count.
// The panel groups members as Active now (online), Idle (stale: presence
// lost), Silent (quiet for 30 minutes) and Offline (authors of the loaded
// messages who are not connected), each row with role, wake route, age and
// a remote tag. A row opens the member's usual popover.
var popoverOnClose = null;
var sidePanelTab = null;      // 'members' | 'pins' | null (closed)
var sidePanelOpener = null;   // the control that opened the panel, for Escape
var pinsState = { conv: null, list: null, seq: 0 };
var STACK_MAX = 4;

function pillInfo(a, nowMs) {
  var postAge = a.lastPostAt ? Math.max(0, nowMs - a.lastPostAt) : null;
  var seenAge = a.lastSeen ? Math.max(0, nowMs - a.lastSeen) : null;
  var quietAge = postAge != null ? postAge : (a.joinedAt ? Math.max(0, nowMs - a.joinedAt) : null);
  var stale = staleNames.has(a.name);
  var presence = window.joindUi ? window.joindUi.pillPresence(stale, quietAge) : (stale ? 'stale' : 'online');
  var quietText = quietAge != null && quietAge > 30 * 60000
    ? (postAge != null ? 'silent ' : 'no posts ') + formatAge(quietAge)
    : '';
  var title = (a.name || '') +
    (a.role ? ' · ' + a.role : '') +
    (a.host ? ' · hosted on ' + a.host : '') +
    (stale ? ' · stale' : '') +
    (quietText ? ' · ' + quietText : '') +
    (seenAge != null ? ' · seen ' + formatAge(seenAge) + ' ago' : '') +
    (postAge != null ? ' · last posted ' + formatAge(postAge) + ' ago' : ' · no posts this session');
  return { a: a, presence: presence, quietAge: quietAge, seenAge: seenAge, quietText: quietText, title: title };
}

function shortPillAge(ms) {
  return window.joindUi ? window.joindUi.shortAge(ms) : formatAge(ms);
}

// How a member is woken: the route the server uses, which is what a
// "harness" means to the room. Hosted members live on a linked server.
function memberRoute(a) {
  if (a.host) return 'hosted on ' + a.host;
  if (a.codexThread) return 'Codex queue';
  if (a.orcaTerminal) return 'Orca';
  if (a.weztermPaneId != null) return 'WezTerm';
  if (a.pid) return 'terminal';
  return '';
}

// The room's members as the panel lists them: connected (presence order)
// and offline (recent authors not connected).
function roomMembers() {
  var nowMs = serverNow();
  if (!activeConversation || agentsConv !== activeConversation.id) return { infos: [], offline: [], now: nowMs };
  var infos = agents.map(function(a) { return pillInfo(a, nowMs); });
  if (window.joindUi) infos = window.joindUi.orderByPresence(infos, function(x) { return x.presence; });
  var present = agents.map(function(a) { return a.name; });
  var offline = window.joindUi && !activeDm ? window.joindUi.offlineAuthors(allMessages, present, myName(), 20) : [];
  return { infos: infos, offline: offline, now: nowMs };
}

function memberAvatar(name, cls) {
  var av = document.createElement('span');
  av.className = 'mav' + (cls ? ' ' + cls : '');
  av.style.background = getSenderColor(name);
  av.textContent = (name || '?').charAt(0).toUpperCase();
  return av;
}

// Kept under its old name: every presence event, join, leave, rename, role
// and typing change already calls renderPills.
function renderPills() {
  // An open DM shows its partner's presence and harness in the header.
  if (activeDm && typeof syncChannelHeader === 'function') syncChannelHeader();
  // Presence shows in the DM rows and on the Crew list and page too.
  if (typeof renderDmList === 'function') renderDmList();
  if (typeof renderCrewPage === 'function') renderCrewPage();
  // An open Settings modal lists the room's agents for per-agent sounds.
  if (settingsOverlay) refreshSettingsPart(document.getElementById('settings-agent-sounds'), renderAgentSoundsInto);
  var m = roomMembers();
  renderMembersButton(m);
  if (sidePanelTab === 'members') renderSidePanel(m);
  if (sidePanelTab) syncSidePanelTabs(m);
}

function renderMembersButton(m) {
  var btn = document.getElementById('members-btn');
  var stack = document.getElementById('members-stack');
  var countEl = document.getElementById('members-count');
  var ico = document.getElementById('members-ico');
  if (!btn || !stack || !countEl) return;
  var summary = window.joindUi
    ? window.joindUi.membersSummary(m.infos.length, m.offline.length)
    : { count: m.infos.length, label: 'Members: ' + m.infos.length + ' connected' };
  stack.textContent = '';
  var faces = m.infos.map(function(x) { return { name: x.a.name, dim: x.presence !== 'online', working: typingNames.has(x.a.name) }; })
    .concat(m.offline.map(function(o) { return { name: o.name, dim: true, working: false }; }))
    .slice(0, STACK_MAX);
  faces.forEach(function(f) {
    stack.appendChild(memberAvatar(f.name, 'sm' + (f.dim ? ' dim' : '') + (f.working ? ' working' : '')));
  });
  stack.hidden = faces.length === 0;
  if (ico) ico.hidden = faces.length > 0;
  countEl.textContent = summary.count > 0 ? String(summary.count) : '';
  btn.title = summary.label;
  btn.setAttribute('aria-label', summary.label + '. Open the members panel');
}

// --- The right side panel ---
function toggleSidePanel(tab) {
  if (sidePanelTab === tab) { closeSidePanel(true); return; }
  openSidePanel(tab, document.activeElement);
}

function openSidePanel(tab, opener) {
  var panel = document.getElementById('side-panel');
  if (!panel || activeDm || !activeConversation) return;
  closePopover();
  sidePanelTab = tab === 'pins' ? 'pins' : 'members';
  // The control that opened it gets focus back on Escape or close; a
  // stale opener (removed, or inside the panel) falls back to the button.
  if (opener && opener !== document.body && opener.isConnected && !panel.contains(opener)) sidePanelOpener = opener;
  panel.hidden = false;
  document.body.classList.add('side-panel-open');
  if (sidePanelTab === 'pins') loadPins(true);
  renderSidePanel();
  syncSidePanelTabs();
  var tabBtn = document.getElementById(sidePanelTab === 'pins' ? 'side-tab-pins' : 'side-tab-members');
  if (tabBtn) tabBtn.focus();
}

function closeSidePanel(returnFocus) {
  var panel = document.getElementById('side-panel');
  if (!panel || !sidePanelTab) return;
  var hadFocus = panel.contains(document.activeElement);
  sidePanelTab = null;
  panel.hidden = true;
  document.body.classList.remove('side-panel-open');
  closePopover();
  syncSidePanelTabs();
  if (returnFocus || hadFocus) {
    var back = sidePanelOpener && sidePanelOpener.isConnected && sidePanelOpener.offsetParent !== null
      ? sidePanelOpener : document.getElementById('members-btn');
    if (back && back.offsetParent !== null) back.focus();
  }
  sidePanelOpener = null;
}

// Tabs and toolbar buttons tell the truth about what is open.
function syncSidePanelTabs(m) {
  var tabs = [['members', 'side-tab-members', 'members-btn'], ['pins', 'side-tab-pins', 'pins-btn']];
  tabs.forEach(function(t) {
    var on = sidePanelTab === t[0];
    var tab = document.getElementById(t[1]);
    if (tab) { tab.setAttribute('aria-selected', on ? 'true' : 'false'); tab.tabIndex = on || !sidePanelTab && t[0] === 'members' ? 0 : -1; tab.classList.toggle('on', on); }
    var btn = document.getElementById(t[2]);
    if (btn) { btn.setAttribute('aria-expanded', on ? 'true' : 'false'); btn.classList.toggle('on', on); }
  });
  var mc = document.getElementById('side-tab-members-count');
  if (mc) {
    var mm = m || roomMembers();
    var n = mm.infos.length + mm.offline.length;
    mc.textContent = n > 0 ? String(n) : '';
  }
  var pc = document.getElementById('side-tab-pins-count');
  if (pc) pc.textContent = pinsState.list && pinsState.list.length > 0 ? String(pinsState.list.length) : '';
}

function renderSidePanel(m) {
  var body = document.getElementById('side-panel-body');
  if (!body || !sidePanelTab) return;
  var tabId = sidePanelTab === 'pins' ? 'side-tab-pins' : 'side-tab-members';
  body.setAttribute('aria-labelledby', tabId);
  // A rebuild must not drop keyboard focus from a row: remember it by key.
  var focusKey = body.contains(document.activeElement) && document.activeElement !== body
    ? document.activeElement.getAttribute('data-key') : null;
  body.textContent = '';
  if (sidePanelTab === 'pins') renderPinsList(body);
  else renderMembersList(body, m || roomMembers());
  if (focusKey) {
    var rows = body.querySelectorAll('[data-key]');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-key') === focusKey) { rows[i].focus(); return; }
    }
    if (rows[0]) rows[0].focus(); else body.focus();
  }
}

function renderMembersList(body, m) {
  var groups = window.joindUi
    ? window.joindUi.memberGroups(m.infos, function(x) { return x.presence; }, m.offline)
    : [['active', 'Active now', m.infos]];
  if (groups.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'side-empty';
    empty.textContent = 'No members yet. Agents appear here when they join this room or post in it.';
    body.appendChild(empty);
    return;
  }
  // You first under Active now, as in A (not counted on the button).
  if (!groups.length || groups[0][0] !== 'active') groups.unshift(['active', 'Active now', []]);
  groups.forEach(function(g, gi) {
    var head = document.createElement('div');
    head.className = 'mgroup';
    head.textContent = g[1] + ' · ' + (g[2].length + (gi === 0 ? 1 : 0));
    body.appendChild(head);
    if (gi === 0) body.appendChild(buildYouRow());
    g[2].forEach(function(item) {
      body.appendChild(g[0] === 'offline' ? buildOfflineRow(item, m.now) : buildMemberRow(item));
    });
  });
}

function buildMemberRow(x) {
  var a = x.a;
  var row = document.createElement('button');
  row.type = 'button';
  row.className = 'member-row ' + x.presence + (typingNames.has(a.name) ? ' working' : '');
  row.setAttribute('data-key', 'm:' + (a.name || ''));
  row.setAttribute('data-agent', a.name || '');
  row.title = x.title;
  var st = presenceOf(a.name);
  row.appendChild(presenceAvatar(a.name, '', st.cls));

  var text = document.createElement('span');
  text.className = 'mtext';
  var nameLine = document.createElement('span');
  nameLine.className = 'mname';
  var nm = document.createElement('span');
  nm.textContent = a.name;
  nameLine.appendChild(nm);
  text.appendChild(nameLine);

  // As in A: the harness (or hosted, remote: <server>) first, then the
  // role, then the state.
  var sub = [];
  var harness = harnessOf(a.name);
  if (a.host) sub.push('hosted', 'remote: ' + a.host);
  else if (harness) sub.push(harness);
  else if (memberRoute(a)) sub.push(memberRoute(a));
  if (a.role) sub.push(a.role);
  sub.push(st.cls === 'working' ? 'working' : st.cls === 'idle' ? 'idle' + (x.seenAge != null ? ' ' + formatAge(x.seenAge) : '') : st.cls === 'silent' ? x.quietText : (x.seenAge != null && x.seenAge >= 60000 ? 'seen ' + formatAge(x.seenAge) + ' ago' : 'active'));
  var subEl = document.createElement('span');
  subEl.className = 'msub';
  subEl.textContent = sub.join(' · ');
  text.appendChild(subEl);
  if (a.status) {
    var st = document.createElement('span');
    st.className = 'mstatus';
    st.textContent = a.status;
    text.appendChild(st);
  }
  row.appendChild(text);
  row.addEventListener('click', function(e) {
    e.stopPropagation();
    showPopover(row, a);
  });
  return row;
}

function buildYouRow() {
  var row = document.createElement('div');
  row.className = 'member-row you static';
  row.setAttribute('data-key', 'you');
  row.appendChild(presenceAvatar(myName(), '', 'online'));
  var text = document.createElement('span');
  text.className = 'mtext';
  var nameLine = document.createElement('span');
  nameLine.className = 'mname';
  var nm = document.createElement('span');
  nm.textContent = myName();
  var you = document.createElement('span');
  you.className = 'mname-extra';
  you.textContent = '(you)';
  nameLine.appendChild(nm);
  nameLine.appendChild(you);
  var sub = document.createElement('span');
  sub.className = 'msub';
  sub.textContent = 'human · here';
  text.appendChild(nameLine);
  text.appendChild(sub);
  row.appendChild(text);
  return row;
}

function buildOfflineRow(o, nowMs) {
  var row = document.createElement('div');
  row.className = 'member-row offline';
  row.setAttribute('data-key', 'o:' + o.name);
  row.tabIndex = -1;
  row.appendChild(presenceAvatar(o.name, '', 'offline'));
  var text = document.createElement('span');
  text.className = 'mtext';
  var nameLine = document.createElement('span');
  nameLine.className = 'mname';
  nameLine.textContent = o.name;
  text.appendChild(nameLine);
  var subEl = document.createElement('span');
  subEl.className = 'msub';
  var oh = harnessOf(o.name);
  subEl.textContent = (oh ? oh + ' · ' : '') + (o.lastAt ? 'offline ' + formatAge(Math.max(0, nowMs - o.lastAt)) + ', last post' : 'not connected');
  text.appendChild(subEl);
  row.appendChild(text);
  return row;
}

// --- Pins: the room's pinned messages, fetched from the server (which
// applies DM visibility for this viewer). Latest request wins, and a reply
// for a room that is no longer on screen is dropped.
function loadPins(force) {
  var conv = activeConversation ? activeConversation.id : null;
  if (!conv) return;
  if (!force && pinsState.conv === conv && pinsState.list) return;
  var seq = ++pinsState.seq;
  if (pinsState.conv !== conv) {
    pinsState.conv = conv;
    pinsState.list = null;
    renderPinsCount();
    if (sidePanelTab === 'pins') renderSidePanel();
  }
  // The room on screen by name: the server's active room can lag a switch.
  fetch('/api/pins?conversation=' + encodeURIComponent(conv) + '&token=' + encodeURIComponent(webToken()))
    .then(function(r) { if (!r.ok) throw new Error('pins ' + r.status); return r.json(); })
    .then(function(list) {
      if (seq !== pinsState.seq || !activeConversation || activeConversation.id !== conv) return;
      pinsState.list = Array.isArray(list) ? list : [];
      renderPinsCount();
      if (sidePanelTab === 'pins') renderSidePanel();
      if (sidePanelTab) syncSidePanelTabs();
    })
    .catch(function() {
      if (seq !== pinsState.seq) return;
      pinsState.list = pinsState.conv === conv ? (pinsState.list || []) : [];
      renderPinsCount();
      if (sidePanelTab === 'pins') renderSidePanel();
    });
}

function renderPinsCount() {
  var el = document.getElementById('pins-count');
  if (!el) return;
  var n = pinsState.list ? pinsState.list.length : 0;
  el.textContent = n > 0 ? String(n) : '';
  el.hidden = n === 0;
  var btn = document.getElementById('pins-btn');
  if (btn) btn.setAttribute('aria-label', n > 0 ? n + ' pinned messages' : 'Pinned messages');
}

function renderPinsList(body) {
  // Never paint (or let anyone click) another room's pins: a list for a
  // room that is not on screen is replaced by Loading and a fetch.
  // loadPins resets the list and repaints this tab itself.
  if (activeConversation && pinsState.conv !== activeConversation.id) { loadPins(false); return; }
  if (!pinsState.list || !activeConversation) {
    var loading = document.createElement('div');
    loading.className = 'side-empty';
    loading.textContent = 'Loading pins...';
    body.appendChild(loading);
    return;
  }
  if (pinsState.list.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'side-empty';
    empty.textContent = 'Nothing pinned in this room.';
    body.appendChild(empty);
    return;
  }
  var conv = pinsState.conv;
  pinsState.list.slice().sort(function(a, b) { return b.id - a.id; }).forEach(function(msg) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'pin-row';
    row.setAttribute('data-key', 'p:' + msg.id);
    var head = document.createElement('span');
    head.className = 'pin-head';
    var id = document.createElement('span');
    id.className = 'pin-id';
    id.textContent = '#' + msg.id;
    var who = document.createElement('span');
    who.className = 'pin-sender';
    who.textContent = msg.sender;
    who.style.color = getSenderColor(msg.sender);
    var when = document.createElement('span');
    when.className = 'pin-time';
    when.textContent = msg.timestamp ? formatTimeShort(msg.timestamp) : '';
    head.appendChild(id); head.appendChild(who); head.appendChild(when);
    var text = document.createElement('span');
    text.className = 'pin-text';
    var first = String(msg.text || '').split('\n').filter(function(l) { return l.trim() !== ''; })[0] || '';
    text.textContent = first.length > 160 ? first.slice(0, 160) + '...' : first;
    row.appendChild(head);
    row.appendChild(text);
    row.title = 'Go to message #' + msg.id;
    row.addEventListener('click', function(e) {
      e.stopPropagation();
      if (!activeConversation || activeConversation.id !== conv) return; // a row from a room no longer on screen
      if (isMobileView() || window.innerWidth <= 1024) closeSidePanel(false);
      jumpToMessage(conv, msg.id, msg);
    });
    body.appendChild(row);
  });
}

// Tabs: click, arrows between the two, Escape closes (a popover first).
function initSidePanel() {
  var panel = document.getElementById('side-panel');
  if (!panel) return;
  var tabs = [document.getElementById('side-tab-members'), document.getElementById('side-tab-pins')];
  tabs.forEach(function(tab, i) {
    if (!tab) return;
    tab.addEventListener('click', function(e) {
      e.stopPropagation();
      var want = tab.getAttribute('data-panel');
      if (want === sidePanelTab) return;
      sidePanelTab = want;
      if (want === 'pins') loadPins(true);
      renderSidePanel();
      syncSidePanelTabs();
    });
    tab.addEventListener('keydown', function(e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      var next = tabs[(i + 1) % tabs.length];
      if (next) { next.click(); next.focus(); }
    });
  });
  panel.addEventListener('click', function(e) { if (!e.target.closest('.member-row, .pin-row')) closePopover(); e.stopPropagation(); });
  // Arrow keys move between rows inside the panel body.
  var body = document.getElementById('side-panel-body');
  if (body) body.addEventListener('keydown', function(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    var rows = Array.prototype.slice.call(body.querySelectorAll('.member-row, .pin-row'));
    if (rows.length === 0) return;
    var at = rows.indexOf(document.activeElement);
    var next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at - 1);
    e.preventDefault();
    rows[next].focus();
  });
}

// Escape: an open popover or menu first (focus back to what opened it),
// then the side panel when focus is inside it.
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (openPopover) {
    var anchor = popoverAnchor;
    closePopover();
    if (anchor && anchor.isConnected && anchor.offsetParent !== null) anchor.focus();
    e.preventDefault();
    return;
  }
  var panel = document.getElementById('side-panel');
  if (!panel || !sidePanelTab) return;
  var active = document.activeElement;
  var inPanel = panel.contains(active);
  if (!inPanel) {
    // Escape belongs to whatever else is on top or being typed in: a modal
    // or overlay, the phone drawer, the mention menu, or a text field
    // outside the panel (the search box, the composer).
    if (document.querySelector('.session-modal-overlay, .crew-panel-overlay, .launch-dialog-overlay, .notify-panel-overlay, .settings-overlay, .signed-out-overlay, .palette-overlay, .sidebar-backdrop.visible')) return;
    var mention = document.getElementById('mention-menu');
    if (mention && !mention.classList.contains('hidden')) return;
    if (active && active !== document.body && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return;
  }
  e.preventDefault();
  // Focus goes back to the opener when it was in the panel or nowhere;
  // focus on another control stays where it is.
  closeSidePanel(inPanel || !active || active === document.body);
});

// The room actions that do not fit a phone toolbar: export and import.
function openConvMore(evt) {
  if (evt) evt.stopPropagation();
  var btn = document.getElementById('conv-more-btn');
  if (openPopover && openPopover.classList.contains('conv-more-menu')) { closePopover(); return; }
  closePopover();
  var pop = document.createElement('div');
  pop.className = 'pill-popover conv-more-menu';
  pop.setAttribute('role', 'menu');
  pop.setAttribute('aria-label', 'More room actions');
  pop.addEventListener('click', function(e) { e.stopPropagation(); });
  var items = [['Jump to...', function() { openPalette(); }], ['Search in room', function() { toggleSearch(); }], ['Export this room', exportChat], ['Import a room', openImportDialog]];
  var buttons = items.map(function(it) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item';
    b.setAttribute('role', 'menuitem');
    b.textContent = it[0];
    b.addEventListener('click', function() { closePopover(); it[1](); });
    pop.appendChild(b);
    return b;
  });
  pop.addEventListener('keydown', function(e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      closePopover();
      if (btn) btn.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    var at = buttons.indexOf(document.activeElement);
    var next = e.key === 'ArrowDown' ? Math.min(buttons.length - 1, at + 1) : Math.max(0, at - 1);
    e.preventDefault();
    buttons[next].focus();
  });
  document.body.appendChild(pop);
  if (!isMobileView() && btn) {
    var rect = btn.getBoundingClientRect();
    var pr = pop.getBoundingClientRect();
    pop.style.top = Math.max(8, rect.bottom + 6) + 'px';
    pop.style.left = Math.max(8, Math.min(window.innerWidth - pr.width - 8, rect.right - pr.width)) + 'px';
  }
  openPopover = pop;
  popoverAnchor = btn;
  if (btn) btn.setAttribute('aria-expanded', 'true');
  popoverOnClose = function() { if (btn) btn.setAttribute('aria-expanded', 'false'); };
  buttons[0].focus();
}

function renderTypingBar() {
  var bar = document.getElementById('typing-bar');
  if (!bar) return;
  bar.textContent = '';
  var names = Array.from(typingNames);
  if (names.length === 0) return;
  var text = '';
  if (names.length === 1) {
    text = names[0] + ' is thinking';
  } else if (names.length === 2) {
    text = names[0] + ' and ' + names[1] + ' are thinking';
  } else {
    text = names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] + ' are thinking';
  }
  bar.appendChild(document.createTextNode(text));
  var dots = document.createElement('span');
  dots.className = 'typing-dots';
  for (var i = 0; i < 3; i++) {
    var dot = document.createElement('span');
    dot.textContent = '.';
    dots.appendChild(dot);
  }
  bar.appendChild(dots);
}

function showPopover(anchor, agent) {
  closePopover();
  popoverAnchor = anchor;
  var pop = document.createElement('div');
  pop.className = 'pill-popover';
  pop.addEventListener('click', function(e) { e.stopPropagation(); });

  var color = getSenderColor(agent.name);

  // Header
  var hdr = document.createElement('div');
  hdr.className = 'pop-header';
  hdr.style.borderColor = color + '30';
  var hdrName = document.createElement('span');
  hdrName.textContent = agent.name;
  hdrName.style.color = color;
  hdrName.style.fontWeight = '700';
  var pid = document.createElement('span');
  pid.className = 'pop-pid';
  pid.textContent = agent.host ? 'via ' + agent.host : 'PID ' + agent.pid;
  hdr.appendChild(hdrName); hdr.appendChild(pid);
  pop.appendChild(hdr);

  // Rename
  var renameRow = document.createElement('div');
  renameRow.className = 'pop-row';
  var renameLabel = document.createElement('label');
  renameLabel.textContent = 'Name';
  var renameInput = document.createElement('input');
  renameInput.type = 'text'; renameInput.value = agent.name;
  renameInput.className = 'pop-input';
  renameInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      var newName = renameInput.value.trim();
      if (newName && newName !== agent.name) {
        fetch('/api/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({ oldName: agent.name, newName: newName }, activeConversation && activeConversation.id ? { conversation: activeConversation.id } : {})) });
      }
      closePopover();
    }
  });
  renameRow.appendChild(renameLabel); renameRow.appendChild(renameInput);
  pop.appendChild(renameRow);

  // Role — dynamic from server + clear button
  var allRoles = (availableRoles.preset || []).concat(availableRoles.custom || []);
  allRoles.push({emoji: '\u274C', label: 'clear'});

  var roleSection = document.createElement('div');
  roleSection.className = 'pop-role-section';

  var roleLabel = document.createElement('div');
  roleLabel.className = 'pop-row';
  var rl = document.createElement('label');
  rl.textContent = 'Role';
  var roleDisplay = document.createElement('span');
  roleDisplay.style.fontSize = 'var(--fs-meta)';
  roleDisplay.style.color = color;
  roleDisplay.textContent = agent.role || 'none';
  roleLabel.appendChild(rl);
  roleLabel.appendChild(roleDisplay);
  roleSection.appendChild(roleLabel);

  var roleGrid = document.createElement('div');
  roleGrid.className = 'pop-role-grid';
  allRoles.forEach(function(r) {
    var btn = document.createElement('button');
    btn.className = 'pop-role-btn' + (agent.role === r.label ? ' active' : '');
    btn.textContent = r.emoji + ' ' + r.label;
    btn.title = r.label;
    btn.addEventListener('click', function() {
      var newRole = r.label === 'clear' ? '' : r.label;
      fetch('/api/role', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: agent.name, role: newRole }) });
      closePopover();
    });
    roleGrid.appendChild(btn);
  });
  roleSection.appendChild(roleGrid);

  // Custom role input
  var customRow = document.createElement('div');
  customRow.className = 'pop-row';
  var customLabel = document.createElement('label');
  customLabel.textContent = '';
  var customInput = document.createElement('input');
  customInput.type = 'text';
  customInput.className = 'pop-input';
  customInput.placeholder = 'custom role...';
  customInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      fetch('/api/role', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: agent.name, role: customInput.value.trim() }) });
      closePopover();
    }
  });
  customRow.appendChild(customLabel);
  customRow.appendChild(customInput);
  roleSection.appendChild(customRow);

  pop.appendChild(roleSection);

  // Sound
  var soundRow = document.createElement('div');
  soundRow.className = 'pop-row';
  var soundLabel = document.createElement('label');
  soundLabel.textContent = 'Sound';
  var soundSelect = document.createElement('select');
  soundSelect.className = 'pop-select';
  SOUNDS.forEach(function(s) {
    var opt = document.createElement('option');
    opt.value = s; opt.textContent = s;
    if ((soundSettings[agent.name] || soundSettings._global) === s) opt.selected = true;
    soundSelect.appendChild(opt);
  });
  soundSelect.addEventListener('change', function() {
    soundSettings[agent.name] = soundSelect.value;
    saveSoundSettings();
    playSound(agent.name); // preview
  });
  soundRow.appendChild(soundLabel); soundRow.appendChild(soundSelect);
  pop.appendChild(soundRow);

  // Color picker
  var colorRow = document.createElement('div');
  colorRow.className = 'pop-row';
  var colorLabel = document.createElement('label');
  colorLabel.textContent = 'Color';
  colorRow.appendChild(colorLabel);

  var colorDots = document.createElement('div');
  colorDots.className = 'pop-colors';
  var COLORS = [
    '#da7756','#e74c3c','#f39c12','#f1c40f','#2ecc71','#1abc9c',
    '#4ecdc4','#3498db','#4285f4','#9b59b6','#7c3aed','#e91e63',
    '#ff6b6b','#ff9ff3','#feca57','#48dbfb','#0abde3','#10ac84',
    '#c8d6e5','#8395a7','#576574','#222f3e'
  ];
  var currentColor = getSenderColor(agent.name);
  COLORS.forEach(function(c) {
    var dot = document.createElement('span');
    dot.className = 'pop-color-dot' + (currentColor === c ? ' active' : '');
    dot.style.background = c;
    dot.addEventListener('click', function() {
      SENDER_COLORS[agent.name.toLowerCase()] = c;
      localStorage.setItem('joind-colors', JSON.stringify(SENDER_COLORS));
      recolorMessages(agent.name, c);
      renderPills();
      closePopover();
    });
    colorDots.appendChild(dot);
  });
  colorRow.appendChild(colorDots);
  pop.appendChild(colorRow);

  // Remove button
  var removeBtn = document.createElement('button');
  removeBtn.className = 'pop-remove';
  removeBtn.textContent = 'Dismiss';
  removeBtn.addEventListener('click', function() {
    kickAgent(agent.name); closePopover();
  });
  pop.appendChild(removeBtn);

  // Position — bottom-sheet on mobile, clamped popover on desktop
  document.body.appendChild(pop);
  if (!isMobileView()) {
    var rect = anchor.getBoundingClientRect();
    var popRect = pop.getBoundingClientRect();
    var top = rect.bottom + 6;
    var left = rect.left;
    if (left + popRect.width > window.innerWidth - 8) {
      left = window.innerWidth - popRect.width - 8;
    }
    if (top + popRect.height > window.innerHeight - 8) {
      top = rect.top - popRect.height - 6;
    }
    pop.style.top = Math.max(8, top) + 'px';
    pop.style.left = Math.max(8, left) + 'px';
  }

  openPopover = pop;
}

function closePopover() {
  popoverAnchor = null;
  if (openPopover) { openPopover.remove(); openPopover = null; }
  if (popoverOnClose) { var done = popoverOnClose; popoverOnClose = null; done(); }
}
document.addEventListener('click', closePopover);

// --- Messages ---
function hideWelcome() { var w = document.getElementById('welcome'); if (w) w.remove(); }

function renderMessages(msgs) {
  hideWelcome();
  var c = document.getElementById('messages');
  c.textContent = '';
  lastSender = null;
  lastRenderedDayKey = null;
  msgs = currentViewMessages(msgs);
  if (msgs.length > 0) {
    msgs.forEach(function(m) { appendMessage(m, false); });
    scrollToBottom();
  }
}

function appendMessage(msg, scroll) {
  if (scroll === undefined) scroll = true;
  // Skip reaction-only events (no text, no id — just emoji + messageId)
  if (!msg.text && !msg.id && msg.emoji) return;
  var c = document.getElementById('messages');
  var el = document.createElement('div');
  el.dataset.id = msg.id || '';
  // Message ids are per conversation; a mailbox pane mixes rooms, so every
  // rendered message carries its conversation for conv-qualified lookups.
  el.dataset.conv = msg.conversationId || (activeConversation && activeConversation.id) || '';

  // Day divider: inserted before a message whose local calendar date differs
  // from the last rendered one. The comparison uses a stable date key (not
  // the relative label, so "Today" never masks a midnight crossing); the
  // display label is computed separately at insert time. Carries no data-id
  // and no .message class on purpose (deletion and scroll logic query those).
  var dayKey = new Date(msg.timestamp).toDateString();
  if (dayKey !== lastRenderedDayKey) {
    var divider = document.createElement('div');
    divider.className = 'day-divider';
    var dividerLabel = document.createElement('span');
    dividerLabel.textContent = formatDay(msg.timestamp);
    divider.appendChild(dividerLabel);
    c.appendChild(divider);
    lastRenderedDayKey = dayKey;
    lastSender = null; // divider breaks message grouping
  }

  var isGrouped = msg.sender !== 'system' && msg.sender === lastSender;

  if (msg.sender === 'system') {
    el.className = 'message system';
    lastSender = null;
    var t = document.createElement('div');
    t.className = 'msg-text-wrap'; t.textContent = msg.text;
    el.appendChild(t);
  } else {
    el.className = 'message' + (isGrouped ? ' grouped' : '');
    el.dataset.sender = msg.sender.toLowerCase();
    lastSender = msg.sender;
    var color = getSenderColor(msg.sender);
    el.style.setProperty('--bubble-color', color);

    var av = document.createElement('div');
    av.className = 'msg-avatar'; av.style.background = color;
    av.style.setProperty('--avatar-color', color);
    av.textContent = msg.sender.charAt(0).toUpperCase();

    var body = document.createElement('div');
    body.className = 'msg-body';

    // Reply quote (before header): only when the quoted message is visible
    // in the current view, so a quote never leaks across DM threads
    if (msg.replyTo) {
      var quoteConv = el.dataset.conv;
      var orig = allMessages.find(function(m) { return m.id === msg.replyTo && (!m.conversationId || !quoteConv || m.conversationId === quoteConv); });
      if (orig && messageInCurrentView(orig)) {
        var quote = document.createElement('div');
        quote.className = 'reply-quote';
        quote.textContent = orig.sender + ': ' + (orig.text || '').slice(0, 80);
        quote.style.borderLeftColor = getSenderColor(orig.sender);
        quote.addEventListener('click', function() { jumpToMessage(quoteConv, orig.id); });
        body.appendChild(quote);
      } else if (!orig && Number(msg.replyTo) > 0) {
        // The original is outside the loaded page: show only its id (which
        // this message already carries) and load it on click.
        var farQuote = document.createElement('div');
        farQuote.className = 'reply-quote reply-quote-far';
        farQuote.textContent = 'Reply to #' + Number(msg.replyTo);
        farQuote.title = 'Load the quoted message';
        var farId = Number(msg.replyTo);
        farQuote.addEventListener('click', function() { jumpToMessage(quoteConv, farId); });
        body.appendChild(farQuote);
      }
    }

    var hdr = document.createElement('div');
    hdr.className = 'msg-header';
    var sn = document.createElement('span');
    sn.className = 'msg-sender'; sn.style.color = color; sn.textContent = msg.sender;
    var mid = document.createElement('span');
    mid.className = 'msg-id'; mid.textContent = '#' + msg.id;
    mid.title = 'Click to copy message ID';
    mid.addEventListener('click', function() {
      navigator.clipboard.writeText('#' + msg.id).then(function() {
        mid.classList.add('copied');
        setTimeout(function() { mid.classList.remove('copied'); }, 800);
      });
    });
    var tm = document.createElement('span');
    // As in A: hours and minutes; the full date and time in the tooltip.
    tm.className = 'msg-time'; tm.textContent = formatTimeShort(msg.timestamp);
    tm.title = new Date(msg.timestamp).toLocaleString();
    // As in A: sender, the harness (or remote: <server>) tag, the role, the
    // id, the time. The tag is refreshed in place when the roster arrives.
    el.setAttribute('data-sender', msg.sender);
    hdr.appendChild(sn);
    var tagText = senderTagText(msg.sender);
    var tag = document.createElement('span');
    tag.className = 'msg-tag';
    tag.textContent = tagText;
    tag.hidden = !tagText;
    hdr.appendChild(tag);
    var agent = agents.find(function(a) { return a.name === msg.sender; });
    if (agent && agent.role) {
      var badge = document.createElement('span');
      badge.className = 'msg-role-badge'; badge.textContent = agent.role;
      badge.style.borderColor = color + '40'; badge.style.color = color;
      hdr.appendChild(badge);
    }
    hdr.appendChild(mid); hdr.appendChild(tm);

    var tw = document.createElement('div');
    tw.className = 'msg-text-wrap';
    renderContent(tw, msg.text, el.dataset.conv);
    // A message that names you is marked as in A (an accent bar and tint).
    if (mentionsMe(msg)) el.classList.add('mentions-me');

    // Images: every one the message carries (`images`, else `image`).
    renderMessageImages(tw, msg, el.dataset.conv);

    // Edited badge
    if (msg.edited) {
      var editedBadge = document.createElement('span');
      editedBadge.className = 'msg-edited-badge';
      editedBadge.textContent = '(edited)';
      editedBadge.title = 'Message has been edited';
      tw.appendChild(editedBadge);
    }

    body.appendChild(hdr); body.appendChild(tw);

    // First-class ask chip: shows who owes the decision, resolves on click
    // (any participant can resolve; the server records who did).
    if (msg.ask) {
      var askChip = document.createElement('button');
      askChip.className = 'ask-chip' + (msg.ask.state === 'open' ? ' open' : ' resolved');
      askChip.dataset.messageId = msg.id;
      askChip.textContent = msg.ask.state === 'open'
        ? 'ASK → ' + msg.ask.for
        : 'RESOLVED' + (msg.ask.resolvedBy ? ' by ' + msg.ask.resolvedBy : '');
      if (msg.ask.state === 'open') {
        askChip.title = 'Click to mark this decision as resolved';
        askChip.addEventListener('click', function() {
          resolveAsk(msg.id, msg.conversationId || (activeConversation && activeConversation.id));
        });
      } else {
        askChip.disabled = true;
      }
      body.appendChild(askChip);
    }

    // Inline decision choices (channel view only: the choose endpoint is
    // active-room scoped and a mailbox pane mixes rooms)
    if (msg.choices && msg.choices.length > 0 && !activeDm) {
      var choicesRow = document.createElement('div');
      choicesRow.className = 'msg-choices';
      choicesRow.dataset.messageId = msg.id;
      renderChoices(choicesRow, msg);
      body.appendChild(choicesRow);
    }

    // Reactions row
    var reactRow = document.createElement('div');
    reactRow.className = 'msg-reactions';
    reactRow.dataset.messageId = msg.id;
    body.appendChild(reactRow);

    var actions = document.createElement('div');
    actions.className = 'msg-actions';

    // React button
    var reactBtn = document.createElement('button');
    reactBtn.className = 'msg-action-btn';
    reactBtn.title = 'React';
    var reactIcon = document.createElement('i');
    reactIcon.setAttribute('data-lucide', 'smile-plus');
    reactIcon.setAttribute('width', '14');
    reactIcon.setAttribute('height', '14');
    reactBtn.appendChild(reactIcon);
    reactBtn.addEventListener('click', function() { showReactPicker(msg.id, reactBtn); });
    actions.appendChild(reactBtn);

    // Reply button
    var replyBtn = document.createElement('button');
    replyBtn.className = 'msg-action-btn';
    replyBtn.innerHTML = '<i data-lucide="reply" width="14" height="14"></i>';
    replyBtn.title = 'Reply';
    replyBtn.addEventListener('click', function() { setReplyTo(msg); });
    actions.appendChild(replyBtn);

    var copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action-btn';
    copyBtn.innerHTML = '<i data-lucide="copy" width="14" height="14"></i>';
    copyBtn.title = 'Copy message';
    copyBtn.addEventListener('click', function() {
      navigator.clipboard.writeText(msg.text).then(function() {
        copyBtn.innerHTML = '<i data-lucide="check" width="14" height="14"></i>';
        copyBtn.classList.add('copied');
        if (window.lucide) lucide.createIcons({ root: copyBtn });
        setTimeout(function() { 
          copyBtn.innerHTML = '<i data-lucide="copy" width="14" height="14"></i>'; 
          copyBtn.classList.remove('copied'); 
          if (window.lucide) lucide.createIcons({ root: copyBtn });
        }, 1500);
      });
    });
    actions.appendChild(copyBtn);

    var delBtn = document.createElement('button');
    delBtn.className = 'msg-action-btn msg-action-delete';
    delBtn.title = 'Delete message';
    var delIcon = document.createElement('i');
    delIcon.setAttribute('data-lucide', 'trash-2');
    delIcon.setAttribute('width', '14');
    delIcon.setAttribute('height', '14');
    delBtn.appendChild(delIcon);
    delBtn.addEventListener('click', function() {
      if (!confirm('Delete message #' + msg.id + '?')) return;
      fetch('/api/messages/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The message's own room: a DM pane mixes rooms.
        body: JSON.stringify({ id: msg.id, conversation: el.dataset.conv || undefined })
      });
    });
    actions.appendChild(delBtn);

    el.dataset.id = msg.id;
    el.appendChild(av); el.appendChild(body);
    // Hover actions (react, reply, edit, delete) are active-room scoped;
    // a mailbox pane mixes rooms, so they stay hidden there. The composer
    // is the reply path in a DM thread.
    if (!activeDm) el.appendChild(actions);

    // Grouped: add hover timestamp + id
    if (isGrouped) {
      var hoverTime = document.createElement('span');
      hoverTime.className = 'msg-time-hover';
      hoverTime.textContent = '#' + msg.id + ' · ' + formatTimeShort(msg.timestamp);
      el.appendChild(hoverTime);
    }
  }

  c.appendChild(el);
  if (window.lucide) lucide.createIcons({ root: el });
  if (scroll && autoScroll) {
    scrollToBottom();
  } else if (scroll && !autoScroll) {
    unreadCount++;
    updateNewMsgsPill();
  }
  addCodeCopyButtons(el);
}

function renderChoices(container, msg) {
  if (!container || !msg || !msg.choices) return;
  container.innerHTML = '';
  var resolved = msg.choiceResponse;
  msg.choices.forEach(function(opt) {
    var btn = document.createElement('button');
    btn.className = 'msg-choice-btn';
    btn.type = 'button';
    btn.textContent = opt;
    if (resolved) {
      btn.disabled = true;
      if (resolved.value === opt) btn.classList.add('chosen');
    }
    btn.addEventListener('click', function() {
      if (btn.disabled) return;
      var by = (document.getElementById('sender-name') && document.getElementById('sender-name').value) || 'human';
      btn.disabled = true;
      fetch('/api/message/' + msg.id + '/choose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: opt, by: by, token: webToken() })
      }).catch(function() { btn.disabled = false; });
    });
    container.appendChild(btn);
  });
  if (resolved) {
    var note = document.createElement('span');
    note.className = 'msg-choice-resolved';
    note.textContent = resolved.by + ' picked "' + resolved.value + '"';
    container.appendChild(note);
  }
}

// Message bodies are Markdown. marked keeps raw HTML, so its output always
// goes through the sanitizer (public/sanitize.js, DOMPurify with an
// allowlist) before it reaches the DOM; without both, the text is shown as
// plain text. Mentions and #N links are added afterwards as DOM nodes.
function renderContent(parent, text, conv) {
  if (!text) { parent.textContent = ''; return; }
  if (typeof marked !== 'undefined' && typeof window.joindSanitizeHtml === 'function') {
    // Ensure real newlines (WebSocket/JSON may deliver literal \n)
    text = text.replace(/\\n/g, '\n');
    parent.innerHTML = window.joindSanitizeHtml(marked.parse(text));
    decorateMentions(parent);
    decorateLinkCards(parent);
  } else {
    parent.textContent = '';
    renderTextWithMentions(parent, text);
  }
  linkifyMessageRefs(parent, conv || currentConvId());
}

// @name in rendered text becomes a coloured mention span, built with
// textContent. Code, pre and links are left as they are.
var MENTION_SKIP = { A: true, CODE: true, PRE: true, KBD: true };
function decorateMentions(root) {
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: function(node) {
      for (var p = node.parentNode; p && p !== root; p = p.parentNode) {
        if (p.nodeType === 1 && (MENTION_SKIP[p.nodeName] || (p.classList && p.classList.contains('mention')))) return NodeFilter.FILTER_REJECT;
      }
      return node.nodeValue && node.nodeValue.indexOf('@') >= 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
  });
  var nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(function(node) {
    var parts = node.nodeValue.split(/(@\w[\w-]*)/g);
    if (parts.length < 2) return;
    var frag = document.createDocumentFragment();
    parts.forEach(function(part) {
      if (/^@\w/.test(part)) {
        var c = getSenderColor(part.slice(1));
        var span = document.createElement('span');
        span.className = 'mention';
        span.style.color = c;
        span.style.background = c + '20';
        span.textContent = part;
        frag.appendChild(span);
      } else if (part) {
        frag.appendChild(document.createTextNode(part));
      }
    });
    node.parentNode.replaceChild(frag, node);
  });
}

function renderTextWithMentions(parent, text) {
  if (!text) { parent.textContent = ''; return; }
  text.split(/(@\w[\w-]*)/g).forEach(function(part) {
    if (part.match(/^@\w/)) {
      var span = document.createElement('span');
      span.className = 'mention'; span.textContent = part;
      parent.appendChild(span);
    } else {
      parent.appendChild(document.createTextNode(part));
    }
  });
}

function addCodeCopyButtons(container) {
  container.querySelectorAll('pre').forEach(function(pre) {
    if (pre.querySelector('.code-copy-btn')) return;
    var btn = document.createElement('button');
    btn.className = 'code-copy-btn'; 
    btn.innerHTML = '<i data-lucide="copy" width="12" height="12"></i>';
    btn.addEventListener('click', function() {
      var code = pre.querySelector('code');
      navigator.clipboard.writeText(code ? code.textContent : pre.textContent).then(function() {
        btn.innerHTML = '<i data-lucide="check" width="12" height="12"></i>'; 
        btn.classList.add('copied');
        if (window.lucide) lucide.createIcons({ root: btn });
        setTimeout(function() { 
          btn.innerHTML = '<i data-lucide="copy" width="12" height="12"></i>'; 
          btn.classList.remove('copied');
          if (window.lucide) lucide.createIcons({ root: btn });
        }, 1500);
      });
    });
    pre.style.position = 'relative'; pre.appendChild(btn);
  });
  if (window.lucide) lucide.createIcons({ root: container });
}

function scrollToBottom() {
  var c = document.getElementById('messages'); c.scrollTop = c.scrollHeight;
}

// Smart scroll guard — don't steal focus when user is reading history
(function() {
  var c = document.getElementById('messages');
  if (!c) return;
  c.addEventListener('scroll', function() {
    var distFromBottom = c.scrollHeight - c.scrollTop - c.clientHeight;
    if (distFromBottom < 60) {
      autoScroll = true;
      if (unreadCount > 0) {
        unreadCount = 0;
        updateNewMsgsPill();
      }
    } else {
      autoScroll = false;
    }
  });
})();

function updateNewMsgsPill() {
  var pill = document.getElementById('new-msgs-pill');
  var countEl = document.getElementById('new-msgs-count');
  if (!pill || !countEl) return;
  if (unreadCount > 0 && !autoScroll) {
    countEl.textContent = unreadCount;
    pill.classList.remove('hidden');
  } else {
    pill.classList.add('hidden');
  }
}

function jumpToBottom() {
  if (historyView) { exitHistoryView(); return; }
  scrollToBottom();
  autoScroll = true;
  unreadCount = 0;
  updateNewMsgsPill();
}

// --- Composer attachments: several images, files, link cards, snippets ---
// Images wait in the composer as removable thumbnails and go out in one
// message (`images`, the first also as `image`: src/attachments.ts). Files
// are uploaded and written into the text as a link, as chat_upload does.
// Remote rooms refuse attachments on the server; the composer says so first.
var MAX_COMPOSER_IMAGES = 10;
var MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
var pendingImages = []; // [{ url, name }] attached to the current draft
var imageUploadsInFlight = 0;

function composerIsRemote() {
  return !activeDm && !!activeConversation && isRemoteConversation(activeConversation.id);
}

function attachmentsRefusedHere() {
  if (!composerIsRemote()) return false;
  showComposerError('Attachments are not supported in remote rooms. Only text is carried across a link.');
  return true;
}

function showComposerNote(text) {
  var el = document.getElementById('composer-note');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

function uploadFile(file) {
  return fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) {
      if (!data || typeof data.url !== 'string') throw new Error('no url');
      return data.url;
    });
}

// Kept for the paste and drop handlers: one image joins the draft.
function uploadImage(file) { addImageFiles([file]); }

function addImageFiles(files) {
  var list = Array.prototype.slice.call(files || []).filter(function(f) { return f && /^image\//.test(f.type); });
  if (list.length === 0) return;
  if (attachmentsRefusedHere()) return;
  showComposerError('');
  var fit = window.joindUi.imagesThatFit(pendingImages.length + imageUploadsInFlight, list.length, MAX_COMPOSER_IMAGES);
  var notes = [];
  if (fit.refused > 0) notes.push('At most ' + MAX_COMPOSER_IMAGES + ' images per message; ' + fit.refused + ' not added.');
  list.slice(0, fit.take).forEach(function(file) {
    if (file.size > MAX_UPLOAD_BYTES) { notes.push('"' + (file.name || 'image') + '" is over 25 MB.'); return; }
    imageUploadsInFlight++;
    renderImageStrip();
    uploadFile(file).then(function(url) {
      imageUploadsInFlight--;
      pendingImages.push({ url: url, name: file.name || 'image' });
      renderImageStrip();
    }).catch(function() {
      imageUploadsInFlight--;
      renderImageStrip();
      showComposerError('Could not upload "' + (file.name || 'image') + '".');
    });
  });
  if (notes.length) showComposerError(notes.join(' '));
}

function renderImageStrip() {
  var bar = document.getElementById('image-preview');
  var strip = document.getElementById('image-strip');
  var label = document.getElementById('image-preview-label');
  if (!bar || !strip) return;
  strip.textContent = '';
  pendingImages.forEach(function(img, i) {
    var cell = document.createElement('div');
    cell.className = 'image-thumb';
    var pic = document.createElement('img');
    pic.className = 'image-preview-thumb';
    pic.src = img.url;
    pic.alt = 'Attached image ' + (i + 1) + ': ' + img.name;
    var rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'image-thumb-remove';
    rm.setAttribute('aria-label', 'Remove image ' + (i + 1) + ' (' + img.name + ')');
    rm.title = 'Remove';
    rm.textContent = '×';
    rm.addEventListener('click', function() {
      var at = pendingImages.indexOf(img);
      if (at >= 0) pendingImages.splice(at, 1);
      renderImageStrip();
      var rest = strip.querySelectorAll('.image-thumb-remove');
      if (rest.length) rest[Math.min(at, rest.length - 1)].focus();
      else document.getElementById('message-input').focus();
    });
    cell.appendChild(pic);
    cell.appendChild(rm);
    strip.appendChild(cell);
  });
  for (var k = 0; k < imageUploadsInFlight; k++) {
    var wait = document.createElement('div');
    wait.className = 'image-thumb uploading';
    wait.setAttribute('aria-hidden', 'true');
    strip.appendChild(wait);
  }
  var n = pendingImages.length;
  label.textContent = imageUploadsInFlight > 0
    ? 'Uploading ' + imageUploadsInFlight + (imageUploadsInFlight === 1 ? ' image' : ' images') + '...'
    : n + (n === 1 ? ' image attached' : ' images attached');
  bar.classList.toggle('hidden', n === 0 && imageUploadsInFlight === 0);
  updateSendBtn();
}

function clearImagePreview() {
  pendingImages = [];
  renderImageStrip();
}

// Files: uploaded, then written into the draft as a link at the cursor.
function addFiles(files) {
  var list = Array.prototype.slice.call(files || []);
  if (list.length === 0) return;
  if (attachmentsRefusedHere()) return;
  showComposerError('');
  list.forEach(function(file) {
    if (file.size > MAX_UPLOAD_BYTES) { showComposerError('"' + (file.name || 'file') + '" is over 25 MB.'); return; }
    uploadFile(file).then(function(url) {
      insertIntoComposer(window.joindUi.fileLinkMarkdown(file.name, url), true);
    }).catch(function() {
      showComposerError('Could not upload "' + (file.name || 'file') + '".');
    });
  });
}

// Plain text into the textarea at the cursor (never as HTML).
function insertIntoComposer(text, ownLine) {
  var input = document.getElementById('message-input');
  var r = window.joindUi.insertText(input.value, input.selectionStart, input.selectionEnd, text, ownLine);
  input.value = r.value;
  input.focus();
  input.setSelectionRange(r.caret, r.caret);
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  updateSendBtn();
  syncHighlight();
}

function pickFiles(imagesOnly) {
  if (attachmentsRefusedHere()) return;
  var input = document.getElementById('attach-input');
  if (!input) return;
  input.value = '';
  input.accept = imagesOnly ? 'image/*' : '';
  input.onchange = function() {
    var files = Array.prototype.slice.call(input.files || []);
    if (imagesOnly) { addImageFiles(files); return; }
    // Images picked through Files still join the draft as images.
    addImageFiles(files.filter(function(f) { return /^image\//.test(f.type); }));
    addFiles(files.filter(function(f) { return !/^image\//.test(f.type); }));
  };
  input.click();
}

// Paste image from the menu: the async clipboard where the browser allows
// it, else a note to paste into the box (the paste handler takes it there).
function pasteImageFromClipboard() {
  if (attachmentsRefusedHere()) return;
  var input = document.getElementById('message-input');
  var fallback = function() {
    input.focus();
    showComposerNote('Press Ctrl+V (Cmd+V on a Mac) in the message box to paste an image.');
  };
  if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') { fallback(); return; }
  navigator.clipboard.read().then(function(items) {
    var blobs = [];
    var reads = [];
    items.forEach(function(item) {
      var type = (item.types || []).find(function(t) { return /^image\//.test(t); });
      if (type) reads.push(item.getType(type).then(function(b) { blobs.push(new File([b], 'pasted.' + type.split('/')[1], { type: type })); }));
    });
    return Promise.all(reads).then(function() {
      if (blobs.length === 0) { showComposerNote('No image on the clipboard.'); input.focus(); return; }
      showComposerNote('');
      addImageFiles(blobs);
      input.focus();
    });
  }).catch(fallback);
}

// A message's images as a grid of thumbnails, each opening the viewer. In
// a remote room the files live on the home server, not here, so a line
// says so instead of loading a same-named file from this server.
function renderMessageImages(parent, msg, conv) {
  var list = window.joindUi ? window.joindUi.messageImageList(msg) : [];
  if (list.length === 0) return;
  if (conv && isRemoteConversation(conv)) {
    var note = document.createElement('div');
    note.className = 'msg-images-remote';
    note.textContent = (list.length === 1 ? '1 image' : list.length + ' images') + ' on ' + remoteServerOf(conv) + ' (not shown here)';
    parent.appendChild(note);
    return;
  }
  var grid = document.createElement('div');
  grid.className = 'msg-images' + (list.length > 1 ? ' multi' : '');
  list.forEach(function(src, i) {
    var img = document.createElement('img');
    img.className = 'msg-image';
    img.src = src;
    img.loading = 'lazy';
    img.alt = list.length > 1 ? 'Image ' + (i + 1) + ' of ' + list.length : 'Image';
    img.tabIndex = 0;
    img.setAttribute('role', 'button');
    img.addEventListener('click', function() { openLightbox(src); });
    img.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLightbox(src); }
    });
    grid.appendChild(img);
  });
  parent.appendChild(grid);
}

function openLightbox(src) {
  var overlay = document.createElement('div');
  overlay.className = 'lightbox';
  var img = document.createElement('img');
  img.src = src;
  overlay.appendChild(img);
  overlay.addEventListener('click', function() { overlay.remove(); });
  document.body.appendChild(overlay);
}

// --- Reply/Thread ---
function setReplyTo(msg) {
  replyingTo = msg;
  var preview = document.getElementById('reply-preview');
  var previewText = document.getElementById('reply-preview-text');
  previewText.textContent = msg.sender + ': ' + msg.text.slice(0, 100);
  preview.classList.remove('hidden');
  document.getElementById('message-input').focus();
}

function clearReply() {
  replyingTo = null;
  var preview = document.getElementById('reply-preview');
  preview.classList.add('hidden');
}

function scrollToMessage(id) {
  var el = document.querySelector('[data-id="' + id + '"]');
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.transition = 'background 0.3s';
    el.style.background = 'var(--accent-soft)';
    setTimeout(function() { el.style.background = ''; }, 1500);
  }
}


// --- Message links (#N) and the history window ---
// A message body citing #1234 links to that message in the same room. A
// target outside the loaded page is fetched with the messages around it
// (GET /api/messages?around=), shown as a history window with a way back to
// the latest messages. Reply quotes and search hits use the same loader.

// `#` starts a token (start of text, whitespace, or an opening bracket) and
// the digits end at a word boundary. Code, links and mentions are skipped.
// A range token (#5-#9, #5-9: the search grammar's id range) is not a
// reference: its first half is not linked, and its second half follows a '-'.
var MSG_REF_RE = /(^|[\s(\[{])#(\d{1,12})(?!\w|-#?\d)/g;
var MSG_REF_SKIP = { A: true, CODE: true, PRE: true, KBD: true, SAMP: true, SCRIPT: true, STYLE: true, TEXTAREA: true };

// Set while the channel pane shows a window around an older message:
// { conv, anchor, hasNewer, newCount }. Null in the normal (latest) view.
var historyView = null;
var jumpSeq = 0;
var historyExitSeq = 0;

function linkifyMessageRefs(root, conv) {
  if (!root || !root.ownerDocument) return;
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: function(node) {
      for (var p = node.parentNode; p && p !== root; p = p.parentNode) {
        if (p.nodeType === 1 && (MSG_REF_SKIP[p.nodeName] || (p.classList && (p.classList.contains('mention') || p.classList.contains('msg-ref'))))) {
          return NodeFilter.FILTER_REJECT;
        }
      }
      return node.nodeValue && node.nodeValue.indexOf('#') >= 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    }
  });
  var nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(function(node) { linkifyTextNode(node, conv); });
}

function linkifyTextNode(node, conv) {
  var text = node.nodeValue;
  MSG_REF_RE.lastIndex = 0;
  var m, last = 0, frag = null;
  while ((m = MSG_REF_RE.exec(text)) !== null) {
    var hashAt = m.index + m[1].length;
    if (!frag) frag = document.createDocumentFragment();
    if (hashAt > last) frag.appendChild(document.createTextNode(text.slice(last, hashAt)));
    frag.appendChild(makeMessageRef(Number(m[2]), conv));
    last = hashAt + 1 + m[2].length;
  }
  if (!frag) return;
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  node.parentNode.replaceChild(frag, node);
}

function makeMessageRef(id, conv) {
  var a = document.createElement('a');
  a.className = 'msg-ref';
  a.href = '#';
  a.textContent = '#' + id;
  a.title = 'Jump to message #' + id;
  a.dataset.refId = String(id);
  if (conv) a.dataset.refConv = conv;
  a.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    jumpToMessage(a.dataset.refConv || currentConvId(), id);
  });
  return a;
}

function currentConvId() {
  return (activeConversation && activeConversation.id) || '';
}

// The rendered element for (conv, id) in the message pane, if any.
function messageElementFor(conv, id) {
  var els = document.querySelectorAll('#messages .message[data-id="' + Number(id) + '"]');
  for (var i = 0; i < els.length; i++) {
    if (!conv || els[i].dataset.conv === conv) return els[i];
  }
  return null;
}

function highlightMessageEl(el) {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('msg-flash');
  void el.offsetWidth;
  el.classList.add('msg-flash');
  setTimeout(function() { el.classList.remove('msg-flash'); }, 1600);
}

var refNoticeTimer = null;
function showRefNotice(text) {
  var n = document.getElementById('ref-notice');
  if (!n) return;
  n.textContent = text;
  n.hidden = false;
  clearTimeout(refNoticeTimer);
  refNoticeTimer = setTimeout(function() { n.hidden = true; }, 3500);
}

function refNotFoundText(id, body) {
  if (body && body.reason === 'older-than-cache') {
    return 'Message #' + id + ' is older than this server\'s copy of the remote room';
  }
  return 'Message #' + id + ' not found in this room';
}

// The DM partner whose mailbox shows `msg`, or null when it is not the
// viewer's conversation (then there is no view to open here).
function dmPartnerOf(msg) {
  if (!msg || !msg.to) return null;
  var me = myName();
  if (msg.sender === me) {
    for (var i = 0; i < msg.to.length; i++) {
      if (msg.to[i] !== me) return msg.to[i];
    }
    return null;
  }
  return msg.to.indexOf(me) >= 0 ? msg.sender : null;
}

// Jump to message `id` of conversation `conv`: scroll to it when it is on
// screen, else ask the server (which applies DM visibility, fail closed),
// then open its DM thread or load the window around it. `known` is the
// message when the caller already holds it (a search hit).
function jumpToMessage(conv, id, known) {
  id = Number(id);
  if (!conv || !(id > 0)) return;
  // A jump shows the conversation: leave a page (Crew) for the Rooms view,
  // which lists rooms and DMs alike, wherever the message turns out to be.
  leavePageFor('rooms');
  var seq = ++jumpSeq;
  var el = messageElementFor(conv, id);
  if (el) { highlightMessageEl(el); return; }
  if (known) { openLoadedMessage(conv, known, seq); return; }
  fetch('/api/message/' + id + '?conversation=' + encodeURIComponent(conv) + '&token=' + encodeURIComponent(webToken()))
    .then(function(r) { return r.json().then(function(body) { return { ok: r.ok, body: body }; }); })
    .then(function(res) {
      if (seq !== jumpSeq) return;
      if (!res.ok) { showRefNotice(refNotFoundText(id, res.body)); return; }
      openLoadedMessage(conv, res.body, seq);
    })
    .catch(function() { if (seq === jumpSeq) showRefNotice('Could not load message #' + id); });
}

function openLoadedMessage(conv, msg, seq) {
  if (msg.to) {
    var partner = dmPartnerOf(msg);
    if (!partner) { showRefNotice(refNotFoundText(msg.id)); return; }
    if (activeDm !== partner) selectDm(partner);
    // Bound to this jump: a later navigation (or jump) stops the retries.
    scrollToMessageWhenReady(msg.id, 10, conv, jumpSeq);
    return;
  }
  if (!activeConversation || activeConversation.id !== conv) {
    // selectConversation invalidates pending jumps (a navigation), so this
    // jump continues under the sequence number taken after it.
    var afterSelect;
    selectConversation(conv, function() {
      if (afterSelect !== jumpSeq) return;
      seq = afterSelect;
      var el = messageElementFor(conv, msg.id);
      if (el) { highlightMessageEl(el); return; }
      loadAroundMessage(conv, msg.id, seq);
    });
    afterSelect = jumpSeq;
    return;
  }
  if (activeDm) {
    // Back to the channel pane first; the target may already be loaded there.
    renderChannelView();
    var el = messageElementFor(conv, msg.id);
    if (el) { highlightMessageEl(el); return; }
  }
  loadAroundMessage(conv, msg.id, seq);
}

function loadAroundMessage(conv, id, seq) {
  // Messages this pane holds now; any other that arrives before the window
  // lands is counted on the "Jump to latest" pill (the reload shows it).
  var heldBefore = {};
  allMessages.forEach(function(m) { heldBefore[String(m.id)] = true; });
  fetch('/api/messages?conversation=' + encodeURIComponent(conv) + '&around=' + id + '&limit=60&token=' + encodeURIComponent(webToken()))
    .then(function(r) { return r.json().then(function(body) { return { ok: r.ok, body: body }; }); })
    .then(function(res) {
      if (seq !== jumpSeq) return;
      if (!activeConversation || activeConversation.id !== conv || activeDm) return;
      if (!res.ok || !res.body || !Array.isArray(res.body.messages)) { showRefNotice(refNotFoundText(id, res.body)); return; }
      var arrived = allMessages.filter(function(m) { return !heldBefore[String(m.id)] && messageInCurrentView(m); }).length;
      historyView = { conv: conv, anchor: id, hasNewer: !!res.body.hasNewer, newCount: arrived };
      allMessages = res.body.messages.slice();
      renderChannelView();
      var el = messageElementFor(conv, id);
      if (el) highlightMessageEl(el);
    })
    .catch(function() { if (seq === jumpSeq) showRefNotice('Could not load message #' + id); });
}

// The history window's banner (top of the pane) and its "latest" pill.
function renderHistoryChrome() {
  var pill = document.getElementById('history-pill');
  var c = document.getElementById('messages');
  var old = document.getElementById('history-banner');
  if (old) old.remove();
  var inWindow = historyView && !activeDm && activeConversation && activeConversation.id === historyView.conv;
  if (!inWindow) {
    if (pill) pill.classList.add('hidden');
    return;
  }
  var banner = document.createElement('div');
  banner.id = 'history-banner';
  banner.className = 'history-banner';
  var label = document.createElement('span');
  label.textContent = 'Showing older messages around #' + historyView.anchor + '.';
  var back = document.createElement('button');
  back.type = 'button';
  back.className = 'btn-link';
  back.textContent = 'Jump to latest';
  back.addEventListener('click', jumpToBottom);
  banner.appendChild(label);
  banner.appendChild(back);
  c.insertBefore(banner, c.firstChild);
  if (pill) {
    var countEl = document.getElementById('history-pill-label');
    if (countEl) {
      countEl.textContent = historyView.newCount > 0
        ? 'Jump to latest (' + historyView.newCount + ' new)'
        : 'Jump to latest';
    }
    pill.classList.remove('hidden');
  }
}

// Leave the history window: reload the latest page of the room. Messages
// that arrive meanwhile are kept (merged by id), so none is lost.
function exitHistoryView() {
  if (!historyView) return;
  var conv = historyView.conv;
  historyView = null;
  allMessages = [];
  renderHistoryChrome();
  var mySeq = ++historyExitSeq;
  fetch('/api/messages?conversation=' + encodeURIComponent(conv) + '&token=' + encodeURIComponent(webToken()))
    .then(function(r) { return r.json(); })
    .then(function(list) {
      if (mySeq !== historyExitSeq || historyView) return;
      if (!activeConversation || activeConversation.id !== conv) return;
      var fetched = Array.isArray(list) ? list.slice() : [];
      var seen = {};
      fetched.forEach(function(m) { seen[String(m.id)] = true; });
      allMessages.forEach(function(m) { if (!seen[String(m.id)]) fetched.push(m); });
      fetched.sort(function(a, b) {
        // Local link lines (negative ids) keep their time order.
        if (a.id > 0 && b.id > 0) return a.id - b.id;
        return a.timestamp - b.timestamp;
      });
      allMessages = fetched;
      if (!activeDm) renderChannelView();
    })
    .catch(function() { showRefNotice('Could not load the latest messages'); });
}

// --- Send ---
function sendMessage() {
  var input = document.getElementById('message-input');
  var sender = document.getElementById('sender-name');
  var text = input.value.trim();
  if (!text && pendingImages.length === 0) return;
  if (imageUploadsInFlight > 0) { showComposerError('Wait for the images to finish uploading.'); return; }
  if (historyView) exitHistoryView();

  // /decide slash command: "/decide Question? | optA | optB | optC"
  var decide = parseDecideCommand(text);
  if (decide) {
    postDecisionCard(decide.question, decide.choices);
    input.value = ''; input.style.height = 'auto'; input.focus(); updateSendBtn();
    syncHighlight();
    return;
  }

  // DM view: route through the mailbox endpoint so the message lands in a
  // conversation the recipient actually reads (their bound room), not
  // whatever channel happens to be behind this thread.
  if (activeDm) {
    var dmPayload = { to: activeDm, text: text || imagesPlaceholder(), token: webToken() };
    if (pendingImages.length) dmPayload.images = pendingImages.map(function(p) { return p.url; });
    if (replyingTo) {
      // The server keeps the reply only if the quoted message lives in the
      // room the DM is routed to (ids are per room).
      dmPayload.replyTo = replyingTo.id;
      dmPayload.replyConversationId = replyingTo.conversationId || (activeConversation && activeConversation.id);
    }
    // The rendered echo arrives over the WebSocket like every other send.
    postComposerSend('/api/dm/send', dmPayload, composerDraftSnapshot(text));
    return;
  }

  var payload = { sender: sender.value || 'human', text: text || imagesPlaceholder(), token: webToken() };
  if (replyingTo) payload.replyTo = replyingTo.id;
  if (pendingImages.length) payload.images = pendingImages.map(function(p) { return p.url; });
  postComposerSend('/api/send', payload, composerDraftSnapshot(text));
}

// The text an image-only message carries: "[image]" or "[N images]".
function imagesPlaceholder() {
  return pendingImages.length > 1 ? '[' + pendingImages.length + ' images]' : '[image]';
}

// The draft as submitted: its text and the exact image and reply-target
// objects. A newer draft composed while the send is in flight holds other
// objects, so identity comparison tells the two apart.
function composerDraftSnapshot(text) {
  return { text: text, images: pendingImages.slice(), reply: replyingTo };
}

// One composer send in flight at a time: a second Enter while the first is
// unanswered would post the same text twice.
var composerSendInFlight = false;

// Post a composer message and clear the composer only when the server took
// it: 200 (sent) or 202 (queued for a remote room). On any failure the
// typed text, reply target and image stay put and a one-line error shows.
function postComposerSend(url, payload, draft) {
  if (composerSendInFlight) return;
  composerSendInFlight = true;
  showComposerError('');
  var input = document.getElementById('message-input');
  // Local order stamp at request start: any pending event that arrives
  // while the request is in flight takes a larger stamp, so it outranks
  // this response's snapshot whatever the clock does meanwhile.
  var requestSeq = nextPendingSeq();
  var genAtStart = pendingGeneration;
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload) })
    .then(function(r) {
      return r.json().catch(function() { return {}; }).then(function(body) {
        return { ok: r.ok, status: r.status, body: body || {} };
      });
    })
    .then(function(res) {
      composerSendInFlight = false;
      if (!res.ok) {
        var why = (res.body && typeof res.body.error === 'string' && res.body.error) || ('HTTP ' + res.status);
        showComposerError('Not sent: ' + why + '. Your text is still in the box.');
        return;
      }
      // Clear only what belongs to the submitted draft: text, an image or a
      // reply target chosen during the request survive.
      if (input.value.trim() === draft.text) {
        input.value = ''; input.style.height = 'auto';
      }
      if (draft.reply && replyingTo === draft.reply) clearReply();
      if (draft.images && draft.images.length) {
        pendingImages = pendingImages.filter(function(p) { return draft.images.indexOf(p) < 0; });
        renderImageStrip();
      }
      showComposerNote('');
      input.focus(); updateSendBtn();
      syncHighlight();
      if (res.status === 202 && genAtStart === pendingGeneration) onComposerQueued(res.body, payload, requestSeq);
    })
    .catch(function() {
      composerSendInFlight = false;
      showComposerError('Not sent: the server could not be reached. Your text is still in the box.');
    });
}

function showComposerError(text) {
  var el = document.getElementById('composer-error');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

// 202: the message is queued for a remote room. Render the entry the
// server returned, unless the WebSocket already said something newer about
// it (dispatched, deleted, or a later state): a response can arrive after
// the events it predates, and must never undo them.
function onComposerQueued(body, payload, requestSeq) {
  var entry = (body.pending && typeof body.pending === 'object') ? body.pending : null;
  var clientId = (entry && entry.clientId) || body.clientId;
  var conv = (entry && entry.conversationId) || body.conversationId ||
    (activeConversation && !activeDm ? activeConversation.id : null);
  if (!clientId || !conv) return;
  var p = {
    clientId: clientId,
    sender: (entry && entry.sender) || myName(),
    text: (entry && entry.text) || payload.text,
    queuedAt: (entry && entry.queuedAt) || serverNow(),
    to: (entry && entry.to) || (payload.to ? (Array.isArray(payload.to) ? payload.to : [payload.to]) : undefined),
    state: (entry && entry.state) || body.state,
    reason: (entry && (entry.reason || entry.heldReason)) || body.reason,
  };
  // Stale-202 rule: compare with the moment the request started ...
  if (!pendingSnapshotIsCurrent(p.clientId, requestSeq)) return;
  // ... but record it with the moment it is applied, so a snapshot fetch
  // that started before this 202 landed cannot erase the acknowledged entry.
  applyPendingUpsert(conv, p);
}

// --- Decision cards ---

function parseDecideCommand(text) {
  if (!text || text.indexOf('/decide ') !== 0) return null;
  var rest = text.slice('/decide '.length).trim();
  var parts = rest.split('|').map(function(s) { return s.trim(); }).filter(Boolean);
  if (parts.length < 3) return null;  // need question + at least 2 options
  return { question: parts[0], choices: parts.slice(1) };
}

function postDecisionCard(question, choices) {
  var sender = document.getElementById('sender-name');
  var payload = {
    sender: sender.value || 'human',
    text: question,
    choices: choices,
    token: webToken(),
  };
  if (activeDm) payload.to = [activeDm];
  fetch('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function toggleDecidePopover() {
  var pop = document.getElementById('decide-popover');
  if (pop.hasAttribute('hidden')) openDecidePopover();
  else closeDecidePopover();
}

function openDecidePopover() {
  closeAttachMenu(false);
  closeUrlPopover(false);
  var pop = document.getElementById('decide-popover');
  pop.removeAttribute('hidden');
  var btn = document.getElementById('decide-btn');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  var opts = document.getElementById('decide-options');
  opts.innerHTML = '';
  addDecideOption();
  addDecideOption();
  document.getElementById('decide-question').value = '';
  setTimeout(function() { document.getElementById('decide-question').focus(); }, 0);
}

function closeDecidePopover() {
  document.getElementById('decide-popover').setAttribute('hidden', '');
  var btn = document.getElementById('decide-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function addDecideOption(value) {
  var opts = document.getElementById('decide-options');
  if (opts.children.length >= 8) return;
  var row = document.createElement('div');
  row.className = 'decide-option-row';
  var input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Option ' + (opts.children.length + 1);
  if (value) input.value = value;
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); submitDecideForm(); }
  });
  var rm = document.createElement('button');
  rm.type = 'button';
  rm.className = 'decide-remove';
  rm.title = 'Remove option';
  rm.textContent = '×';
  rm.addEventListener('click', function() {
    if (opts.children.length > 2) row.remove();
  });
  row.appendChild(input);
  row.appendChild(rm);
  opts.appendChild(row);
}

function submitDecideForm() {
  var question = document.getElementById('decide-question').value.trim();
  if (!question) {
    document.getElementById('decide-question').focus();
    return;
  }
  var inputs = document.querySelectorAll('#decide-options input');
  var choices = [];
  inputs.forEach(function(i) {
    var v = i.value.trim();
    if (v) choices.push(v);
  });
  if (choices.length < 2) return;
  postDecisionCard(question, choices);
  closeDecidePopover();
}

function mentionAll() {
  var input = document.getElementById('message-input');
  input.value = '@all ';
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  input.focus();
  updateSendBtn();
  syncHighlight();
}

function clearChat() { document.getElementById('messages').textContent = ''; }

function exportChat() {
  // Markdown export of the active conversation (existing behaviour).
  window.open('/api/export?token=' + encodeURIComponent(webToken()), '_blank');
}

function exportConversationJson(convId, name) {
  // Round-trippable JSON bundle for moving a conversation between instances.
  var safe = (name || convId).replace(/[^a-z0-9-]/gi, '_');
  window.open('/api/conversations/' + encodeURIComponent(convId) + '/export.json?token=' + encodeURIComponent(webToken()), '_blank');
  void safe;
}

function openImportDialog() {
  var input = document.getElementById('import-file-input');
  if (!input) return;
  input.value = '';
  input.onchange = function() {
    var file = input.files && input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function() {
      try {
        var bundle = JSON.parse(String(reader.result));
        fetch('/api/conversations/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bundle),
        }).then(function(r) {
          if (!r.ok) return r.json().then(function(j) { throw new Error(j.error || 'Import failed'); });
          return r.json();
        }).then(function(result) {
          if (result && result.conversation) {
            // Switch to the imported conversation
            fetch('/api/conversations/select', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: result.conversation.id, viewer: myName(), token: webToken() }),
            });
          }
        }).catch(function(err) {
          alert('Import failed: ' + err.message);
        });
      } catch (err) {
        alert('Could not parse file: ' + err.message);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

// --- The Settings modal (redesign lane 3) ---
// One place for preferences, reached from your menu: your name and colour,
// the theme, sounds (on or off, the sound, per agent), the turn limit,
// roles, the web token with sign out, and Clear view. It replaces the
// settings cog, the sound toggle and the turn limit that sat in the
// sidebar. A dialog: focus stays inside while it is open (Tab wraps),
// Escape or Done closes it and focus returns to what opened it.
var settingsOverlay = null;
var settingsOpener = null;

// Kept under the old names for anything that still calls them.
function openSoundSettings() { openSettingsModal('sounds'); }
function openSettings(evt, section) { if (evt && evt.stopPropagation) evt.stopPropagation(); openSettingsModal(section === 'roles' ? 'roles' : section === 'sounds' ? 'sounds' : section === 'snippets' ? 'snippets' : null); }

function settingsSection(id, title) {
  var sec = document.createElement('section');
  sec.className = 'settings-section';
  sec.id = 'settings-' + id;
  sec.setAttribute('aria-labelledby', 'settings-' + id + '-title');
  var h = document.createElement('h3');
  h.className = 'settings-section-title';
  h.id = 'settings-' + id + '-title';
  h.textContent = title;
  sec.appendChild(h);
  return sec;
}

// One row: name and hint on the left, the control on the right. The
// control is labelled by the row's name.
function settingsRow(name, hint, control, controlId) {
  var row = document.createElement('div');
  row.className = 'setting-row';
  var text = document.createElement('div');
  text.className = 'setting-text';
  var n = document.createElement(controlId ? 'label' : 'span');
  n.className = 'setting-name';
  n.textContent = name;
  if (controlId) n.htmlFor = controlId;
  text.appendChild(n);
  if (hint) {
    var h = document.createElement('span');
    h.className = 'setting-hint';
    h.textContent = hint;
    text.appendChild(h);
  }
  row.appendChild(text);
  var wrap = document.createElement('div');
  wrap.className = 'setting-control';
  if (control) wrap.appendChild(control);
  row.appendChild(wrap);
  return { row: row, control: wrap, hint: text };
}

function settingsSwitch(id, checked, onChange) {
  var label = document.createElement('label');
  label.className = 'toggle-switch';
  var input = document.createElement('input');
  input.type = 'checkbox';
  input.id = id;
  input.checked = !!checked;
  input.addEventListener('change', function() { onChange(input.checked); });
  var slider = document.createElement('span');
  slider.className = 'toggle-slider';
  label.appendChild(input);
  label.appendChild(slider);
  return label;
}

function soundSelect(id, value, withGlobal, onChange) {
  var sel = document.createElement('select');
  sel.className = 'setting-select';
  if (id) sel.id = id;
  if (withGlobal) {
    var def = document.createElement('option');
    def.value = '';
    def.textContent = '(global)';
    sel.appendChild(def);
  }
  SOUNDS.forEach(function(s) {
    var opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    sel.appendChild(opt);
  });
  sel.value = value || '';
  sel.addEventListener('change', function() { onChange(sel.value); });
  return sel;
}

function previewSound() {
  var wasMuted = isMuted;
  isMuted = false;
  playSound('_preview');
  isMuted = wasMuted;
}

function buildProfileSection() {
  var sec = settingsSection('profile', 'Profile');
  var nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.id = 'settings-name';
  nameInput.className = 'setting-input';
  nameInput.value = myName();
  nameInput.maxLength = 64;
  nameInput.spellcheck = false;
  function applyName() {
    var v = nameInput.value.trim();
    if (!v || v === myName()) { nameInput.value = myName(); return; }
    if (setMyName) setMyName(v);
  }
  nameInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); applyName(); } });
  nameInput.addEventListener('change', applyName);
  sec.appendChild(settingsRow('Display name', 'How the crew sees you in this room', nameInput, 'settings-name').row);

  var colors = document.createElement('div');
  colors.className = 'settings-colors';
  colors.setAttribute('role', 'group');
  colors.setAttribute('aria-label', 'Your colour');
  var mine = getSenderColor(myName());
  YOU_COLORS.forEach(function(c) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'settings-color';
    b.style.background = c;
    b.title = c;
    b.setAttribute('aria-label', 'Colour ' + c);
    b.setAttribute('aria-pressed', mine === c ? 'true' : 'false');
    b.addEventListener('click', function() {
      setMyColor(c);
      colors.querySelectorAll('.settings-color').forEach(function(o) { o.setAttribute('aria-pressed', o === b ? 'true' : 'false'); });
    });
    colors.appendChild(b);
  });
  sec.appendChild(settingsRow('Colour', 'Your name and avatar', colors).row);
  return sec;
}

function buildAppearanceSection() {
  var sec = settingsSection('appearance', 'Appearance');
  var seg = document.createElement('div');
  seg.className = 'seg';
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Theme');
  [['dark', 'Dark'], ['light', 'Light']].forEach(function(t) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = t[1];
    b.setAttribute('data-theme-choice', t[0]);
    b.setAttribute('aria-pressed', currentTheme() === t[0] ? 'true' : 'false');
    b.addEventListener('click', function() { setTheme(t[0]); });
    seg.appendChild(b);
  });
  sec.appendChild(settingsRow('Theme', 'Kept for this browser', seg).row);
  return sec;
}

function buildSoundsSection() {
  var sec = settingsSection('sounds', 'Sounds');
  sec.appendChild(settingsRow('Play sounds', 'Chimes on new messages and mentions', settingsSwitch('settings-sound-on', !isMuted, function(on) {
    isMuted = !on;
    localStorage.setItem('joind-muted', JSON.stringify(isMuted));
    updateMuteBtn();
  }), 'settings-sound-on').row);
  var global = soundSelect('settings-sound', soundSettings._global, false, function(v) {
    soundSettings._global = v;
    saveSoundSettings();
    previewSound();
  });
  var preview = document.createElement('button');
  preview.type = 'button';
  preview.className = 'btn btn-sm';
  preview.textContent = 'Preview';
  preview.addEventListener('click', previewSound);
  var both = document.createElement('div');
  both.className = 'setting-control';
  both.appendChild(global);
  both.appendChild(preview);
  sec.appendChild(settingsRow('Sound', 'The default for every agent', both, 'settings-sound').row);
  // The room's agents change while the modal is open (joins, leaves,
  // renames): this part is re-rendered from renderPills.
  var perAgent = document.createElement('div');
  perAgent.id = 'settings-agent-sounds';
  renderAgentSoundsInto(perAgent);
  sec.appendChild(perAgent);
  return sec;
}

function renderAgentSoundsInto(wrap) {
  wrap.textContent = '';
  if (agents.length === 0) return;
  wrap.appendChild(settingsRow('Per agent', 'Overrides for the agents in this room', null).row);
  var grid = document.createElement('div');
  grid.className = 'settings-agent-sounds';
  agents.forEach(function(a, i) {
    var id = 'settings-agent-sound-' + i;
    var lbl = document.createElement('label');
    lbl.className = 'settings-agent-name';
    lbl.htmlFor = id;
    lbl.textContent = a.name;
    lbl.title = a.name;
    lbl.style.color = getSenderColor(a.name);
    // Each choice is saved as it is made, so a re-render loses nothing.
    var sel = soundSelect(id, soundSettings[a.name] || '', true, function(v) {
      if (v === '') delete soundSettings[a.name];
      else soundSettings[a.name] = v;
      saveSoundSettings();
    });
    sel.setAttribute('data-agent', a.name);
    grid.appendChild(lbl);
    grid.appendChild(sel);
  });
  wrap.appendChild(grid);
}

// Re-render a part of the open Settings modal now, or, while focus is
// inside it (someone is choosing or typing), as soon as focus leaves it.
// One pending refresh per part; it runs only if the part is still shown.
function refreshSettingsPart(el, render) {
  if (!el || !el.isConnected) return;
  if (!el.contains(document.activeElement)) { render(el); return; }
  if (el.getAttribute('data-refresh-pending') === 'yes') return;
  el.setAttribute('data-refresh-pending', 'yes');
  el.addEventListener('focusout', function onOut(e) {
    if (e.relatedTarget && el.contains(e.relatedTarget)) return; // focus moved within
    el.removeEventListener('focusout', onOut);
    // After the focus move finishes: re-rendering inside focusout would
    // remove the element the browser is still blurring.
    setTimeout(function() {
      el.removeAttribute('data-refresh-pending');
      if (!el.isConnected) return;
      if (el.contains(document.activeElement)) { refreshSettingsPart(el, render); return; } // focus came back in
      render(el);
    }, 0);
  });
}

function buildAgentsSection() {
  var sec = settingsSection('turns', 'Agents');
  var sw = settingsSwitch('turn-guard-toggle', turnGuardState.enabled, function(on) { toggleTurnGuard(on); });
  var num = document.createElement('input');
  num.type = 'number';
  num.id = 'turn-guard-limit';
  num.className = 'setting-input narrow';
  num.min = '1';
  num.max = '100';
  num.value = String(turnGuardState.limit);
  num.disabled = !turnGuardState.enabled;
  num.setAttribute('aria-label', 'Max agent turns');
  num.addEventListener('change', function() { setTurnGuardLimit(num.value); });
  var both = document.createElement('div');
  both.className = 'setting-control';
  both.appendChild(sw);
  both.appendChild(num);
  sec.appendChild(settingsRow('Turn limit', 'Consecutive agent turns before a human must answer', both, 'turn-guard-toggle').row);
  return sec;
}

function renderRolesInto(sec) {
  // Whatever is typed in the add form survives a re-render.
  var keepEmoji = sec.querySelector('input[placeholder="emoji"]');
  var keepLabel = document.getElementById('settings-role-label');
  var typedEmoji = keepEmoji ? keepEmoji.value : '';
  var typedLabel = keepLabel && sec.contains(keepLabel) ? keepLabel.value : '';
  while (sec.children.length > 1) sec.removeChild(sec.lastChild);
  var presetRow = settingsRow('Presets', 'Built in', null);
  sec.appendChild(presetRow.row);
  var presets = document.createElement('div');
  presets.className = 'settings-roles';
  (availableRoles.preset || []).forEach(function(r) {
    var chip = document.createElement('span');
    chip.className = 'settings-role';
    chip.textContent = (r.emoji || '') + ' ' + r.label;
    presets.appendChild(chip);
  });
  sec.appendChild(presets);
  sec.appendChild(settingsRow('Custom', 'Yours, shared by this Joind', null).row);
  var custom = document.createElement('div');
  custom.className = 'settings-roles';
  (availableRoles.custom || []).forEach(function(r) {
    var chip = document.createElement('span');
    chip.className = 'settings-role';
    var label = document.createElement('span');
    label.textContent = (r.emoji || '') + ' ' + r.label;
    var del = document.createElement('button');
    del.type = 'button';
    del.textContent = '×';
    del.title = 'Delete custom role';
    del.setAttribute('aria-label', 'Delete role ' + r.label);
    del.addEventListener('click', function() {
      fetch('/api/roles/' + encodeURIComponent(r.label), { method: 'DELETE' }).then(function(resp) {
        if (!resp.ok) return;
        availableRoles.custom = (availableRoles.custom || []).filter(function(x) { return x.label !== r.label; });
        renderRolesInto(sec);
        var add = document.getElementById('settings-role-label');
        if (add) add.focus();
      });
    });
    chip.appendChild(label);
    chip.appendChild(del);
    custom.appendChild(chip);
  });
  if (!custom.firstChild) {
    var none = document.createElement('span');
    none.className = 'setting-hint';
    none.textContent = 'None yet';
    custom.appendChild(none);
  }
  sec.appendChild(custom);
  var emoji = document.createElement('input');
  emoji.type = 'text';
  emoji.className = 'setting-input narrow';
  emoji.placeholder = 'emoji';
  emoji.maxLength = 4;
  emoji.setAttribute('aria-label', 'Role emoji');
  emoji.value = typedEmoji;
  var label = document.createElement('input');
  label.type = 'text';
  label.id = 'settings-role-label';
  label.className = 'setting-input';
  label.placeholder = 'role name';
  label.value = typedLabel;
  var add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn btn-sm';
  add.textContent = 'Add';
  var status = document.createElement('span');
  status.className = 'setting-hint';
  status.setAttribute('role', 'status');
  function submit() {
    var em = emoji.value.trim();
    var lb = label.value.trim();
    if (!em || !lb) return;
    status.textContent = '';
    fetch('/api/roles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emoji: em, label: lb }) })
      .then(function(resp) {
        return resp.json().catch(function() { return {}; }).then(function(d) {
          if (!resp.ok) { status.textContent = resp.status === 409 ? 'That role already exists' : (d && d.error) || 'Could not add the role'; return; }
          // The server cleans the label (lower case, hyphens): keep its role.
          var role = d && d.role && d.role.label ? d.role : { emoji: em, label: lb };
          if (!(availableRoles.custom || []).some(function(x) { return x.label === role.label; })) {
            availableRoles.custom = (availableRoles.custom || []).concat([role]);
          }
          emoji.value = '';
          label.value = '';
          renderRolesInto(sec);
          var again = document.getElementById('settings-role-label');
          if (again) again.focus();
        });
      })
      .catch(function() { status.textContent = 'Could not add the role'; });
  }
  add.addEventListener('click', submit);
  label.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  var form = document.createElement('div');
  form.className = 'setting-control';
  form.appendChild(emoji);
  form.appendChild(label);
  form.appendChild(add);
  form.appendChild(status);
  sec.appendChild(settingsRow('Add a role', '', form, 'settings-role-label').row);
}

function buildRolesSection() {
  var sec = settingsSection('roles', 'Roles');
  renderRolesInto(sec);
  return sec;
}

function buildTokenSection() {
  var sec = settingsSection('token', 'Web token');
  var src = tokenSource();
  var hint = src === 'served' ? 'Served by this Joind to the page; it gates direct messages'
    : src === 'tab' ? 'Entered for this tab session only; it gates direct messages'
    : 'Not set: direct messages stay closed';
  var value = document.createElement('span');
  value.className = 'setting-mono';
  value.textContent = maskedToken();
  var both = document.createElement('div');
  both.className = 'setting-control';
  both.appendChild(value);
  if (src !== 'served') {
    var change = document.createElement('button');
    change.type = 'button';
    change.className = 'btn btn-sm';
    change.id = 'settings-token-change';
    change.textContent = src === 'tab' ? 'Change' : 'Enter token';
    change.addEventListener('click', function() {
      closeSettingsModal(false);
      promptWebToken(function() { location.reload(); });
    });
    both.appendChild(change);
  }
  sec.appendChild(settingsRow('Token', hint, both).row);
  var out = document.createElement('button');
  out.type = 'button';
  out.className = 'btn btn-sm btn-danger-outline';
  out.id = 'settings-sign-out';
  out.textContent = 'Sign out';
  out.addEventListener('click', function() {
    if (out.getAttribute('data-confirm') === 'yes') { signOut(); return; }
    out.setAttribute('data-confirm', 'yes');
    out.textContent = 'Press again to sign out';
  });
  sec.appendChild(settingsRow('Sign out', 'Clears the token from this tab and closes the connection', out).row);
  return sec;
}

function buildViewSection() {
  var sec = settingsSection('view', 'View');
  var clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'btn btn-sm';
  clear.textContent = 'Clear view';
  clear.addEventListener('click', function() { clearChat(); closeSettingsModal(true); });
  sec.appendChild(settingsRow('Clear view', 'Hides the messages on this page until you reload; nothing is deleted', clear).row);
  return sec;
}

function settingsFocusables() {
  if (!settingsOverlay) return [];
  return Array.prototype.slice.call(settingsOverlay.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter(function(el) { return !el.disabled && el.offsetParent !== null; });
}

function openSettingsModal(section, opener) {
  closePopover();
  if (settingsOverlay) closeSettingsModal(false);
  var from = opener || document.activeElement;
  settingsOpener = from && from !== document.body ? from : document.getElementById('you-pill');
  var overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  overlay.id = 'settings-overlay';
  overlay.addEventListener('mousedown', function(e) { if (e.target === overlay) closeSettingsModal(true); });
  overlay.addEventListener('click', function(e) { e.stopPropagation(); });
  var modal = document.createElement('div');
  modal.className = 'settings-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'settings-title');

  var head = document.createElement('div');
  head.className = 'settings-head';
  var title = document.createElement('h2');
  title.className = 'settings-title';
  title.id = 'settings-title';
  title.textContent = 'Settings';
  var x = document.createElement('button');
  x.type = 'button';
  x.className = 'tbtn';
  x.setAttribute('aria-label', 'Close settings');
  x.title = 'Close';
  var xi = document.createElement('i');
  xi.setAttribute('data-lucide', 'x');
  xi.setAttribute('width', '16');
  xi.setAttribute('height', '16');
  x.appendChild(xi);
  x.addEventListener('click', function() { closeSettingsModal(true); });
  head.appendChild(title);
  head.appendChild(x);

  var body = document.createElement('div');
  body.className = 'settings-body';
  [buildProfileSection(), buildAppearanceSection(), buildSoundsSection(), buildAgentsSection(), buildRolesSection(), buildSnippetsSection(), buildTokenSection(), buildViewSection()]
    .forEach(function(s) { body.appendChild(s); });

  var foot = document.createElement('div');
  foot.className = 'settings-foot';
  var done = document.createElement('button');
  done.type = 'button';
  done.className = 'btn btn-primary';
  done.textContent = 'Done';
  done.addEventListener('click', function() { closeSettingsModal(true); });
  foot.appendChild(done);

  modal.appendChild(head);
  modal.appendChild(body);
  modal.appendChild(foot);
  overlay.appendChild(modal);

  overlay.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeSettingsModal(true);
      return;
    }
    if (e.key !== 'Tab') return;
    var f = settingsFocusables();
    if (f.length === 0) return;
    var first = f[0];
    var last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  document.body.appendChild(overlay);
  settingsOverlay = overlay;
  if (window.lucide) lucide.createIcons({ root: overlay });
  var target = section ? document.getElementById('settings-' + section) : null;
  if (target) {
    target.scrollIntoView({ block: 'start' });
    target.classList.add('flash');
    var firstControl = target.querySelector('button, input, select');
    (firstControl || done).focus();
  } else {
    document.getElementById('settings-name').focus();
  }
}

// Ctrl+, (Cmd+, on a Mac) opens Settings, as the menu hint says.
document.addEventListener('keydown', function(e) {
  if (e.key !== ',' || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  if (signedOut || settingsOverlay) return;
  // Not while typing: an editable target keeps the key.
  var t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  e.preventDefault();
  openSettingsModal(null, document.activeElement);
});

function closeSettingsModal(returnFocus) {
  if (!settingsOverlay) return;
  settingsOverlay.remove();
  settingsOverlay = null;
  var back = settingsOpener;
  settingsOpener = null;
  if (returnFocus && back && back.isConnected && back.offsetParent !== null) back.focus();
}

// --- @Mention autocomplete ---
function showMentionMenu(query) {
  var menu = document.getElementById('mention-menu');
  var filtered = agents.filter(function(a) {
    return a.name.toLowerCase().indexOf(query.toLowerCase()) === 0;
  });
  if ('all'.indexOf(query.toLowerCase()) === 0) filtered.unshift({ name: 'all', pid: 0 });
  if (filtered.length === 0) { menu.classList.add('hidden'); return; }

  menu.classList.remove('hidden'); menu.textContent = '';
  mentionMenuIndex = 0;

  filtered.forEach(function(a, i) {
    var item = document.createElement('div');
    item.className = 'mention-item' + (i === 0 ? ' active' : '');
    var dot = document.createElement('span');
    dot.className = 'mention-item-dot';
    dot.style.background = getSenderColor(a.name);
    var nm = document.createElement('span');
    nm.className = 'mention-item-name';
    nm.textContent = a.name === 'all' ? '@all (everyone)' : a.name;
    if (a.role) {
      var rl = document.createElement('span');
      rl.className = 'mention-item-role'; rl.textContent = a.role;
      item.appendChild(dot); item.appendChild(nm); item.appendChild(rl);
    } else {
      item.appendChild(dot); item.appendChild(nm);
    }
    item.addEventListener('mousedown', function(e) { e.preventDefault(); selectMention(a.name); });
    menu.appendChild(item);
  });
}

function hideMentionMenu() { document.getElementById('mention-menu').classList.add('hidden'); mentionMenuIndex = -1; }

function selectMention(name) {
  var input = document.getElementById('message-input');
  var cursor = input.selectionStart;
  var val = input.value;
  // Find the @ that triggered the menu (search backwards from cursor)
  var before = val.slice(0, cursor);
  var atPos = before.lastIndexOf('@');
  if (atPos >= 0) {
    var after = val.slice(cursor);
    input.value = before.slice(0, atPos) + '@' + name + ' ' + after;
    var newCursor = atPos + name.length + 2; // after "@name "
    input.setSelectionRange(newCursor, newCursor);
  }
  hideMentionMenu(); input.focus();
  syncHighlight();
}

// --- Input ---
function setupInput() {
  var input = document.getElementById('message-input');
  input.addEventListener('keydown', function(e) {
    var menu = document.getElementById('mention-menu');
    var isOpen = !menu.classList.contains('hidden');
    if (isOpen) {
      var items = menu.querySelectorAll('.mention-item');
      if (e.key === 'ArrowDown') { e.preventDefault(); mentionMenuIndex = Math.min(mentionMenuIndex + 1, items.length - 1); items.forEach(function(it, i) { it.classList.toggle('active', i === mentionMenuIndex); }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); mentionMenuIndex = Math.max(mentionMenuIndex - 1, 0); items.forEach(function(it, i) { it.classList.toggle('active', i === mentionMenuIndex); }); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        var sel = items[mentionMenuIndex];
        if (sel) { var n = sel.querySelector('.mention-item-name').textContent; if (n.startsWith('@all')) n = 'all'; selectMention(n); }
        return;
      }
      if (e.key === 'Escape') { hideMentionMenu(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    else if (e.key.length === 1 || e.key === 'Backspace') showComposerError('');
  });
  input.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    updateSendBtn();
    syncHighlight();
    var before = this.value.slice(0, this.selectionStart);
    var atMatch = before.match(/@(\w*)$/);
    if (atMatch) showMentionMenu(atMatch[1]); else hideMentionMenu();
  });
  input.addEventListener('scroll', syncHighlightScroll);
  input.addEventListener('blur', function() { setTimeout(hideMentionMenu, 150); });

  // Paste handler for images: every image on the clipboard joins the draft.
  input.addEventListener('paste', function(e) {
    var data = e.clipboardData || (e.originalEvent && e.originalEvent.clipboardData);
    var items = data ? data.items : [];
    var files = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file' && items[i].type.indexOf('image/') === 0) {
        var f = items[i].getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length === 0) return;
    e.preventDefault();
    showComposerNote('');
    addImageFiles(files);
  });

  // Drop handler for images on chat area
  var chatArea = document.getElementById('messages');
  chatArea.addEventListener('dragover', function(e) { e.preventDefault(); chatArea.classList.add('drag-over'); });
  chatArea.addEventListener('dragleave', function() { chatArea.classList.remove('drag-over'); });
  chatArea.addEventListener('drop', function(e) { e.preventDefault(); chatArea.classList.remove('drag-over');
    var files = Array.prototype.slice.call(e.dataTransfer.files || []);
    if (files.length === 0) return;
    addImageFiles(files.filter(function(f) { return /^image\//.test(f.type); }));
    addFiles(files.filter(function(f) { return !/^image\//.test(f.type); }));
  });
}

function resolveMentionColor(name) {
  var lower = name.toLowerCase();
  if (!lower) return null;
  if ('all'.indexOf(lower) === 0) return getSenderColor('all');

  var exact = agents.find(function(agent) {
    return agent.name.toLowerCase() === lower;
  });
  if (exact) return getSenderColor(exact.name);

  var matches = agents.filter(function(agent) {
    return agent.name.toLowerCase().indexOf(lower) === 0;
  });
  if (matches.length === 1) return getSenderColor(matches[0].name);

  return null;
}

// Overlay-based mention coloring was removed (caused caret/letter drift on
// fractional-pixel DPRs and required a focus background that greyed the text).
// Mentions are still colored in rendered messages; the input itself is plain.
function syncHighlight() {}
function syncHighlightScroll() {}

function updateSendBtn() {
  var empty = !document.getElementById('message-input').value.trim() && pendingImages.length === 0;
  document.getElementById('send-btn').classList.toggle('inactive', empty || imageUploadsInFlight > 0);
}

// --- Terminal scanner ---
var autoScanInterval = null;
var autoScanRunning = false;

function scanTerminals() {
  var btn = document.getElementById('scan-btn');
  btn.textContent = '...'; btn.disabled = true;
  fetch('/api/terminals').then(function(r) { return r.json(); }).then(function(t) {
    lastScanResults = t;
    renderTerminals(t); btn.textContent = 'Scan'; btn.disabled = false;
    // Start auto-scan after first manual scan
    if (!autoScanInterval) startAutoScan();
  }).catch(function() { lastScanResults = []; renderTerminals([]); btn.textContent = 'Scan'; btn.disabled = false; });
}

function startAutoScan() {
  if (autoScanInterval) return;
  autoScanInterval = setInterval(autoScanTerminals, 15000);
}

function autoScanTerminals() {
  if (autoScanRunning || signedOut) return;
  autoScanRunning = true;
  fetch('/api/terminals').then(function(r) { return r.json(); }).then(function(t) {
    autoScanRunning = false;
    if (signedOut) return;
    // Only re-render if something changed (compare by pid+paneId+tabTitle fingerprint)
    var oldFp = lastScanResults.map(function(x) { return x.pid + ':' + (x.weztermGui || '') + ':' + (x.weztermPaneId || '') + ':' + (x.tabTitle || ''); }).sort().join('|');
    var newFp = t.map(function(x) { return x.pid + ':' + (x.weztermGui || '') + ':' + (x.weztermPaneId || '') + ':' + (x.tabTitle || ''); }).sort().join('|');
    if (oldFp !== newFp) {
      lastScanResults = t;
      renderTerminals(t);
    }
  }).catch(function() { autoScanRunning = false; });
}

function renderTerminals(terminals) {
  var list = document.getElementById('terminal-list');
  list.textContent = '';
  if (terminals.length === 0) {
    var e = document.createElement('li'); e.className = 'empty-state'; e.textContent = 'No agents found';
    list.appendChild(e); return;
  }
  // Filter out WezTerm panes — only show PID-based entries
  var filtered = terminals.filter(function(t) { return t.pid > 0; });
  if (filtered.length === 0) {
    var e2 = document.createElement('li'); e2.className = 'empty-state'; e2.textContent = 'No agents found';
    list.appendChild(e2); return;
  }
  filtered.forEach(function(t) {
    var li = document.createElement('li'); li.className = 'terminal-item';
    var type = document.createElement('span'); type.className = 'terminal-type ' + t.type; type.textContent = t.type;
    var info = document.createElement('div'); info.className = 'terminal-info';
    var joinedAgent = agents.find(function(a) { return t.pid && a.pid === t.pid; });
    var displayTitle = t.tabTitle || (joinedAgent ? joinedAgent.name : null);
    if (displayTitle) {
      var title = document.createElement('span'); title.className = 'terminal-tab-title'; title.textContent = displayTitle;
      info.appendChild(title);
    }
    var pid = document.createElement('span'); pid.className = 'terminal-pid'; pid.textContent = 'PID ' + t.pid;
    info.appendChild(pid);
    var joined = !!joinedAgent;
    var inv = document.createElement('button'); inv.className = 'terminal-invite';
    inv.textContent = joined ? 'Dismiss' : 'Invite';
    inv.classList.toggle('joined', joined);
    inv.addEventListener('click', function() {
      if (joined) { kickAgent(joinedAgent.name); }
      else { inviteTerminal(t); }
    });
    li.appendChild(type); li.appendChild(info); li.appendChild(inv); list.appendChild(li);
  });
  if (typeof renderCrewPage === 'function') renderCrewPage();
  if (typeof refreshSenderTags === 'function') refreshSenderTags();
}

function inviteTerminal(t) {
  var defaultName = t.tabTitle || t.type;
  customPrompt('Name for this ' + t.type + ' agent:', defaultName, function(name) {
    if (!name) return;
    var payload = { name: name, pid: t.pid };
    if (t.wtSession) payload.wtSession = t.wtSession;
    // The pane travels with the GUI its scan found it in; the server binds the pair or nothing.
    if (t.weztermPaneId != null && t.weztermGui != null) { payload.weztermPaneId = t.weztermPaneId; payload.weztermGui = t.weztermGui; }
    fetch('/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  });
}

function kickAgent(name) {
  // Only the selected conversation's member leaves; the same name elsewhere is another registration.
  var leaveBody = { name: name };
  if (activeConversation && activeConversation.id) leaveBody.conversation = activeConversation.id;
  fetch('/api/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(leaveBody) });
}

// --- Sidebar toggle (desktop: show/hide, mobile: drawer overlay) ---
function isMobileView() { return window.innerWidth <= 560; }

// --- Resizable sidebar (desktop only) ---
// A seam on the sidebar's right edge. Width = pointer x minus the sidebar's
// own left edge (the rail sits before it), applied on every pointermove and clamped; saved
// once on pointerup. Arrow keys on the focused seam step 16 px. Below the
// mobile breakpoint the sidebar is a drawer and the saved width is not applied.
// Dragging the seam below SIDEBAR_COLLAPSE_AT (40 px under the minimum)
// dims the sidebar with a hint, and releasing there collapses it, exactly as
// the toggle button does; the saved width is untouched, so expanding again
// restores it.
var SIDEBAR_MIN = 180;
var SIDEBAR_COLLAPSE_AT = 140;
var SIDEBAR_MAX = 480;
var SIDEBAR_STEP = 16;
var SIDEBAR_WIDTH_KEY = 'joind-sidebar-width';
// This page's width when storage is unavailable (private window, blocked site data).
var sidebarWidthMem = null;

function readSidebarWidth() {
  if (sidebarWidthMem !== null) return sidebarWidthMem;
  try {
    var raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    var v = raw === null ? NaN : Number(raw);
    // Kept in memory once read, so a later storage failure still has it.
    if (Number.isFinite(v) && v > 0) { sidebarWidthMem = clampSidebarWidth(v); return sidebarWidthMem; }
  } catch (e) { /* storage unavailable */ }
  return sidebarWidthMem;
}

function saveSidebarWidth(w) {
  sidebarWidthMem = clampSidebarWidth(w);
  try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(w))); } catch (e) { /* storage unavailable: the width holds for this page only */ }
}

function clampSidebarWidth(w) {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(w)));
}

function setSidebarWidth(w) {
  var sb = document.getElementById('sidebar');
  if (!sb) return;
  var seam = document.getElementById('sidebar-seam');
  if (w === null || isMobileView()) {
    sb.style.width = '';
    sb.style.minWidth = '';
    if (seam) seam.removeAttribute('aria-valuenow');
    return;
  }
  var cw = clampSidebarWidth(w);
  sb.style.width = cw + 'px';
  sb.style.minWidth = cw + 'px';
  if (seam) seam.setAttribute('aria-valuenow', String(cw));
}

function currentSidebarWidth() {
  var sb = document.getElementById('sidebar');
  return sb ? sb.getBoundingClientRect().width : SIDEBAR_MIN;
}

function initSidebarResize() {
  var sb = document.getElementById('sidebar');
  var seam = document.getElementById('sidebar-seam');
  var app = document.querySelector('.app');
  if (!sb || !seam || !app) return;
  setSidebarWidth(readSidebarWidth());
  var dragging = false;
  var lastWidth = null;
  var willCollapse = false;
  seam.addEventListener('pointerdown', function(e) {
    if (isMobileView() || sb.classList.contains('hidden') || e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    lastWidth = null;
    willCollapse = false;
    try { seam.setPointerCapture(e.pointerId); } catch (err) { /* capture unsupported: moves still arrive while over the seam */ }
    seam.classList.add('dragging');
    document.body.classList.add('sidebar-resizing');
  });
  seam.addEventListener('pointermove', function(e) {
    if (!dragging) return;
    var out = window.joindUi
      ? window.joindUi.sidebarDragOutcome(e.clientX - sb.getBoundingClientRect().left, SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_COLLAPSE_AT)
      : { width: clampSidebarWidth(e.clientX - sb.getBoundingClientRect().left), collapse: false };
    willCollapse = out.collapse;
    sb.classList.toggle('will-collapse', willCollapse);
    // Below the threshold the release collapses, so no width is kept from it.
    lastWidth = willCollapse ? null : out.width;
    setSidebarWidth(out.width);
  });
  // Only a release (pointerup) below the threshold collapses; a cancelled
  // or lost drag there puts the saved width back instead.
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    try { seam.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    seam.classList.remove('dragging');
    document.body.classList.remove('sidebar-resizing');
    sb.classList.remove('will-collapse');
    if (willCollapse) {
      willCollapse = false;
      setSidebarWidth(readSidebarWidth());
      if (e.type === 'pointerup') setSidebarHidden(true);
      return;
    }
    if (lastWidth !== null) saveSidebarWidth(lastWidth);
  }
  seam.addEventListener('pointerup', endDrag);
  seam.addEventListener('pointercancel', endDrag);
  seam.addEventListener('lostpointercapture', endDrag);
  seam.addEventListener('keydown', function(e) {
    if (isMobileView() || sb.classList.contains('hidden')) return;
    var delta = e.key === 'ArrowLeft' ? -SIDEBAR_STEP : e.key === 'ArrowRight' ? SIDEBAR_STEP : 0;
    if (!delta) return;
    e.preventDefault();
    var w = clampSidebarWidth(currentSidebarWidth() + delta);
    setSidebarWidth(w);
    saveSidebarWidth(w);
  });
  // Crossing the mobile breakpoint: the drawer takes its own width; back on
  // desktop the saved width returns.
  var wasMobile = isMobileView();
  window.addEventListener('resize', function() {
    var nowMobile = isMobileView();
    if (nowMobile === wasMobile) return;
    wasMobile = nowMobile;
    setSidebarWidth(nowMobile ? null : readSidebarWidth());
  });
}

function toggleSidebar() {
  var sb = document.getElementById('sidebar');
  if (isMobileView()) {
    // Mobile: toggle drawer overlay
    var isOpen = sb.classList.contains('mobile-open');
    if (isOpen) {
      closeMobileDrawer();
    } else {
      openMobileDrawer();
    }
  } else {
    // Desktop: toggle hidden
    setSidebarHidden(!sb.classList.contains('hidden'));
  }
}

// Desktop collapse, shared by the toggle button and the drag-to-collapse
// seam, persisted under the same key. Focus left inside a sidebar that
// disappears moves to the toggle, which brings it back.
function setSidebarHidden(hidden) {
  var sb = document.getElementById('sidebar');
  if (!sb) return;
  var hadFocus = hidden && sb.contains(document.activeElement);
  sb.classList.toggle('hidden', hidden);
  try { localStorage.setItem('joind-sidebar', hidden ? 'hidden' : 'visible'); } catch (e) { /* storage unavailable */ }
  if (hadFocus) {
    var toggle = document.getElementById('sidebar-toggle');
    if (toggle) toggle.focus();
  }
}

function openMobileDrawer() {
  var sb = document.getElementById('sidebar');
  sb.classList.remove('hidden');
  sb.classList.add('mobile-open');
  // Create/show backdrop
  var backdrop = document.getElementById('sidebar-backdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'sidebar-backdrop';
    backdrop.className = 'sidebar-backdrop';
    backdrop.addEventListener('click', closeMobileDrawer);
    document.body.appendChild(backdrop);
  }
  // Force reflow before adding visible class for transition
  void backdrop.offsetWidth;
  backdrop.classList.add('visible');
}

function closeMobileDrawer() {
  var sb = document.getElementById('sidebar');
  sb.classList.remove('mobile-open');
  var backdrop = document.getElementById('sidebar-backdrop');
  if (backdrop) backdrop.classList.remove('visible');
}

function toggleSection(header) {
  var collapsed = !header.classList.contains('collapsed');
  setSectionCollapsed(header, collapsed);
  saveCollapsed(header.getAttribute('data-sec'), collapsed);
}

// --- The rail (redesign lane 2) ---
// Rooms, DMs and Crew switch what the sidebar shows (each section lists its
// views in data-views); Decisions, Tasks, Search and Activity open their
// panels and show as pressed while open. The view is remembered per
// browser. At phone width the rail is the bottom tab bar and a view opens
// the sidebar drawer.
var RAIL_VIEW_KEY = 'joind-rail-view';
var RAIL_TITLES = { rooms: 'Rooms', dms: 'Direct messages', crew: 'Crew', decisions: 'Decisions', tasks: 'Tasks' };
var railViewNow = 'rooms';

function readRailView() {
  var v = null;
  try { v = localStorage.getItem(RAIL_VIEW_KEY); } catch (e) { /* storage unavailable */ }
  return window.joindUi ? window.joindUi.railView(v) : 'rooms';
}

function setRailView(view, fromUser) {
  var v = window.joindUi ? window.joindUi.railView(view) : 'rooms';
  railViewNow = v;
  var sb = document.getElementById('sidebar');
  if (sb) sb.setAttribute('data-view', v);
  document.querySelectorAll('.sidebar-section[data-views]').forEach(function(sec) {
    var show = window.joindUi ? window.joindUi.sectionInView(sec.getAttribute('data-views'), v) : true;
    // Focus inside a section that is going away moves to the rail item.
    if (!show && sec.contains(document.activeElement)) {
      var item = document.querySelector('.rail-item[data-rail-view="' + v + '"]');
      if (item) item.focus();
    }
    sec.hidden = !show;
  });
  var title = document.getElementById('side-title');
  if (title) title.textContent = RAIL_TITLES[v];
  // The head action, as in A: a new room, or launching an agent from Crew.
  var act = document.getElementById('side-head-action');
  if (act) {
    var label = v === 'rooms' ? 'New room' : v === 'crew' ? 'Launch an agent' : '';
    act.hidden = !label;
    act.title = label;
    act.setAttribute('aria-label', label || 'New');
  }
  // Crew is a page in the content column; Rooms and DMs show the conversation.
  showPage(PAGES.indexOf(v) >= 0 ? v : null);
  document.querySelectorAll('.rail-item[data-rail-view]').forEach(function(btn) {
    var on = btn.getAttribute('data-rail-view') === v;
    btn.classList.toggle('active', on);
    if (on) btn.setAttribute('aria-current', 'true'); else btn.removeAttribute('aria-current');
  });
  if (fromUser) {
    try { localStorage.setItem(RAIL_VIEW_KEY, v); } catch (e) { /* storage unavailable: the view holds for this page */ }
    // Decisions carries its views on the page, so a phone opens no drawer.
    if (isMobileView() && v !== 'decisions' && v !== 'tasks') {
      openMobileDrawer();
    } else if (sb && sb.classList.contains('hidden')) {
      setSidebarHidden(false);
    }
  }
}

// Panels opened from the rail show as pressed while open.
function syncRailPanels() {
  var searchBar = document.getElementById('search-bar');
  var states = [
    ['decisions-btn', typeof decisionsPanelOpen !== 'undefined' && decisionsPanelOpen],
    ['notify-btn', typeof notifyPanelOpen !== 'undefined' && notifyPanelOpen],
    ['task-badge', typeof taskPanelOpen !== 'undefined' && taskPanelOpen],
    ['rail-search', !!searchBar && !searchBar.classList.contains('hidden')],
  ];
  states.forEach(function(s) {
    var el = document.getElementById(s[0]);
    if (!el) return;
    el.classList.toggle('open', !!s[1]);
    if (el.hasAttribute('aria-expanded')) el.setAttribute('aria-expanded', s[1] ? 'true' : 'false');
  });
}

// The DMs item carries the total of unread direct messages.
function renderRailDmBadge() {
  var badge = document.getElementById('rail-dm-badge');
  if (!badge) return;
  var total = 0;
  Object.keys(dmUnread).forEach(function(k) { total += dmUnread[k] || 0; });
  badge.textContent = total > 99 ? '99+' : String(total);
  badge.hidden = total === 0;
  var btn = document.getElementById('rail-dms');
  if (btn) btn.setAttribute('aria-label', total > 0 ? 'Direct messages, ' + total + ' unread' : 'Direct messages');
}

function initRail() {
  var act = document.getElementById('side-head-action');
  if (act) act.addEventListener('click', function(e) {
    e.stopPropagation();
    if (railViewNow === 'crew') openLaunchDialog(); else newConversation();
  });
  document.querySelectorAll('.rail-item[data-rail-view]').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      setRailView(btn.getAttribute('data-rail-view'), true);
    });
  });
  setRailView(readRailView(), false);
  syncRailPanels();
  renderRailDmBadge();
  // The instance name titles the rail brand as well as the sidebar head.
  var brand = document.getElementById('rail-brand');
  var inst = document.getElementById('instance-name');
  if (brand && inst) brand.title = inst.textContent;
}

// --- Fidelity to mockup A (redesign lane 3b) ---

// Presence in one vocabulary for every avatar (DM rows, crew rows and
// cards, the members panel): the dot class and a short state.
//   online  green   active (or seen a while ago)
//   working accent  a turn is running (typing)
//   idle    orange  presence lost (the server marked it stale)
//   silent  gray    connected but quiet for 30 minutes
//   offline gray    not connected; age of its last post when known
function presenceOf(name, nowMs) {
  var now = nowMs || serverNow();
  var a = null;
  for (var i = 0; i < agents.length; i++) { if (agents[i].name === name) { a = agents[i]; break; } }
  if (!a) {
    var lastAt = null;
    for (var j = allMessages.length - 1; j >= 0; j--) {
      if (allMessages[j].sender === name && typeof allMessages[j].timestamp === 'number') { lastAt = allMessages[j].timestamp; break; }
    }
    return { cls: 'offline', short: lastAt ? 'offline ' + shortPillAge(Math.max(0, now - lastAt)) : 'offline', agent: null };
  }
  var info = pillInfo(a, now);
  if (typingNames.has(a.name)) return { cls: 'working', short: 'working', agent: a, info: info };
  if (info.presence === 'stale') return { cls: 'idle', short: 'idle' + (info.seenAge != null ? ' ' + shortPillAge(info.seenAge) : ''), agent: a, info: info };
  if (info.presence === 'silent') return { cls: 'silent', short: 'silent ' + shortPillAge(info.quietAge), agent: a, info: info };
  return { cls: 'online', short: info.seenAge != null && info.seenAge >= 60000 ? 'seen ' + shortPillAge(info.seenAge) : 'active', agent: a, info: info };
}

// A square avatar with the presence dot on its corner, as in A.
function presenceAvatar(name, size, cls) {
  var av = memberAvatar(name, size || '');
  var dot = document.createElement('span');
  dot.className = 'mdot ' + cls;
  av.appendChild(dot);
  return av;
}

// The harness a member runs in, as the crew knows it: a Codex queue join,
// the terminal scan by pid, else the crew roster's default harness.
var HARNESS_LABELS = { claude: 'Claude Code', codex: 'Codex CLI', gemini: 'Gemini CLI', openclaw: 'OpenClaw', copilot: 'Copilot CLI' };
var crewRoster = [];
function loadCrewRoster() {
  return fetch('/api/crew').then(function(r) { return r.ok ? r.json() : []; }).then(function(list) {
    crewRoster = Array.isArray(list) ? list : [];
    refreshSenderTags();
    renderPills();
    renderDmList();
  }).catch(function() { /* keep what we have */ });
}
function harnessOf(name) {
  var a = null;
  for (var i = 0; i < agents.length; i++) { if (agents[i].name === name) { a = agents[i]; break; } }
  if (a && a.codexThread) return 'Codex CLI';
  if (a && a.pid) {
    for (var k = 0; k < lastScanResults.length; k++) {
      var t = lastScanResults[k];
      if (t.pid === a.pid && HARNESS_LABELS[t.type]) return HARNESS_LABELS[t.type];
    }
  }
  var lower = String(name || '').toLowerCase();
  for (var j = 0; j < crewRoster.length; j++) {
    var c = crewRoster[j];
    if (String(c.joinAs || '').toLowerCase() === lower || String(c.name || '').toLowerCase() === lower) {
      if (c.defaultHarness) return HARNESS_LABELS[c.defaultHarness] || c.defaultHarness;
    }
  }
  return '';
}

// The tag beside a sender's name: remote: <server> for a hosted member,
// else the harness. Empty for the human and for unknown senders.
function senderTagText(name) {
  var a = null;
  for (var i = 0; i < agents.length; i++) { if (agents[i].name === name) { a = agents[i]; break; } }
  if (a && a.host) return 'remote: ' + a.host;
  return harnessOf(name);
}

// Message headers carry the tag; the roster and the members arrive after
// the first paint, so the tags are refreshed in place.
function refreshSenderTags() {
  document.querySelectorAll('#messages .message[data-sender]').forEach(function(el) {
    var tag = el.querySelector('.msg-tag');
    if (!tag) return;
    var text = senderTagText(el.getAttribute('data-sender'));
    tag.textContent = text;
    tag.hidden = !text;
  });
}

// Whether a message names the viewer: @name as a whole word, or a
// decision asked of the viewer. Not the viewer's own messages.
function mentionsMe(msg) {
  if (!msg || msg.sender === 'system') return false;
  var me = myName();
  if (msg.sender === me) return false;
  if (msg.ask && msg.ask.state === 'open' && msg.ask.for === me) return true;
  return window.joindUi ? window.joindUi.mentionsName(msg.text, me) : false;
}

// --- Rooms: unread and mention counts for rooms not on screen ---
// Counted from the socket since this page loaded (the server keeps read
// cursors for agents only); opening a room clears its counts.
var roomUnread = {};
var roomMentions = {};
function noteRoomMessage(convId, msg) {
  if (!convId || !msg || msg.sender === 'system' || msg.sender === myName() || msg.to) return;
  if (typeof msg.id === 'number' && msg.id < 0) return;
  roomUnread[convId] = (roomUnread[convId] || 0) + 1;
  if (mentionsMe(msg) || (window.joindUi && window.joindUi.mentionsName(msg.text, 'all'))) roomMentions[convId] = (roomMentions[convId] || 0) + 1;
  renderConversationList();
  renderRailRoomsBadge();
}
function clearRoomUnread(convId) {
  delete roomUnread[convId];
  delete roomMentions[convId];
  renderRailRoomsBadge();
}
function renderRailRoomsBadge() {
  refreshPalette();
  var badge = document.getElementById('rail-rooms-badge');
  if (!badge) return;
  var total = 0;
  Object.keys(roomUnread).forEach(function(k) { total += roomUnread[k] || 0; });
  badge.textContent = total > 99 ? '99+' : String(total);
  badge.hidden = total === 0;
  var btn = document.getElementById('rail-rooms');
  if (btn) btn.setAttribute('aria-label', total > 0 ? 'Rooms, ' + total + ' unread' : 'Rooms');
}
// A room row as in A: a glyph (# or the globe for a linked room), the
// name, and the count: mentions (red) first, else unread (soft). The total
// message count moves to the tooltip. Rows are keyboard operable.
function decorateRoomRow(li, conv, remote) {
  var glyph = document.createElement('span');
  glyph.className = 'conv-glyph';
  glyph.setAttribute('aria-hidden', 'true');
  glyph.textContent = remote ? '' : '#';
  if (remote) {
    var gi = document.createElement('i');
    gi.setAttribute('data-lucide', 'globe');
    gi.setAttribute('width', '13');
    gi.setAttribute('height', '13');
    glyph.appendChild(gi);
  }
  li.insertBefore(glyph, li.firstChild);
  var unread = roomUnread[conv.id] || 0;
  var mentions = roomMentions[conv.id] || 0;
  li.classList.toggle('unread', unread > 0);
  var count = li.querySelector('.conv-count');
  if (count) {
    count.textContent = mentions > 0 ? String(mentions) : unread > 0 ? String(unread) : '';
    count.classList.toggle('mention', mentions > 0);
  }
  li.title = conv.name + (conv.messageCount ? ', ' + conv.messageCount + ' messages' : '') +
    (unread > 0 ? ', ' + unread + ' unread' : '') + (mentions > 0 ? ', ' + mentions + ' mentioning you' : '');
  li.tabIndex = 0;
  li.setAttribute('role', 'button');
  if (activeConversation && conv.id === activeConversation.id && !activeDm) li.setAttribute('aria-current', 'true');
  li.addEventListener('keydown', function(e) {
    if (e.target !== li) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectConversation(conv.id); }
  });
}

// --- Pages: Crew takes the content column, as in A ---
var pageNow = null; // 'crew', 'decisions' or null (the conversation)
var PAGES = ['crew', 'decisions', 'tasks'];
function renderPage(page) {
  if (page === 'crew') renderCrewPage();
  else if (page === 'decisions') { renderDecisionsPage(); loadDecisionsPage(); }
  else if (page === 'tasks') { renderBoardSide(); renderBoard(); loadBoard(); }
}
function showPage(p) {
  var page = PAGES.indexOf(p) >= 0 ? p : null;
  if (page === pageNow) { if (page) renderPage(page); return; }
  pageNow = page;
  PAGES.forEach(function(name) {
    var el = document.getElementById('page-' + name);
    if (el) el.hidden = page !== name;
  });
  var chat = document.querySelector('.chat-area');
  if (chat) chat.hidden = !!page;
  document.body.classList.toggle('on-page', !!page);
  if (page) {
    var bar = document.getElementById('search-bar');
    if (bar && !bar.classList.contains('hidden')) closeSearch();
    if (sidePanelTab) closeSidePanel(false);
    renderPage(page);
  }
  syncChannelHeader();
}

// Leaving a page for a conversation (a room, a DM, a jump to a message).
function leavePageFor(view) {
  if (!pageNow) return;
  setRailView(view, false);
  // Remembered like a rail choice, so a reload shows the conversation.
  try { localStorage.setItem(RAIL_VIEW_KEY, railViewNow); } catch (e) { /* storage unavailable */ }
}

function crewMembersList() {
  var m = roomMembers();
  var out = m.infos.map(function(x) { return x.a.name; });
  m.offline.forEach(function(o) { out.push(o.name); });
  return out;
}

// The Crew view's sidebar list: every member with the presence avatar and
// a short state; a connected member opens its popover.
function renderCrewSideList() {
  var list = document.getElementById('crew-side-list');
  if (!list) return;
  list.textContent = '';
  var names = crewMembersList();
  if (names.length === 0) {
    var e = document.createElement('li');
    e.className = 'empty-state';
    e.textContent = 'No members in this room yet';
    list.appendChild(e);
    return;
  }
  var now = serverNow();
  names.forEach(function(name) {
    var st = presenceOf(name, now);
    var li = document.createElement('li');
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'side-row crew-row-side ' + st.cls;
    row.appendChild(presenceAvatar(name, 'xs', st.cls));
    var nm = document.createElement('span');
    nm.className = 'side-row-name';
    nm.textContent = name;
    var meta = document.createElement('span');
    meta.className = 'side-row-meta';
    // One word, as in A: active, turn, idle, silent, offline.
    meta.textContent = { online: 'active', working: 'turn', idle: 'idle', silent: 'silent', offline: 'offline' }[st.cls];
    row.appendChild(nm);
    row.appendChild(meta);
    row.title = name + ', ' + st.short + (harnessOf(name) ? ', ' + harnessOf(name) : '');
    if (st.agent) {
      row.addEventListener('click', function(ev) { ev.stopPropagation(); showPopover(row, st.agent); });
    } else {
      // Not connected: nothing to open, so not a control.
      row.tabIndex = -1;
      row.setAttribute('aria-disabled', 'true');
      row.classList.add('static');
    }
    li.appendChild(row);
    list.appendChild(li);
  });
}

function pageSection(title, count) {
  var sec = document.createElement('section');
  sec.className = 'page-section';
  var h = document.createElement('h3');
  h.className = 'page-h3';
  h.textContent = title + (count != null ? ' · ' + count : '');
  sec.appendChild(h);
  var grid = document.createElement('div');
  grid.className = 'card-grid';
  sec.appendChild(grid);
  return { sec: sec, grid: grid, head: h };
}

function crewCard(name, sub, state, cls, extra) {
  var card = document.createElement('div');
  card.className = 'crew-card ' + cls;
  card.appendChild(presenceAvatar(name, '', cls));
  var text = document.createElement('div');
  text.className = 'crew-card-text';
  var n = document.createElement('div');
  n.className = 'crew-card-name';
  n.textContent = name;
  if (extra) {
    var ex = document.createElement('span');
    ex.className = 'crew-card-extra';
    ex.textContent = extra;
    n.appendChild(ex);
  }
  var s = document.createElement('div');
  s.className = 'crew-card-sub';
  s.textContent = sub;
  var w = document.createElement('div');
  w.className = 'crew-card-state';
  w.textContent = state;
  text.appendChild(n);
  text.appendChild(s);
  text.appendChild(w);
  card.appendChild(text);
  return card;
}

// The Crew page: members (you first), terminals, session templates.
function renderCrewPage() {
  renderCrewSideList();
  if (pageNow !== 'crew') return;
  var body = document.getElementById('page-crew-body');
  if (!body) return;
  var keep = body.contains(document.activeElement) ? document.activeElement.getAttribute('data-key') : null;
  body.textContent = '';
  var now = serverNow();
  var names = crewMembersList();
  var active = names.filter(function(n) { var c = presenceOf(n, now).cls; return c === 'online' || c === 'working'; }).length;

  var head = document.createElement('div');
  head.className = 'page-head';
  var sub = document.createElement('span');
  sub.className = 'page-sub';
  sub.textContent = names.length + (names.length === 1 ? ' member, ' : ' members, ') + active + ' active' +
    (activeConversation ? ' in # ' + activeConversation.name : '');
  var acts = document.createElement('div');
  acts.className = 'page-actions';
  var roster = document.createElement('button');
  roster.type = 'button';
  roster.className = 'btn btn-sm';
  roster.id = 'crew-btn';
  roster.setAttribute('data-key', 'roster');
  roster.textContent = 'Crew roster';
  roster.addEventListener('click', function() { openCrewPanel(); });
  var launch = document.createElement('button');
  launch.type = 'button';
  launch.className = 'btn btn-sm btn-primary';
  launch.id = 'launch-btn';
  launch.setAttribute('data-key', 'launch');
  launch.textContent = 'Launch an agent';
  launch.addEventListener('click', function() { openLaunchDialog(); });
  acts.appendChild(roster);
  acts.appendChild(launch);
  head.appendChild(sub);
  head.appendChild(acts);
  body.appendChild(head);

  var members = pageSection('Members', null);
  members.head.hidden = true;
  members.grid.appendChild(crewCard(myName(), 'human', 'here', 'online', 'you'));
  names.forEach(function(name) {
    var st = presenceOf(name, now);
    var a = st.agent;
    var parts = [];
    if (a && a.host) parts.push('hosted', 'remote: ' + a.host);
    else if (harnessOf(name)) parts.push(harnessOf(name));
    else if (a && memberRoute(a)) parts.push(memberRoute(a));
    if (a && a.role) parts.push(a.role);
    var card = crewCard(name, parts.join(' · ') || (a ? 'connected' : 'not connected'), st.short, st.cls, '');
    if (a) {
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('data-key', 'm:' + name);
      card.addEventListener('click', function(e) { e.stopPropagation(); showPopover(card, a); });
      card.addEventListener('keydown', function(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); showPopover(card, a); } });
    }
    members.grid.appendChild(card);
  });
  body.appendChild(members.sec);

  var terms = lastScanResults.filter(function(t) { return t.pid > 0; });
  var tsec = pageSection('Terminals', terms.length || null);
  var scan = document.createElement('button');
  scan.type = 'button';
  scan.className = 'btn btn-sm page-h3-act';
  scan.setAttribute('data-key', 'scan');
  scan.textContent = 'Scan';
  scan.addEventListener('click', function() { scanTerminals(); });
  tsec.head.appendChild(scan);
  if (terms.length === 0) {
    var none = document.createElement('div');
    none.className = 'page-empty';
    none.textContent = 'No terminals found yet. Scan to discover agent sessions on this machine.';
    tsec.grid.appendChild(none);
  }
  terms.forEach(function(t) {
    var joined = null;
    for (var i = 0; i < agents.length; i++) { if (agents[i].pid && agents[i].pid === t.pid) { joined = agents[i]; break; } }
    var card = document.createElement('div');
    card.className = 'term-card';
    var ico = document.createElement('span');
    ico.className = 'term-ico';
    ico.setAttribute('aria-hidden', 'true');
    ico.textContent = '>_';
    var text = document.createElement('div');
    text.className = 'crew-card-text';
    var n = document.createElement('div');
    n.className = 'crew-card-name';
    n.textContent = t.tabTitle || (joined ? joined.name : (HARNESS_LABELS[t.type] || t.type));
    var s = document.createElement('div');
    s.className = 'crew-card-sub';
    s.textContent = (HARNESS_LABELS[t.type] || t.type) + ', PID ' + t.pid + (joined ? ', joined as ' + joined.name : ', not joined');
    text.appendChild(n);
    text.appendChild(s);
    var act = document.createElement('button');
    act.type = 'button';
    act.className = 'btn btn-sm';
    act.setAttribute('data-key', 't:' + t.pid);
    act.textContent = joined ? 'Dismiss' : 'Invite';
    act.addEventListener('click', function() { if (joined) kickAgent(joined.name); else inviteTerminal(t); });
    card.appendChild(ico);
    card.appendChild(text);
    card.appendChild(act);
    tsec.grid.appendChild(card);
  });
  body.appendChild(tsec.sec);

  var tpl = pageSection('Session templates', null);
  if (sessionTemplates.length === 0) {
    var nt = document.createElement('div');
    nt.className = 'page-empty';
    nt.textContent = 'No templates loaded';
    tpl.grid.appendChild(nt);
  }
  sessionTemplates.forEach(function(t) {
    var card = document.createElement('div');
    card.className = 'tpl-card';
    var text = document.createElement('div');
    text.className = 'crew-card-text';
    var n = document.createElement('div');
    n.className = 'crew-card-name';
    n.textContent = t.name;
    var d = document.createElement('div');
    d.className = 'crew-card-sub';
    d.textContent = t.description || '';
    var r = document.createElement('div');
    r.className = 'crew-card-state';
    r.textContent = (t.roles || []).join(', ');
    text.appendChild(n);
    text.appendChild(d);
    text.appendChild(r);
    var start = document.createElement('button');
    start.type = 'button';
    start.className = 'btn btn-sm';
    start.setAttribute('data-key', 's:' + t.name);
    start.textContent = 'Start';
    start.addEventListener('click', function() { startSessionUI(t); });
    card.appendChild(text);
    card.appendChild(start);
    tpl.grid.appendChild(card);
  });
  body.appendChild(tpl.sec);

  if (keep) {
    var again = body.querySelector('[data-key="' + (window.CSS && CSS.escape ? CSS.escape(keep) : keep) + '"]');
    if (again) again.focus();
  }
}

// --- Decisions page (redesign lane 4) ---
// Three views from GET /api/decisions: Waiting on you (open asks for the
// viewer), Open (everyone's open asks) and Closed (resolved ones). A card
// shows the question, who asked, the room and the state; its choices are
// answered here through the choose route with the room named (the viewer
// answers as themselves); Open in room jumps to the message; Resolve
// closes an open ask without a choice.
var DECISION_VIEWS = [['waiting', 'Waiting on you'], ['open', 'Open'], ['closed', 'Closed']];
var decisionsPage = { view: 'waiting', lists: { waiting: null, open: null, closed: null }, seq: 0 };

function loadDecisionsPage() {
  var seq = ++decisionsPage.seq;
  var tok = encodeURIComponent(webToken());
  var urls = {
    waiting: '/api/decisions?state=open&token=' + tok,
    open: '/api/decisions?state=open&for=&token=' + tok,
    closed: '/api/decisions?state=resolved&for=&token=' + tok,
  };
  Object.keys(urls).forEach(function(k) {
    fetch(urls[k]).then(function(r) { return r.ok ? r.json() : { decisions: [] }; }).then(function(d) {
      if (seq !== decisionsPage.seq) return; // a newer load is under way
      decisionsPage.lists[k] = (d && Array.isArray(d.decisions)) ? d.decisions : [];
      renderDecisionViews();
      if (pageNow === 'decisions' && k === decisionsPage.view) renderDecisionsPage();
    }).catch(function() {
      if (seq !== decisionsPage.seq) return;
      decisionsPage.lists[k] = decisionsPage.lists[k] || [];
      renderDecisionViews();
    });
  });
}

function setDecisionView(view) {
  decisionsPage.view = DECISION_VIEWS.some(function(v) { return v[0] === view; }) ? view : 'waiting';
  renderDecisionViews();
  renderDecisionsPage();
}

// The sidebar views, with their counts.
function renderDecisionViews() {
  var ul = document.getElementById('decision-views');
  if (!ul) return;
  var keep = ul.contains(document.activeElement) ? document.activeElement.getAttribute('data-view') : null;
  ul.textContent = '';
  DECISION_VIEWS.forEach(function(v) {
    var list = decisionsPage.lists[v[0]];
    var li = document.createElement('li');
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'side-row decision-view' + (decisionsPage.view === v[0] ? ' active' : '');
    row.setAttribute('data-view', v[0]);
    if (decisionsPage.view === v[0]) row.setAttribute('aria-current', 'true');
    var ico = document.createElement('span');
    ico.className = 'side-row-ico';
    ico.setAttribute('aria-hidden', 'true');
    ico.textContent = '⚖';
    var name = document.createElement('span');
    name.className = 'side-row-name';
    name.textContent = v[1];
    row.appendChild(ico);
    row.appendChild(name);
    if (list && list.length > 0) {
      var count = document.createElement('span');
      count.className = 'conv-count' + (v[0] === 'waiting' ? ' mention' : '');
      count.textContent = String(list.length);
      row.appendChild(count);
    }
    row.addEventListener('click', function() { setDecisionView(v[0]); });
    li.appendChild(row);
    ul.appendChild(li);
    if (keep === v[0]) row.focus();
  });
}

function decisionCard(d, closed) {
  var card = document.createElement('article');
  card.className = 'decision-card' + (closed ? ' closed' : '');
  card.setAttribute('data-key', d.conversationId + ':' + d.messageId);
  var q = document.createElement('h3');
  q.className = 'decision-q';
  var firstLine = String(d.text || '').split('\n').filter(function(l) { return l.trim() !== ''; })[0] || '';
  q.textContent = firstLine.length > 200 ? firstLine.slice(0, 200) + '...' : firstLine;
  card.appendChild(q);

  var meta = document.createElement('div');
  meta.className = 'decision-meta';
  var id = document.createElement('span');
  id.className = 'pin-id';
  id.textContent = '#' + d.messageId;
  var by = document.createElement('span');
  by.textContent = 'asked by ' + d.sender;
  var room = document.createElement('span');
  room.textContent = 'in #' + (d.conversationName || d.conversationId);
  var st = document.createElement('span');
  st.className = 'decision-state';
  if (closed) {
    st.textContent = 'Closed' + (d.choiceResponse ? ': ' + d.choiceResponse.value : '') +
      (d.ask && d.ask.resolvedBy ? ' by ' + d.ask.resolvedBy : '');
  } else {
    st.textContent = 'Waiting on ' + (d.ask && d.ask.for === myName() ? 'you' : (d.ask ? d.ask.for : 'someone'));
  }
  meta.appendChild(id);
  meta.appendChild(by);
  meta.appendChild(room);
  meta.appendChild(st);
  card.appendChild(meta);

  var choices = Array.isArray(d.choices) ? d.choices : [];
  if (choices.length > 0) {
    var ul = document.createElement('div');
    ul.className = 'decision-choices';
    ul.setAttribute('role', 'group');
    ul.setAttribute('aria-label', 'Choices');
    choices.forEach(function(c, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'decision-choice';
      var key = document.createElement('span');
      key.className = 'decision-key';
      key.textContent = String.fromCharCode(65 + (i % 26));
      var txt = document.createElement('span');
      txt.className = 'decision-choice-text';
      txt.textContent = c;
      b.appendChild(key);
      b.appendChild(txt);
      var chosen = d.choiceResponse && d.choiceResponse.value === c;
      if (chosen) {
        b.classList.add('chosen');
        b.appendChild(presenceAvatar(d.choiceResponse.by, 'xs', 'online'));
        b.setAttribute('aria-pressed', 'true');
      }
      if (closed || d.choiceResponse) {
        b.disabled = true;
      } else {
        b.addEventListener('click', function() { chooseDecision(d, c, b); });
      }
      b.title = chosen ? 'Chosen by ' + d.choiceResponse.by : closed ? '' : 'Answer: ' + c;
      ul.appendChild(b);
    });
    card.appendChild(ul);
  }

  var acts = document.createElement('div');
  acts.className = 'decision-actions';
  var open = document.createElement('button');
  open.type = 'button';
  open.className = 'btn btn-sm';
  open.textContent = 'Open in #' + (d.conversationName || 'room');
  open.addEventListener('click', function() { openDecisionMessage(d); });
  acts.appendChild(open);
  if (!closed) {
    var resolve = document.createElement('button');
    resolve.type = 'button';
    resolve.className = 'btn btn-sm';
    resolve.textContent = 'Resolve';
    resolve.title = 'Close this ask without choosing';
    resolve.addEventListener('click', function() {
      rememberDecisionFocus(resolve);
      resolve.disabled = true;
      resolveAsk(d.messageId, d.conversationId);
    });
    acts.appendChild(resolve);
  }
  card.appendChild(acts);
  return card;
}

function rememberDecisionFocus(el) {
  var card = el.closest('.decision-card');
  var body = document.getElementById('page-decisions-body');
  if (!card || !body) return;
  decisionsPage.focusAfter = { key: card.getAttribute('data-key'), index: Array.prototype.indexOf.call(body.querySelectorAll('.decision-card'), card) };
}

function chooseDecision(d, value, btn) {
  rememberDecisionFocus(btn);
  btn.disabled = true;
  fetch('/api/message/' + d.messageId + '/choose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: value, conversation: d.conversationId }),
  }).then(function(r) {
    if (!r.ok) throw new Error('choose ' + r.status);
    decisionsSeq++;
    refreshDecisionsBadge();
  }).catch(function() {
    btn.disabled = false;
    showRefNotice('Could not record the answer; try again from the room.');
  });
}

// The same intent hand-off as the old decisions panel: select the room and
// let its render consume the jump (DMs open their thread).
function openDecisionMessage(d) {
  pendingDmJump = {
    conv: d.conversationId,
    to: (d.to && d.to.length > 0) ? (d.sender === myName() ? d.to[0] : d.sender) : null,
    msgId: d.messageId,
    deadline: Date.now() + 8000,
  };
  selectConversation(d.conversationId);
}

function renderDecisionsPage() {
  if (pageNow !== 'decisions') return;
  var body = document.getElementById('page-decisions-body');
  if (!body) return;
  var keepCard = body.contains(document.activeElement) ? document.activeElement.closest('.decision-card') : null;
  var keep = keepCard ? keepCard.getAttribute('data-key') : null;
  var keepIndex = keepCard ? Array.prototype.indexOf.call(body.querySelectorAll('.decision-card'), keepCard) : -1;
  // A pressed choice or Resolve is disabled at once, which can drop focus
  // before this render: the card it was on is remembered at the press.
  if (!keep && decisionsPage.focusAfter && (!document.activeElement || document.activeElement === document.body)) {
    keep = decisionsPage.focusAfter.key;
    keepIndex = decisionsPage.focusAfter.index;
  }
  decisionsPage.focusAfter = null;
  body.textContent = '';
  var view = decisionsPage.view;
  var list = decisionsPage.lists[view];
  var head = document.createElement('div');
  head.className = 'page-head';
  var sub = document.createElement('span');
  sub.className = 'page-sub';
  var n = list ? list.length : 0;
  sub.textContent = !list ? 'Loading...'
    : view === 'waiting' ? (n === 0 ? 'Nothing is waiting on you.' : n + (n === 1 ? ' ask is' : ' asks are') + ' waiting on you.')
    : view === 'open' ? n + ' open ' + (n === 1 ? 'ask' : 'asks') + ' across rooms.'
    : n + ' closed ' + (n === 1 ? 'ask' : 'asks') + '.';
  head.appendChild(sub);
  // On a phone the views sit here (the sidebar is a drawer).
  var chips = document.createElement('div');
  chips.className = 'page-chips phone-only';
  DECISION_VIEWS.forEach(function(v) {
    var c = document.createElement('button');
    c.type = 'button';
    c.className = 'fchip' + (view === v[0] ? ' on' : '');
    c.setAttribute('aria-pressed', view === v[0] ? 'true' : 'false');
    c.textContent = v[1];
    c.addEventListener('click', function() { setDecisionView(v[0]); });
    chips.appendChild(c);
  });
  head.appendChild(chips);
  body.appendChild(head);
  var wrap = document.createElement('div');
  wrap.className = 'decision-list';
  (list || []).forEach(function(d) { wrap.appendChild(decisionCard(d, view === 'closed')); });
  body.appendChild(wrap);
  if (keep) {
    // Focus stays with its card; when the card has gone (answered or
    // resolved), it moves to the card now in its place, else the one
    // before, else the current view control.
    var cards = wrap.querySelectorAll('.decision-card');
    var again = null;
    cards.forEach(function(c) { if (c.getAttribute('data-key') === keep) again = c; });
    if (!again && cards.length > 0) again = cards[Math.min(Math.max(keepIndex, 0), cards.length - 1)];
    var target = again ? again.querySelector('button:not([disabled])') : null;
    if (!target) {
      target = isMobileView() ? chips.querySelector('.fchip.on') : document.querySelector('#decision-views .decision-view.active');
    }
    if (target) target.focus();
  }
}

// --- Sections: collapsible, keyboard operable, remembered per browser ---
var COLLAPSED_KEY = 'joind-collapsed-sections';
function collapsedSections() {
  try { var v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
function saveCollapsed(key, collapsed) {
  if (!key) return;
  var list = collapsedSections().filter(function(k) { return k !== key; });
  if (collapsed) list.push(key);
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(list)); } catch (e) { /* storage unavailable */ }
}
function setSectionCollapsed(header, collapsed) {
  header.classList.toggle('collapsed', collapsed);
  var toggle = header.querySelector('h2') || header;
  toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  var body = header.nextElementSibling;
  if (body) body.classList.toggle('collapsed', collapsed);
}
function prepareSectionHeader(header) {
  if (header.getAttribute('data-prepared') === 'yes') return;
  header.setAttribute('data-prepared', 'yes');
  // The heading is the toggle (the header also holds its own buttons).
  var toggle = header.querySelector('h2') || header;
  toggle.setAttribute('role', 'button');
  toggle.tabIndex = 0;
  var key = header.getAttribute('data-sec');
  var collapsed = key ? collapsedSections().indexOf(key) >= 0 : false;
  setSectionCollapsed(header, collapsed);
  toggle.addEventListener('keydown', function(e) {
    if (e.target !== toggle) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSection(header); }
  });
}
function initSections() {
  document.querySelectorAll('.section-header').forEach(prepareSectionHeader);
}

// --- The task board (redesign lane 5) ---
// Every local room's tasks from GET /api/tasks?scope=all, in four columns:
// Open, In progress, In review, Done. A card moves by drag and drop, or
// from its menu (the keyboard route: Enter on a card, or its menu button):
// move to another column, assign, unassign, open its room. Filters: the
// sidebar views (all, assigned to me, urgent), a room, assignees. Remote
// rooms' tasks live on their home servers and are not on the board yet.
var board = { tasks: null, view: 'all', room: 'all', who: [], seq: 0, reload: 0, adding: null };
// A value inside an attribute selector.
function cssEsc(v) {
  return window.CSS && CSS.escape ? CSS.escape(String(v)) : String(v).replace(/[^a-zA-Z0-9_:-]/g, '');
}
var BOARD_VIEWS = [['all', 'All tasks'], ['mine', 'Assigned to me'], ['urgent', 'Urgent']];

function loadBoard() {
  var seq = ++board.seq;
  fetch('/api/tasks?scope=all&status=all&token=' + encodeURIComponent(webToken()))
    .then(function(r) { if (!r.ok) throw new Error('tasks ' + r.status); return r.json(); })
    .then(function(list) {
      if (seq !== board.seq) return;
      board.tasks = Array.isArray(list) ? list : [];
      renderBoardSide();
      renderBoard();
    })
    .catch(function() {
      if (seq !== board.seq) return;
      board.tasks = board.tasks || [];
      renderBoardSide();
      renderBoard();
    });
}

// Task events arrive for every room: one reload per burst.
function scheduleBoardReload() {
  if (pageNow !== 'tasks') return;
  if (board.reload) clearTimeout(board.reload);
  board.reload = setTimeout(function() { board.reload = 0; loadBoard(); }, 250);
}

function boardFilter(extra) {
  var f = { view: board.view, room: board.room, who: board.who, me: myName() };
  if (extra) Object.keys(extra).forEach(function(k) { f[k] = extra[k]; });
  return f;
}

function boardRooms() {
  var seen = {};
  var out = [];
  conversationList.forEach(function(c) {
    if (!seen[c.id]) { seen[c.id] = true; out.push({ id: c.id, name: c.name }); }
  });
  (board.tasks || []).forEach(function(t) {
    if (!seen[t.conversationId]) { seen[t.conversationId] = true; out.push({ id: t.conversationId, name: t.conversationName || t.conversationId }); }
  });
  return out;
}

function sideRow(label, count, active, onClick, glyph, key) {
  var li = document.createElement('li');
  var row = document.createElement('button');
  row.type = 'button';
  row.className = 'side-row decision-view' + (active ? ' active' : '');
  row.setAttribute('data-key', key);
  if (active) row.setAttribute('aria-current', 'true');
  var ico = document.createElement('span');
  ico.className = 'side-row-ico';
  ico.setAttribute('aria-hidden', 'true');
  ico.textContent = glyph;
  var name = document.createElement('span');
  name.className = 'side-row-name';
  name.textContent = label;
  var c = document.createElement('span');
  c.className = 'conv-count';
  c.textContent = count > 0 ? String(count) : '';
  row.appendChild(ico);
  row.appendChild(name);
  row.appendChild(c);
  row.addEventListener('click', onClick);
  li.appendChild(row);
  return li;
}

// The sidebar: views with counts, then rooms with their open counts.
function renderBoardSide() {
  var views = document.getElementById('task-views');
  var rooms = document.getElementById('task-rooms');
  if (!views || !rooms) return;
  var keep = (views.contains(document.activeElement) || rooms.contains(document.activeElement)) ? document.activeElement.getAttribute('data-key') : null;
  var all = board.tasks || [];
  views.textContent = '';
  BOARD_VIEWS.forEach(function(v) {
    var n = window.joindUi ? window.joindUi.filterBoardTasks(all, { view: v[0], room: 'all', who: [], me: myName() }).length : 0;
    views.appendChild(sideRow(v[1], n, board.view === v[0], function() { board.view = v[0]; renderBoardSide(); renderBoard(); }, v[0] === 'urgent' ? '!' : '▦', 'v:' + v[0]));
  });
  rooms.textContent = '';
  rooms.appendChild(sideRow('All rooms', all.filter(function(t) { return t.status !== 'done'; }).length, board.room === 'all', function() { board.room = 'all'; renderBoardSide(); renderBoard(); }, '#', 'r:all'));
  boardRooms().forEach(function(r) {
    var n = all.filter(function(t) { return t.conversationId === r.id && t.status !== 'done'; }).length;
    rooms.appendChild(sideRow(r.name, n, board.room === r.id, function() { board.room = r.id; renderBoardSide(); renderBoard(); }, '#', 'r:' + r.id));
  });
  if (keep) {
    var again = document.querySelector('#task-views [data-key="' + cssEsc(keep) + '"], #task-rooms [data-key="' + cssEsc(keep) + '"]');
    if (again) again.focus();
  }
}

function boardCardTag(text, cls) {
  var s = document.createElement('span');
  s.className = 'tag' + (cls ? ' ' + cls : '');
  s.textContent = text;
  return s;
}

function boardCard(t, now) {
  var card = document.createElement('article');
  card.className = 'board-card' + (t.priority === 'urgent' && t.status !== 'done' ? ' urgent' : '');
  card.draggable = true;
  card.tabIndex = 0;
  card.setAttribute('data-key', t.conversationId + ':' + t.id);
  card.setAttribute('aria-label', 'Task ' + t.id + ': ' + t.title + (t.assignee ? ', for ' + t.assignee : '') + '. Enter for actions.');
  var top = document.createElement('div');
  top.className = 'bc-top';
  var id = document.createElement('span');
  id.className = 'bc-id';
  id.textContent = 'T' + t.id;
  var title = document.createElement('span');
  title.className = 'bc-title';
  title.textContent = t.title;
  var menu = document.createElement('button');
  menu.type = 'button';
  menu.className = 'bc-menu';
  menu.setAttribute('aria-label', 'Actions for task ' + t.id);
  menu.setAttribute('aria-haspopup', 'menu');
  menu.tabIndex = -1;
  menu.textContent = '⋯';
  top.appendChild(id);
  top.appendChild(title);
  top.appendChild(menu);
  card.appendChild(top);
  var tags = document.createElement('div');
  tags.className = 'bc-tags';
  if (t.priority === 'urgent' && t.status !== 'done') tags.appendChild(boardCardTag('urgent', 'urgent'));
  tags.appendChild(boardCardTag('#' + (t.conversationName || t.conversationId)));
  if (t.anchorMessageId) tags.appendChild(boardCardTag('from #' + t.anchorMessageId, 'mono'));
  var age = document.createElement('span');
  age.className = 'bc-age';
  age.textContent = shortPillAge(Math.max(0, now - (t.updatedAt || t.createdAt || now)));
  age.title = 'Updated ' + new Date(t.updatedAt || t.createdAt || now).toLocaleString();
  var spacer = document.createElement('span');
  spacer.className = 'bc-spacer';
  tags.appendChild(spacer);
  tags.appendChild(age);
  if (t.assignee) {
    var av = memberAvatar(t.assignee, 'sm');
    av.title = 'For ' + t.assignee;
    tags.appendChild(av);
  }
  card.appendChild(tags);
  card.addEventListener('dragstart', function(e) {
    e.dataTransfer.setData('text/plain', card.getAttribute('data-key'));
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', function() { card.classList.remove('dragging'); });
  card.addEventListener('keydown', function(e) {
    if (e.target !== card) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCardMenu(t, card); }
  });
  menu.addEventListener('click', function(e) { e.stopPropagation(); openCardMenu(t, card); });
  card.addEventListener('dblclick', function() { openTaskInRoom(t); });
  return card;
}

function findBoardTask(key) {
  var parts = String(key || '').split(':');
  var id = Number(parts.pop());
  var conv = parts.join(':');
  var list = board.tasks || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id && list[i].conversationId === conv) return list[i];
  }
  return null;
}

// Optimistic, then the server; a refusal puts the card back.
function updateBoardTask(t, fields, focusKey) {
  var prev = { status: t.status, assignee: t.assignee };
  Object.keys(fields).forEach(function(k) { t[k] = fields[k] === null ? undefined : fields[k]; });
  board.focusKey = focusKey || (t.conversationId + ':' + t.id);
  renderBoard();
  renderBoardSide();
  var body = { id: t.id, conversation: t.conversationId, respondedBy: myName() };
  Object.keys(fields).forEach(function(k) { body[k] = fields[k]; });
  fetch('/api/tasks/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(function(r) { if (!r.ok) throw new Error('update ' + r.status); })
    .catch(function() {
      t.status = prev.status;
      t.assignee = prev.assignee;
      renderBoard();
      renderBoardSide();
      showRefNotice('Could not update task ' + t.id + '; it is back where it was.');
    });
}

function openTaskInRoom(t) {
  selectConversation(t.conversationId, function() {
    if (!taskPanelOpen) toggleTaskPanel();
  });
}

// The card menu: the keyboard route for everything a drag does, and more.
function openCardMenu(t, card) {
  closePopover();
  var pop = document.createElement('div');
  pop.className = 'pill-popover conv-more-menu board-menu';
  pop.setAttribute('role', 'menu');
  pop.setAttribute('aria-label', 'Task ' + t.id + ' actions');
  pop.addEventListener('click', function(e) { e.stopPropagation(); });
  var items = [];
  function add(label, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item';
    b.setAttribute('role', 'menuitem');
    b.textContent = label;
    b.addEventListener('click', function() { closePopover(); fn(); });
    pop.appendChild(b);
    items.push(b);
  }
  function sep() { var s = document.createElement('div'); s.className = 'menu-sep'; s.setAttribute('role', 'separator'); pop.appendChild(s); }
  var cols = window.joindUi ? window.joindUi.boardColumns() : [];
  cols.forEach(function(c) {
    if (c[0] !== t.status) add('Move to ' + c[1], function() { updateBoardTask(t, { status: c[0] }); });
  });
  sep();
  var names = [];
  agents.forEach(function(a) { if (names.indexOf(a.name) < 0) names.push(a.name); });
  crewRoster.forEach(function(c) { var n = c.joinAs || c.name; if (n && names.indexOf(n) < 0) names.push(n); });
  (board.tasks || []).forEach(function(x) { if (x.assignee && names.indexOf(x.assignee) < 0) names.push(x.assignee); });
  if (names.indexOf(myName()) < 0) names.unshift(myName());
  names.filter(function(n) { return n !== t.assignee; }).slice(0, 12).forEach(function(n) {
    add('Assign to ' + n, function() { updateBoardTask(t, { assignee: n }); });
  });
  if (t.assignee) add('Unassign', function() { updateBoardTask(t, { assignee: null }); });
  sep();
  add('Open in #' + (t.conversationName || 'room'), function() { openTaskInRoom(t); });
  pop.addEventListener('keydown', function(e) {
    var at = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length].focus();
    } else if (e.key === 'Tab' || e.key === 'Escape') {
      // Leaving the menu, either way: close it, back to the card.
      e.preventDefault();
      e.stopPropagation();
      closePopover();
      if (card.isConnected) card.focus();
    }
  });
  document.body.appendChild(pop);
  if (!isMobileView()) {
    var r = card.getBoundingClientRect();
    var pr = pop.getBoundingClientRect();
    pop.style.top = Math.max(8, Math.min(window.innerHeight - pr.height - 8, r.top)) + 'px';
    pop.style.left = Math.max(8, Math.min(window.innerWidth - pr.width - 8, r.right + 6)) + 'px';
  }
  openPopover = pop;
  popoverAnchor = card;
  if (items[0]) items[0].focus();
}

// A new card from a column's +: the room filter's room, else the room on
// screen; created open, then moved to the column.
function boardAddForm(colKey, colEl) {
  var roomId = board.room !== 'all' ? board.room : (activeConversation && !isRemoteConversation(activeConversation.id) ? activeConversation.id : null);
  var form = document.createElement('div');
  form.className = 'bc-add';
  var input = document.createElement('input');
  input.type = 'text';
  input.className = 'setting-input';
  input.maxLength = 200;
  var roomName = roomId ? ((boardRooms().filter(function(r) { return r.id === roomId; })[0] || {}).name || roomId) : '';
  input.placeholder = roomId ? 'New task in #' + roomName : 'Pick a room first';
  input.disabled = !roomId;
  input.setAttribute('aria-label', input.placeholder);
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); board.adding = null; renderBoard(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var title = input.value.trim();
    if (!title || !roomId) return;
    input.disabled = true;
    fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title, creator: myName(), conversation: roomId }) })
      .then(function(r) { if (!r.ok) throw new Error('create ' + r.status); return r.json(); })
      .then(function(task) {
        board.adding = null;
        if (colKey !== 'open' && task && task.id) {
          // Created as Open, then moved: a refused move leaves it in Open,
          // and the board says so instead of looking done.
          return fetch('/api/tasks/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: task.id, status: colKey, conversation: roomId, respondedBy: myName() }) })
            .then(function(r) { if (!r.ok) throw new Error('move ' + r.status); })
            .catch(function() {
              var col = (window.joindUi ? window.joindUi.boardColumns() : []).filter(function(c) { return c[0] === colKey; })[0];
              showRefNotice('Task ' + task.id + ' was created in Open; it could not be moved to ' + (col ? col[1] : colKey) + '.');
            });
        }
      }, function(err) { input.disabled = false; showRefNotice('Could not create the task.'); throw err; })
      .then(function() { loadBoard(); })
      .catch(function() { /* reported above */ });
  });
  form.appendChild(input);
  colEl.appendChild(form);
  setTimeout(function() { if (!input.disabled) input.focus(); }, 0);
}

function renderBoard() {
  if (pageNow !== 'tasks') return;
  var body = document.getElementById('page-tasks-body');
  if (!body || !window.joindUi) return;
  var ae = document.activeElement;
  var keep = board.focusKey || (body.contains(ae) && ae.closest('.board-card') ? ae.closest('.board-card').getAttribute('data-key') : null);
  var keepFilter = body.contains(ae) ? ae.getAttribute('data-fkey') : null;
  board.focusKey = null;
  var scroll = body.querySelector('.board') ? body.querySelector('.board').scrollLeft : 0;
  body.textContent = '';
  var all = board.tasks || [];
  var shown = window.joindUi.filterBoardTasks(all, boardFilter());
  var head = document.createElement('div');
  head.className = 'page-head';
  var sub = document.createElement('span');
  sub.className = 'page-sub';
  sub.textContent = !board.tasks ? 'Loading tasks...' : shown.length + ' of ' + all.length + ' tasks. Drag a card to change its status, or press Enter on it.';
  head.appendChild(sub);
  body.appendChild(head);

  // Filters: assignees (chips) and the room.
  var filters = document.createElement('div');
  filters.className = 'board-filters';
  var fl = document.createElement('span');
  fl.className = 'flabel';
  fl.textContent = 'Assignee';
  filters.appendChild(fl);
  var assignees = [];
  all.forEach(function(t) { if (t.assignee && assignees.indexOf(t.assignee) < 0) assignees.push(t.assignee); });
  assignees.sort();
  assignees.concat(['']).forEach(function(n) {
    var chip = document.createElement('button');
    chip.type = 'button';
    var on = board.who.indexOf(n) >= 0;
    chip.className = 'fchip' + (on ? ' on' : '');
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    chip.setAttribute('data-fkey', 'w:' + n);
    if (n) chip.appendChild(memberAvatar(n, 'sm'));
    var label = document.createElement('span');
    label.className = 'fname';
    label.textContent = n || 'Unassigned';
    chip.appendChild(label);
    chip.addEventListener('click', function() {
      board.who = on ? board.who.filter(function(x) { return x !== n; }) : board.who.concat([n]);
      renderBoard();
    });
    filters.appendChild(chip);
  });
  var sepEl = document.createElement('span');
  sepEl.className = 'tsep';
  filters.appendChild(sepEl);
  var rl = document.createElement('label');
  rl.className = 'flabel';
  rl.textContent = 'Room';
  rl.htmlFor = 'board-room';
  filters.appendChild(rl);
  var sel = document.createElement('select');
  sel.id = 'board-room';
  sel.className = 'setting-select';
  sel.setAttribute('data-fkey', 'room');
  var optAll = document.createElement('option');
  optAll.value = 'all';
  optAll.textContent = 'All rooms';
  sel.appendChild(optAll);
  boardRooms().forEach(function(r) {
    var o = document.createElement('option');
    o.value = r.id;
    o.textContent = '#' + r.name;
    sel.appendChild(o);
  });
  sel.value = board.room;
  sel.addEventListener('change', function() { board.room = sel.value; renderBoardSide(); renderBoard(); });
  filters.appendChild(sel);
  body.appendChild(filters);

  var groups = window.joindUi.groupByStatus(shown);
  var wrap = document.createElement('div');
  wrap.className = 'board';
  var now = serverNow();
  window.joindUi.boardColumns().forEach(function(c) {
    var col = document.createElement('section');
    col.className = 'board-col';
    col.setAttribute('data-col', c[0]);
    col.setAttribute('aria-label', c[1] + ', ' + groups[c[0]].length + ' tasks');
    var h = document.createElement('div');
    h.className = 'col-head';
    var sw = document.createElement('span');
    sw.className = 'col-sw ' + c[0];
    sw.setAttribute('aria-hidden', 'true');
    var name = document.createElement('span');
    name.textContent = c[1];
    var n = document.createElement('span');
    n.className = 'col-n';
    n.textContent = String(groups[c[0]].length);
    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'col-add';
    addBtn.setAttribute('aria-label', 'Add a task to ' + c[1]);
    addBtn.setAttribute('data-fkey', 'add:' + c[0]);
    addBtn.textContent = '+';
    addBtn.addEventListener('click', function() { board.adding = c[0]; renderBoard(); });
    h.appendChild(sw);
    h.appendChild(name);
    h.appendChild(n);
    h.appendChild(addBtn);
    col.appendChild(h);
    var list = document.createElement('div');
    list.className = 'col-body';
    groups[c[0]].forEach(function(t) { list.appendChild(boardCard(t, now)); });
    col.appendChild(list);
    if (board.adding === c[0]) boardAddForm(c[0], col);
    col.addEventListener('dragover', function(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; col.classList.add('drop'); });
    col.addEventListener('dragleave', function(e) { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); });
    col.addEventListener('drop', function(e) {
      e.preventDefault();
      col.classList.remove('drop');
      var t = findBoardTask(e.dataTransfer.getData('text/plain'));
      if (t && t.status !== c[0]) updateBoardTask(t, { status: c[0] });
    });
    wrap.appendChild(col);
  });
  body.appendChild(wrap);
  wrap.scrollLeft = scroll;
  if (keep) {
    var card = null;
    wrap.querySelectorAll('.board-card').forEach(function(x) { if (x.getAttribute('data-key') === keep) card = x; });
    if (card) card.focus();
  } else if (keepFilter) {
    var f = body.querySelector('[data-fkey="' + cssEsc(keepFilter) + '"]');
    if (f) f.focus();
  }
}

// --- The command palette (redesign lane 6, from variant B) ---
// Ctrl+K (Cmd+K on a Mac) anywhere, or "Jump to" in the phone's More menu:
// one box that jumps to a room, a linked room, a DM, a page, a message by
// number, or runs a room action. Type to filter (best match first), arrows
// to move, Enter to run, Escape to close; focus returns to where it was.
var palette = { overlay: null, opener: null, items: [], shown: [], at: 0 };

function paletteItems(query) {
  var items = [];
  var n = window.joindUi ? window.joindUi.parseBareMessageNumber(query) : null;
  if (n && activeConversation) {
    items.push({ group: 'Go to', label: 'Go to message #' + n, hint: activeDm ? 'in this DM view' : 'in #' + activeConversation.name, always: true,
      run: function() { jumpToMessage(currentConvId(), n); } });
  }
  conversationList.forEach(function(c) {
    var u = roomUnread[c.id] || 0;
    items.push({ group: 'Rooms', label: '#' + c.name, keywords: c.name, hint: u > 0 ? u + ' unread' : 'Room',
      run: function() { if (!activeConversation || activeConversation.id !== c.id || activeDm || pageNow) selectConversation(c.id); } });
  });
  remoteConversations.forEach(function(c) {
    items.push({ group: 'Rooms', label: c.name, keywords: 'remote ' + c.server + ' ' + c.name, hint: 'remote: ' + c.server,
      run: function() { selectConversation(c.id); } });
  });
  var dmNames = [];
  agents.forEach(function(a) { if (dmNames.indexOf(a.name) < 0) dmNames.push(a.name); });
  dmPartnersCache.forEach(function(p) { if (p !== myName() && dmNames.indexOf(p) < 0) dmNames.push(p); });
  dmNames.forEach(function(name) {
    var st = presenceOf(name);
    items.push({ group: 'Direct messages', label: name, keywords: 'dm direct message ' + name, hint: 'DM, ' + st.short,
      run: function() { selectDm(name); } });
  });
  var waiting = decisionsCache ? decisionsCache.length : 0;
  [['Rooms', 'rooms', 'Rooms and direct messages'], ['Direct messages', 'dms', 'DMs only'], ['Decisions', 'decisions', waiting > 0 ? waiting + ' waiting on you' : 'Asks across rooms'],
    ['Tasks board', 'tasks', 'All local rooms'], ['Crew', 'crew', 'Presence, terminals and sessions']].forEach(function(p) {
    items.push({ group: 'Pages', label: p[0], keywords: 'go page view ' + p[1], hint: p[2], run: function() { setRailView(p[1], true); } });
  });
  var inRoom = !!activeConversation && !activeDm && !pageNow;
  var roomName = activeConversation ? '#' + activeConversation.name : 'this room';
  if (activeConversation) {
    items.push({ group: 'Actions', label: 'Search in ' + roomName, keywords: 'find search', hint: 'Room search', run: function() { if (pageNow) leavePageFor('rooms'); var bar = document.getElementById('search-bar'); if (bar && bar.classList.contains('hidden')) toggleSearch(); else { var i = document.getElementById('search-input'); if (i) i.focus(); } } });
  }
  if (inRoom) {
    items.push({ group: 'Actions', label: 'Members of ' + roomName, keywords: 'members presence who', hint: 'Side panel', run: function() { openSidePanel('members', document.getElementById('members-btn')); } });
    items.push({ group: 'Actions', label: 'Pinned messages in ' + roomName, keywords: 'pins pinned', hint: 'Side panel', run: function() { openSidePanel('pins', document.getElementById('pins-btn')); } });
    items.push({ group: 'Actions', label: 'Export ' + roomName, keywords: 'export download markdown', hint: 'Room action', run: function() { exportChat(); } });
  }
  items.push({ group: 'Actions', label: 'Import a room', keywords: 'import upload json', hint: 'Room action', run: function() { openImportDialog(); } });
  items.push({ group: 'Actions', label: 'New room', keywords: 'create conversation channel', hint: 'Rooms', run: function() { newConversation(); } });
  items.push({ group: 'Actions', label: 'Launch an agent', keywords: 'launch start agent crew', hint: 'Crew', run: function() { openLaunchDialog(); } });
  items.push({ group: 'Actions', label: 'New task', keywords: 'task create todo', hint: activeConversation ? roomName : 'needs a room', run: function() { if (pageNow) leavePageFor('rooms'); openNewTask(); } });
  items.push({ group: 'Preferences', label: 'Settings', keywords: 'preferences options profile', hint: 'Ctrl ,', run: function() { openSettingsModal(null, palette.opener); } });
  items.push({ group: 'Preferences', label: currentTheme() === 'light' ? 'Dark theme' : 'Light theme', keywords: 'theme toggle appearance', hint: 'Preference', run: function() { toggleTheme(); } });
  items.push({ group: 'Preferences', label: isMuted ? 'Sounds on' : 'Sounds off', keywords: 'sound mute audio', hint: 'Preference', run: function() { isMuted = !isMuted; localStorage.setItem('joind-muted', JSON.stringify(isMuted)); updateMuteBtn(); } });
  return items;
}

function openPalette() {
  if (signedOut || settingsOverlay) return;
  if (palette.overlay) { closePalette(true); return; }
  closePopover();
  palette.opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  var overlay = document.createElement('div');
  overlay.className = 'palette-overlay';
  overlay.addEventListener('mousedown', function(e) { if (e.target === overlay) closePalette(true); });
  overlay.addEventListener('click', function(e) { e.stopPropagation(); });
  var box = document.createElement('div');
  box.className = 'palette';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', 'Jump to');
  var field = document.createElement('div');
  field.className = 'palette-field';
  var input = document.createElement('input');
  input.type = 'text';
  input.id = 'palette-input';
  input.className = 'palette-input';
  input.placeholder = 'Jump to a room, DM, page, message number or action';
  input.spellcheck = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', 'palette-list');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-label', 'Jump to');
  var kbd = document.createElement('kbd');
  kbd.textContent = 'Esc';
  field.appendChild(input);
  field.appendChild(kbd);
  var list = document.createElement('div');
  list.className = 'palette-list';
  list.id = 'palette-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Results');
  box.appendChild(field);
  box.appendChild(list);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  palette.overlay = overlay;
  input.addEventListener('input', function() { palette.at = 0; drawPalette(); });
  input.addEventListener('keydown', function(e) {
    // An IME is composing: its keys (Enter picks a candidate) are not ours.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (palette.shown.length === 0) return;
      palette.at = e.key === 'ArrowDown' ? (palette.at + 1) % palette.shown.length : (palette.at - 1 + palette.shown.length) % palette.shown.length;
      markPalette();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runPalette(palette.at);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePalette(true);
    } else if (e.key === 'Tab') {
      e.preventDefault(); // the field is the only stop; the list follows the arrows
    }
  });
  drawPalette();
  input.focus();
}

// The list follows the state while open: rooms, DMs, unread and waiting
// counts (called from their renderers).
function refreshPalette() {
  if (!palette.overlay) return;
  // The selected item stays selected when the list redraws under it.
  var keep = palette.shown[palette.at] ? palette.shown[palette.at].label : null;
  drawPalette(keep);
}

function drawPalette(keepLabel) {
  if (!palette.overlay) return;
  var input = document.getElementById('palette-input');
  var list = document.getElementById('palette-list');
  var q = input ? input.value : '';
  var all = paletteItems(q);
  var ranked = window.joindUi ? window.joindUi.paletteRank(all.filter(function(x) { return !x.always; }), q, 40) : [];
  palette.shown = all.filter(function(x) { return x.always; }).concat(ranked);
  list.textContent = '';
  if (palette.shown.length === 0) {
    var none = document.createElement('div');
    none.className = 'palette-empty';
    none.textContent = 'Nothing matches';
    list.appendChild(none);
  }
  var lastGroup = null;
  palette.shown.forEach(function(item, i) {
    // Group labels only while browsing; a query ranks across groups.
    if (!q.trim() && item.group !== lastGroup) {
      var g = document.createElement('div');
      g.className = 'palette-group';
      g.setAttribute('role', 'presentation');
      g.textContent = item.group;
      list.appendChild(g);
      lastGroup = item.group;
    }
    var opt = document.createElement('div');
    opt.className = 'palette-item';
    opt.id = 'palette-opt-' + i;
    opt.setAttribute('role', 'option');
    var label = document.createElement('span');
    label.className = 'palette-label';
    label.textContent = item.label;
    var hint = document.createElement('span');
    hint.className = 'palette-hint';
    hint.textContent = item.hint || item.group;
    opt.appendChild(label);
    opt.appendChild(hint);
    opt.addEventListener('mousemove', function() { if (palette.at !== i) { palette.at = i; markPalette(); } });
    opt.addEventListener('click', function() { runPalette(i); });
    list.appendChild(opt);
  });
  if (keepLabel) {
    for (var ki = 0; ki < palette.shown.length; ki++) { if (palette.shown[ki].label === keepLabel) { palette.at = ki; break; } }
  }
  if (palette.at >= palette.shown.length) palette.at = 0;
  markPalette();
}

function markPalette() {
  var input = document.getElementById('palette-input');
  var list = document.getElementById('palette-list');
  if (!list) return;
  list.querySelectorAll('.palette-item').forEach(function(el) {
    var on = el.id === 'palette-opt-' + palette.at;
    el.classList.toggle('on', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on) el.scrollIntoView({ block: 'nearest' });
  });
  if (input) {
    if (palette.shown.length > 0) input.setAttribute('aria-activedescendant', 'palette-opt-' + palette.at);
    else input.removeAttribute('aria-activedescendant');
  }
}

function runPalette(i) {
  var item = palette.shown[i];
  if (!item) return;
  closePalette(false);
  item.run();
}

function closePalette(returnFocus) {
  if (!palette.overlay) return;
  palette.overlay.remove();
  palette.overlay = null;
  palette.shown = [];
  var back = palette.opener;
  palette.opener = null;
  if (returnFocus && back && back.isConnected && back.offsetParent !== null) back.focus();
}

// Ctrl+K or Cmd+K opens it from anywhere (typing in the composer too: the
// key has no other use there).
document.addEventListener('keydown', function(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || String(e.key).toLowerCase() !== 'k') return;
  if (e.isComposing || e.keyCode === 229) return;
  if (signedOut || settingsOverlay) return;
  // Not over another dialog (the launcher, the crew roster, a prompt, the
  // notifications or decisions overlays, the image viewer); Ctrl+K inside
  // the palette still closes it.
  if (!palette.overlay && document.querySelector('.session-modal-overlay, .crew-panel-overlay, .launch-dialog-overlay, .notify-panel-overlay, .lightbox')) return;
  e.preventDefault();
  openPalette();
});

// --- The composer bar: the plus-menu, decision, task ---
// The plus button opens one menu: Files, Images, Paste image, URL, Prompt
// snippets and Decision card, with a tip line. Arrow keys move, Home and
// End jump, Escape closes (focus back to the plus button), Tab closes.
var attachMenuOpen = false;
var attachMenuView = 'main'; // 'main' or 'snippets'
var snippetsCache = null;    // the viewer's snippets, loaded on demand
var snippetsSeq = 0;

var ATTACH_ITEMS = [
  { id: 'files', label: 'Files', icon: 'paperclip', attach: true, run: function() { pickFiles(false); } },
  { id: 'images', label: 'Images', icon: 'image', attach: true, run: function() { pickFiles(true); } },
  { id: 'paste', label: 'Paste image', icon: 'clipboard-paste', attach: true, run: pasteImageFromClipboard },
  { id: 'url', label: 'URL', icon: 'link', run: function() { openUrlPopover(); } },
  { id: 'snippets', label: 'Prompt snippets', icon: 'message-square-text', stay: true, run: function() { showSnippetsView(); } },
  { id: 'decision', label: 'Decision card', icon: 'scale', run: function() { openDecidePopover(); } },
];

// Kept under its old name: the plus button calls it.
function openAttachPicker() { toggleAttachMenu(); }

function toggleAttachMenu() {
  if (attachMenuOpen) closeAttachMenu(true);
  else openAttachMenu();
}

function openAttachMenu() {
  closeDecidePopover();
  closeUrlPopover(false);
  hideMentionMenu();
  showComposerNote('');
  attachMenuOpen = true;
  attachMenuView = 'main';
  var btn = document.getElementById('attach-btn');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  renderAttachMenu();
  focusFirstMenuItem();
}

function closeAttachMenu(returnFocus) {
  if (!attachMenuOpen) return;
  attachMenuOpen = false;
  var menu = document.getElementById('attach-menu');
  if (menu) { menu.hidden = true; menu.textContent = ''; }
  var btn = document.getElementById('attach-btn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
  if (returnFocus && btn) btn.focus();
}

function lucideIcon(name) {
  var i = document.createElement('i');
  i.setAttribute('data-lucide', name);
  i.setAttribute('width', '16');
  i.setAttribute('height', '16');
  i.setAttribute('aria-hidden', 'true');
  return i;
}

function renderAttachMenu() {
  var menu = document.getElementById('attach-menu');
  if (!menu) return;
  menu.textContent = '';
  menu.hidden = false;
  if (attachMenuView === 'snippets') { renderSnippetsView(menu); return; }
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Attach');
  var head = document.createElement('div');
  head.className = 'attach-menu-head';
  head.textContent = 'Attach';
  head.setAttribute('aria-hidden', 'true');
  menu.appendChild(head);
  var remote = composerIsRemote();
  ATTACH_ITEMS.forEach(function(item) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'attach-item';
    b.id = 'attach-item-' + item.id;
    b.setAttribute('role', 'menuitem');
    b.tabIndex = -1;
    b.appendChild(lucideIcon(item.icon));
    var t = document.createElement('span');
    t.textContent = item.label;
    b.appendChild(t);
    var off = !!(item.attach && remote);
    if (off) {
      b.setAttribute('aria-disabled', 'true');
      b.classList.add('disabled');
      b.title = 'Attachments are not supported in remote rooms';
    }
    b.addEventListener('click', function() {
      if (off) { attachmentsRefusedHere(); closeAttachMenu(true); return; }
      if (!item.stay) closeAttachMenu(false);
      item.run();
    });
    menu.appendChild(b);
  });
  if (remote) {
    var note = document.createElement('div');
    note.className = 'attach-menu-note';
    note.textContent = 'Remote room: attachments are not carried across a link.';
    menu.appendChild(note);
  }
  var tip = document.createElement('div');
  tip.className = 'attach-menu-tip';
  tip.textContent = 'Tip: type @ to mention a crew member';
  menu.appendChild(tip);
  if (window.lucide) lucide.createIcons({ root: menu });
}

function menuItems() {
  var menu = document.getElementById('attach-menu');
  return menu ? Array.prototype.slice.call(menu.querySelectorAll('.attach-item')) : [];
}

function focusFirstMenuItem() {
  var items = menuItems();
  if (items.length) items[0].focus();
}

function onAttachMenuKey(e) {
  if (!attachMenuOpen) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    if (attachMenuView === 'snippets') { attachMenuView = 'main'; renderAttachMenu(); var s = document.getElementById('attach-item-snippets'); if (s) s.focus(); return; }
    closeAttachMenu(true);
    return;
  }
  if (e.key === 'Tab') { closeAttachMenu(false); return; }
  var items = attachMenuView === 'snippets'
    ? Array.prototype.slice.call(document.querySelectorAll('#attach-menu .snippet-item, #attach-menu .snippet-filter'))
    : menuItems();
  if (items.length === 0) return;
  var at = items.indexOf(document.activeElement);
  var next = -1;
  if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % items.length;
  else if (e.key === 'ArrowUp') next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
  else if (e.key === 'Home' && attachMenuView === 'main') next = 0;
  else if (e.key === 'End' && attachMenuView === 'main') next = items.length - 1;
  if (next < 0) return;
  e.preventDefault();
  items[next].focus();
}

// --- Prompt snippets in the menu ---
function loadSnippets() {
  var seq = ++snippetsSeq;
  return fetch('/api/snippets').then(function(r) {
    return r.json().catch(function() { return {}; }).then(function(body) {
      if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status));
      return body;
    });
  }).then(function(body) {
    if (seq === snippetsSeq) snippetsCache = Array.isArray(body.snippets) ? body.snippets : [];
    return snippetsCache;
  });
}

function showSnippetsView() {
  attachMenuView = 'snippets';
  renderAttachMenu();
  var f = document.querySelector('#attach-menu .snippet-filter');
  if (f) f.focus();
  loadSnippets().then(function() {
    if (attachMenuOpen && attachMenuView === 'snippets') refreshSnippetList();
  }).catch(function(err) {
    var list = document.getElementById('snippet-list');
    if (list) { list.textContent = ''; list.appendChild(snippetEmpty('Could not load snippets: ' + err.message)); }
  });
}

function snippetEmpty(text) {
  var d = document.createElement('div');
  d.className = 'snippet-empty';
  d.textContent = text;
  return d;
}

function renderSnippetsView(menu) {
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', 'Prompt snippets');
  var head = document.createElement('div');
  head.className = 'attach-menu-head snippet-head';
  var back = document.createElement('button');
  back.type = 'button';
  back.className = 'btn-link snippet-back';
  back.textContent = 'Back';
  back.setAttribute('aria-label', 'Back to the attach menu');
  back.addEventListener('click', function() {
    attachMenuView = 'main';
    renderAttachMenu();
    var s = document.getElementById('attach-item-snippets');
    if (s) s.focus();
  });
  var h = document.createElement('span');
  h.textContent = 'Prompt snippets';
  head.appendChild(back);
  head.appendChild(h);
  menu.appendChild(head);
  var filter = document.createElement('input');
  filter.type = 'text';
  filter.className = 'snippet-filter';
  filter.id = 'snippet-filter';
  filter.placeholder = 'Filter snippets';
  filter.setAttribute('aria-label', 'Filter snippets');
  filter.setAttribute('aria-controls', 'snippet-list');
  filter.autocomplete = 'off';
  filter.addEventListener('input', refreshSnippetList);
  filter.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      var first = document.querySelector('#snippet-list .snippet-item');
      if (first) first.click();
    }
  });
  menu.appendChild(filter);
  var list = document.createElement('div');
  list.className = 'snippet-list';
  list.id = 'snippet-list';
  list.setAttribute('role', 'list');
  menu.appendChild(list);
  var manage = document.createElement('button');
  manage.type = 'button';
  manage.className = 'btn-link snippet-manage';
  manage.textContent = 'Manage snippets';
  manage.addEventListener('click', function() {
    closeAttachMenu(false);
    openSettingsModal('snippets', document.getElementById('attach-btn'));
  });
  menu.appendChild(manage);
  refreshSnippetList();
}

function refreshSnippetList() {
  var list = document.getElementById('snippet-list');
  var filter = document.getElementById('snippet-filter');
  if (!list) return;
  // A reload must not drop keyboard focus from a row: keep its position.
  var rows = Array.prototype.slice.call(list.querySelectorAll('.snippet-item'));
  var focusAt = rows.indexOf(document.activeElement);
  list.textContent = '';
  if (snippetsCache === null) { list.appendChild(snippetEmpty('Loading...')); return; }
  var shown = window.joindUi.filterSnippets(snippetsCache, filter ? filter.value : '');
  if (snippetsCache.length === 0) { list.appendChild(snippetEmpty('No snippets yet. Add one in Settings.')); return; }
  if (shown.length === 0) { list.appendChild(snippetEmpty('No snippet matches.')); return; }
  shown.forEach(function(s) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'snippet-item';
    b.setAttribute('role', 'listitem');
    var t = document.createElement('span');
    t.className = 'snippet-title';
    t.textContent = s.title;
    var p = document.createElement('span');
    p.className = 'snippet-preview';
    p.textContent = String(s.text).replace(/\s+/g, ' ').slice(0, 90);
    b.appendChild(t);
    b.appendChild(p);
    b.addEventListener('click', function() {
      closeAttachMenu(false);
      insertIntoComposer(String(s.text), false);
    });
    list.appendChild(b);
  });
  if (focusAt >= 0) {
    var again = list.querySelectorAll('.snippet-item');
    if (again.length) again[Math.min(focusAt, again.length - 1)].focus();
    else if (filter) filter.focus();
  }
}

// --- URL: a link card, drawn from what the viewer typed (no fetching) ---
function openUrlPopover() {
  closeDecidePopover();
  var pop = document.getElementById('url-popover');
  if (!pop) return;
  pop.hidden = false;
  document.getElementById('url-input').value = '';
  document.getElementById('url-title').value = '';
  setUrlError('');
  setTimeout(function() { document.getElementById('url-input').focus(); }, 0);
}

function closeUrlPopover(returnFocus) {
  var pop = document.getElementById('url-popover');
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  if (returnFocus) document.getElementById('message-input').focus();
}

function setUrlError(text) {
  var el = document.getElementById('url-error');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

function submitUrlForm() {
  var raw = document.getElementById('url-input').value;
  var title = document.getElementById('url-title').value;
  var md = window.joindUi.linkCardMarkdown(raw, title);
  if (!md) {
    setUrlError('Enter a full http or https address, such as https://example.com/page.');
    document.getElementById('url-input').focus();
    return;
  }
  closeUrlPopover(false);
  insertIntoComposer(md, true);
}

// Link cards in a rendered message: a sanitized link whose title is "card"
// is redrawn as a card with DOM calls; its href already passed the
// sanitizer, and a card is drawn only for http and https.
function decorateLinkCards(root) {
  var links = root.querySelectorAll('a[title="card"]');
  Array.prototype.forEach.call(links, function(a) {
    var href = a.getAttribute('href') || '';
    a.removeAttribute('title');
    if (!window.joindUi || !window.joindUi.linkCardUrl(href)) return;
    var text = (a.textContent || '').trim();
    var label = window.joindUi.linkCardLabel(href);
    var card = document.createElement('a');
    card.className = 'link-card';
    card.href = href;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    var ic = lucideIcon('link');
    ic.setAttribute('class', 'link-card-icon');
    var body = document.createElement('span');
    body.className = 'link-card-body';
    var t = document.createElement('span');
    t.className = 'link-card-title';
    t.textContent = text && text !== href ? text : label;
    var u = document.createElement('span');
    u.className = 'link-card-url';
    u.textContent = label;
    body.appendChild(t);
    body.appendChild(u);
    card.appendChild(ic);
    card.appendChild(body);
    a.parentNode.replaceChild(card, a);
    if (window.lucide) lucide.createIcons({ root: card });
  });
}

// --- Settings: Prompt snippets (list, add, edit, delete) ---
function buildSnippetsSection() {
  var sec = settingsSection('snippets', 'Prompt snippets');
  var hint = document.createElement('p');
  hint.className = 'setting-hint snippets-hint';
  hint.textContent = 'Plain text you insert from the composer plus-menu. Kept on this server for you.';
  sec.appendChild(hint);
  var list = document.createElement('div');
  list.className = 'snippets-manage-list';
  list.id = 'snippets-manage-list';
  sec.appendChild(list);

  var form = document.createElement('div');
  form.className = 'snippet-form';
  var tl = document.createElement('label');
  tl.className = 'setting-name';
  tl.htmlFor = 'snippet-form-title';
  tl.textContent = 'Title';
  var ti = document.createElement('input');
  ti.type = 'text';
  ti.id = 'snippet-form-title';
  ti.maxLength = 80;
  ti.placeholder = 'Review request';
  var xl = document.createElement('label');
  xl.className = 'setting-name';
  xl.htmlFor = 'snippet-form-text';
  xl.textContent = 'Text';
  var xt = document.createElement('textarea');
  xt.id = 'snippet-form-text';
  xt.rows = 3;
  xt.maxLength = 8000;
  xt.placeholder = 'Please review the change and report findings by severity.';
  var err = document.createElement('div');
  err.className = 'snippet-form-error';
  err.setAttribute('role', 'alert');
  err.hidden = true;
  var acts = document.createElement('div');
  acts.className = 'snippet-form-actions';
  var cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-sm';
  cancel.textContent = 'Cancel edit';
  cancel.hidden = true;
  var save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn btn-sm btn-primary';
  save.id = 'snippet-form-save';
  save.textContent = 'Add snippet';
  acts.appendChild(cancel);
  acts.appendChild(save);
  form.appendChild(tl); form.appendChild(ti);
  form.appendChild(xl); form.appendChild(xt);
  form.appendChild(err); form.appendChild(acts);
  sec.appendChild(form);

  var editing = null;
  function resetForm() {
    editing = null;
    ti.value = ''; xt.value = '';
    save.textContent = 'Add snippet';
    cancel.hidden = true;
    err.hidden = true;
  }
  function fail(text) { err.textContent = text; err.hidden = !text; }
  cancel.addEventListener('click', resetForm);
  save.addEventListener('click', function() {
    var body = { title: ti.value, text: xt.value };
    if (!body.title.trim()) { fail('Give the snippet a title.'); ti.focus(); return; }
    if (!body.text.trim()) { fail('The snippet needs some text.'); xt.focus(); return; }
    var url = editing ? '/api/snippets/' + encodeURIComponent(editing) : '/api/snippets';
    save.disabled = true;
    fetch(url, { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function(r) { return r.json().catch(function() { return {}; }).then(function(b) { return { ok: r.ok, status: r.status, body: b }; }); })
      .then(function(res) {
        save.disabled = false;
        if (!res.ok) { fail('Not saved: ' + ((res.body && res.body.error) || ('HTTP ' + res.status)) + '.'); return; }
        resetForm();
        paint();
        // The disabled button dropped focus; keep it in the dialog.
        ti.focus();
      })
      .catch(function() { save.disabled = false; save.focus(); fail('Not saved: the server could not be reached.'); });
  });

  function paint() {
    loadSnippets().then(function(items) {
      list.textContent = '';
      if (items.length === 0) { list.appendChild(snippetEmpty('No snippets yet.')); return; }
      items.forEach(function(s) {
        var row = document.createElement('div');
        row.className = 'snippet-row';
        var text = document.createElement('div');
        text.className = 'setting-text';
        var n = document.createElement('span');
        n.className = 'setting-name';
        n.textContent = s.title;
        var p = document.createElement('span');
        p.className = 'setting-hint snippet-row-text';
        p.textContent = String(s.text).replace(/\s+/g, ' ').slice(0, 140);
        text.appendChild(n); text.appendChild(p);
        var edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'btn btn-sm';
        edit.textContent = 'Edit';
        edit.setAttribute('aria-label', 'Edit snippet ' + s.title);
        edit.addEventListener('click', function() {
          editing = s.id;
          ti.value = s.title; xt.value = s.text;
          save.textContent = 'Save changes';
          cancel.hidden = false;
          err.hidden = true;
          ti.focus();
        });
        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn btn-sm btn-danger-outline';
        del.textContent = 'Delete';
        del.setAttribute('aria-label', 'Delete snippet ' + s.title);
        del.addEventListener('click', function() {
          if (del.getAttribute('data-confirm') !== 'yes') {
            del.setAttribute('data-confirm', 'yes');
            del.textContent = 'Press again to delete';
            return;
          }
          fetch('/api/snippets/' + encodeURIComponent(s.id), { method: 'DELETE' })
            .then(function(r) {
              if (!r.ok) { fail('Not deleted: HTTP ' + r.status + '.'); return; }
              if (editing === s.id) resetForm();
              paint();
              ti.focus();
            })
            .catch(function() { fail('Not deleted: the server could not be reached.'); });
        });
        var ctl = document.createElement('div');
        ctl.className = 'setting-control';
        ctl.appendChild(edit); ctl.appendChild(del);
        row.appendChild(text); row.appendChild(ctl);
        list.appendChild(row);
      });
    }).catch(function(e) {
      list.textContent = '';
      list.appendChild(snippetEmpty('Could not load snippets: ' + e.message));
    });
  }
  paint();
  return sec;
}

function openNewTask() {
  if (!activeConversation) return;
  if (!taskPanelOpen) toggleTaskPanel();
  showCreateTaskForm();
}

// --- Utils ---
function customPrompt(message, defaultValue, callback) {
  var overlay = document.createElement('div');
  overlay.className = 'session-modal-overlay';

  var modal = document.createElement('div');
  modal.className = 'session-modal';
  modal.style.width = '300px';

  var title = document.createElement('div');
  title.className = 'session-modal-title';
  title.style.fontSize = 'var(--fs-body)';
  title.textContent = message;
  modal.appendChild(title);

  var input = document.createElement('input');
  input.type = 'text';
  input.className = 'pop-input';
  input.style.width = '100%';
  input.style.marginTop = '12px';
  input.style.marginBottom = '16px';
  input.style.fontSize = 'var(--fs-ui)';
  input.style.padding = '8px 12px';
  input.value = defaultValue || '';
  modal.appendChild(input);

  var btnRow = document.createElement('div');
  btnRow.className = 'session-modal-btns';
  btnRow.style.marginTop = '0';
  btnRow.style.paddingTop = '0';
  btnRow.style.borderTop = 'none';

  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-sm';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', function() {
    overlay.remove();
    callback(null);
  });

  var okBtn = document.createElement('button');
  okBtn.className = 'btn btn-send';
  okBtn.style.padding = '6px 16px';
  okBtn.style.width = 'auto';
  okBtn.style.height = 'auto';
  okBtn.style.fontSize = 'var(--fs-label)';
  okBtn.textContent = 'OK';
  okBtn.addEventListener('click', function() {
    var val = input.value;
    overlay.remove();
    callback(val);
  });

  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') okBtn.click();
    if (e.key === 'Escape') cancelBtn.click();
  });

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(okBtn);
  modal.appendChild(btnRow);
  overlay.appendChild(modal);

  document.body.appendChild(overlay);
  input.focus();
  input.select();
}
function getSenderColor(sender) {
  var lower = sender.toLowerCase();
  if (SENDER_COLORS[lower]) return SENDER_COLORS[lower];
  var hash = 0;
  for (var i = 0; i < sender.length; i++) hash = sender.charCodeAt(i) + ((hash << 5) - hash);
  return 'hsl(' + (Math.abs(hash) % 360) + ', 55%, 60%)';
}

function recolorMessages(name, color) {
  var lower = name.toLowerCase();
  document.querySelectorAll('.message[data-sender="' + lower + '"]').forEach(function(el) {
    el.style.setProperty('--bubble-color', color);
    var av = el.querySelector('.msg-avatar');
    if (av) { av.style.background = color; av.style.setProperty('--avatar-color', color); }
    var sn = el.querySelector('.msg-sender');
    if (sn) sn.style.color = color;
    var badge = el.querySelector('.msg-role-badge');
    if (badge) { badge.style.color = color; badge.style.borderColor = color + '40'; }
  });
}
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function formatTimeShort(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function formatDay(ts) {
  var d = new Date(ts);
  var now = new Date();
  var dayStart = function(x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
  var diffDays = Math.round((dayStart(now) - dayStart(d)) / 86400000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
}

// --- "You" pill ---
// Your avatar at the rail foot opens your menu: Settings, Theme, Web token
// and Sign out (redesign lane 3). The name and colour that the old profile
// popover edited live in the Settings modal now.
var setMyName = null;   // set by setupYouPill: rename through the one path
var YOU_COLORS = [
  '#da7756','#e74c3c','#f39c12','#f1c40f','#2ecc71','#1abc9c',
  '#4ecdc4','#3498db','#4285f4','#9b59b6','#7c3aed','#e91e63',
  '#ff6b6b','#ff9ff3','#feca57','#48dbfb','#0abde3','#10ac84',
  '#c8d6e5','#8395a7','#576574','#222f3e'
];

function setupYouPill() {
  var pill = document.getElementById('you-pill');
  var display = document.getElementById('you-name-display');
  var senderInput = document.getElementById('sender-name');

  // Load saved name
  var saved = localStorage.getItem('joind-sender-name');
  if (saved) {
    senderInput.value = saved;
  }

  function syncName() {
    var name = senderInput.value || 'human';
    display.textContent = name;
    var avatar = document.getElementById('you-avatar');
    if (avatar) {
      avatar.textContent = name.charAt(0).toUpperCase();
      avatar.style.background = getSenderColor(name);
    }
    pill.title = 'You: ' + name;
    pill.setAttribute('aria-label', 'Your menu, ' + name);
    syncUserMenuName(name);
    localStorage.setItem('joind-sender-name', name);
    // Renames flow only through the authenticated socket (web-rename); HTTP
    // register is first-boot only and would 409 here. If no OPEN socket can
    // carry the rename now, onopen applies it once the socket is up.
    if (!wsName || name === wsName || !ws) return;
    if (ws.readyState === WebSocket.OPEN) {
      renameAttempt = wsName;
      ws.send(JSON.stringify({ type: 'web-rename', name: name }));
    } else {
      pendingRename = true; // CONNECTING/CLOSING/CLOSED: applied in onopen
    }
  }
  senderInput.addEventListener('input', syncName);
  senderInput.addEventListener('change', syncName);
  setMyName = function(name) {
    senderInput.value = String(name || '').trim() || 'human';
    syncName();
  };

  // Keyboard activation (role="button" needs Enter/Space); ArrowUp opens
  // the menu too, as it opens upward from the rail foot.
  pill.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      openUserMenu();
    }
  });
  pill.addEventListener('click', function(e) {
    e.stopPropagation();
    openUserMenu();
  });

  syncName();
}

// An open user menu follows a rename (or a refused one) in place.
function syncUserMenuName(name) {
  if (!openPopover || !openPopover.classList.contains('user-menu')) return;
  var nm = openPopover.querySelector('.user-menu-name');
  if (nm) nm.textContent = name;
  var av = openPopover.querySelector('.user-menu-head .you-avatar');
  if (av) {
    av.textContent = (name || '?').charAt(0).toUpperCase();
    av.style.background = getSenderColor(name);
  }
}

// A colour for your name, as the old profile popover set it.
function setMyColor(c) {
  var name = (myName() || 'human').toLowerCase();
  SENDER_COLORS[name] = c;
  try { localStorage.setItem('joind-colors', JSON.stringify(SENDER_COLORS)); } catch (e) { /* storage unavailable */ }
  recolorMessages(name, c);
  if (setMyName) setMyName(myName());
}

// --- Theme ---
var THEME_KEY = 'joind-theme';
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}
function setTheme(t) {
  var theme = t === 'light' ? 'light' : 'dark';
  if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* storage unavailable: this page only */ }
  document.querySelectorAll('[data-theme-choice]').forEach(function(b) {
    b.setAttribute('aria-pressed', b.getAttribute('data-theme-choice') === theme ? 'true' : 'false');
  });
}
function toggleTheme() { setTheme(currentTheme() === 'light' ? 'dark' : 'light'); }

// --- Web token: where it comes from, masked ---
function tokenSource() {
  if (window.__JOIND_TOKEN) return 'served';
  var stored = '';
  try { stored = sessionStorage.getItem('joind-web-token') || ''; } catch (e) { /* storage unavailable */ }
  return stored ? 'tab' : 'none';
}
function maskedToken() {
  var t = webToken();
  if (!t) return 'not set';
  return '•••••• ' + t.slice(-4);
}

// --- The menu ---
function menuIcon(name) {
  var span = document.createElement('span');
  span.className = 'menu-ico';
  span.setAttribute('aria-hidden', 'true');
  var i = document.createElement('i');
  i.setAttribute('data-lucide', name);
  i.setAttribute('width', '16');
  i.setAttribute('height', '16');
  span.appendChild(i);
  return span;
}

function openUserMenu() {
  var pill = document.getElementById('you-pill');
  if (!pill) return;
  if (openPopover && openPopover.classList.contains('user-menu')) { closePopover(); pill.focus(); return; }
  closePopover();
  var pop = document.createElement('div');
  pop.className = 'pill-popover user-menu';
  pop.setAttribute('role', 'menu');
  pop.setAttribute('aria-label', 'Your menu');
  pop.addEventListener('click', function(e) { e.stopPropagation(); });

  var head = document.createElement('div');
  head.className = 'user-menu-head';
  var av = document.createElement('span');
  av.className = 'you-avatar';
  av.setAttribute('aria-hidden', 'true');
  av.textContent = (myName() || '?').charAt(0).toUpperCase();
  av.style.background = getSenderColor(myName());
  var who = document.createElement('div');
  who.className = 'user-menu-who';
  var nm = document.createElement('span');
  nm.className = 'user-menu-name';
  nm.textContent = myName();
  var sub = document.createElement('span');
  sub.className = 'user-menu-sub';
  var inst = document.getElementById('instance-name');
  sub.textContent = (signedOut ? 'signed out' : 'active') + ' · human · ' + (inst ? inst.textContent : 'Joind');
  who.appendChild(nm);
  who.appendChild(sub);
  head.appendChild(av);
  head.appendChild(who);
  pop.appendChild(head);

  var items = [];
  function addItem(icon, label, hint, fn, cls) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-item' + (cls ? ' ' + cls : '');
    b.setAttribute('role', 'menuitem');
    b.appendChild(menuIcon(icon));
    var t = document.createElement('span');
    t.textContent = label;
    b.appendChild(t);
    if (hint) {
      var h = document.createElement('span');
      h.className = 'menu-hint';
      h.textContent = hint;
      b.appendChild(h);
    }
    b.addEventListener('click', function(e) { e.stopPropagation(); fn(b); });
    pop.appendChild(b);
    items.push(b);
    return b;
  }
  addItem('settings', 'Settings', 'Ctrl ,', function() { closePopover(); openSettingsModal(null, pill); });
  addItem(currentTheme() === 'light' ? 'moon' : 'sun', currentTheme() === 'light' ? 'Dark theme' : 'Light theme', '', function() {
    toggleTheme();
    closePopover();
    pill.focus();
  });
  var src = tokenSource();
  addItem('key-round', 'Web token', src === 'served' ? 'served' : src === 'tab' ? 'this tab' : 'not set', function() {
    closePopover();
    openSettingsModal('token', pill);
  });
  addItem(isMuted ? 'volume-x' : 'volume-2', isMuted ? 'Sounds off' : 'Sounds on', '', function(b) {
    isMuted = !isMuted;
    localStorage.setItem('joind-muted', JSON.stringify(isMuted));
    updateMuteBtn();
    b.querySelector('span:not(.menu-ico)').textContent = isMuted ? 'Sounds off' : 'Sounds on';
    b.setAttribute('aria-checked', isMuted ? 'false' : 'true');
  });
  var soundItem = items[items.length - 1];
  soundItem.setAttribute('role', 'menuitemcheckbox');
  soundItem.setAttribute('aria-checked', isMuted ? 'false' : 'true');
  var sep = document.createElement('div');
  sep.className = 'menu-sep';
  sep.setAttribute('role', 'separator');
  pop.appendChild(sep);
  // Sign out asks once, in place: the first press turns the item into the
  // confirmation, the second signs out.
  addItem('log-out', 'Sign out', '', function(b) {
    if (b.getAttribute('data-confirm') === 'yes') { signOut(); return; }
    b.setAttribute('data-confirm', 'yes');
    b.lastChild.textContent = 'Press again to sign out';
    b.setAttribute('aria-label', 'Press again to sign out of this tab; the web token is cleared');
  }, 'danger');

  pop.addEventListener('keydown', function(e) {
    var at = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      var next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
      items[next].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      items[e.key === 'Home' ? 0 : items.length - 1].focus();
    } else if (e.key === 'Tab') {
      // Leaving the menu: close it and hand focus back to the avatar (the
      // menu sits at the end of the page, so native Tab order from a
      // removed item has nowhere sensible to go).
      e.preventDefault();
      closePopover();
      pill.focus();
    }
  });

  document.body.appendChild(pop);
  if (window.lucide) lucide.createIcons({ root: pop });
  if (!isMobileView()) {
    var rect = pill.getBoundingClientRect();
    var pr = pop.getBoundingClientRect();
    var left = rect.right + 8;
    if (left + pr.width > window.innerWidth - 8) left = window.innerWidth - pr.width - 8;
    var top = Math.min(window.innerHeight - pr.height - 8, rect.bottom - pr.height);
    pop.style.left = Math.max(8, left) + 'px';
    pop.style.top = Math.max(8, top) + 'px';
  }
  openPopover = pop;
  popoverAnchor = pill;
  pill.setAttribute('aria-expanded', 'true');
  popoverOnClose = function() { pill.setAttribute('aria-expanded', 'false'); };
  items[0].focus();
}

// --- Sign out: clear this tab's web token and stop the socket ---
var signedOut = false;
function signOut() {
  var served = !!window.__JOIND_TOKEN;
  signedOut = true;
  try { sessionStorage.removeItem('joind-web-token'); } catch (e) { /* storage unavailable */ }
  window.__JOIND_TOKEN = '';
  closePopover();
  closeSettingsModal(false);
  closeSidePanel(false);
  // Panels and dialogs that live outside the app element go too: the
  // signed-out screen makes only the app inert.
  if (notifyPanelOpen) closeNotifyPanel();
  if (decisionsPanelOpen) closeDecisionsPanel();
  closeCrewPanel();
  closeLaunchDialog();
  closeMobileDrawer();
  // Background polls stop; their callbacks also check signedOut, so a
  // reply already in flight cannot touch the page.
  clearInterval(sessionStatusInterval);
  clearInterval(membersTick);
  if (autoScanInterval) { clearInterval(autoScanInterval); autoScanInterval = null; }
  document.querySelectorAll('.session-modal-overlay, .notify-panel-overlay, .crew-panel-overlay, .launch-dialog-overlay').forEach(function(el) { el.remove(); });
  if (ws) { try { ws.close(); } catch (e) { /* already closed */ } }
  showSignedOut(served);
}

function showSignedOut(served) {
  var old = document.getElementById('signed-out');
  if (old) old.remove();
  var overlay = document.createElement('div');
  overlay.className = 'signed-out-overlay';
  overlay.id = 'signed-out';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'signed-out-title');
  var box = document.createElement('div');
  box.className = 'signed-out-box';
  var title = document.createElement('h2');
  title.className = 'signed-out-title';
  title.id = 'signed-out-title';
  title.textContent = 'Signed out';
  var text = document.createElement('p');
  text.className = 'signed-out-text';
  text.textContent = served
    ? 'The web token is cleared from this tab and the connection is closed. This Joind serves its token to the page, so signing in again reloads it.'
    : 'The web token is cleared from this tab and the connection is closed. Enter the token again to sign in.';
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-primary';
  btn.textContent = 'Sign in';
  btn.addEventListener('click', function() {
    if (served) { location.reload(); return; }
    overlay.remove();
    promptWebToken(function() { location.reload(); });
  });
  box.appendChild(title);
  box.appendChild(text);
  box.appendChild(btn);
  overlay.appendChild(box);
  // The app behind is out of reach (inert: no focus, no clicks) until the
  // page reloads, and Tab stays on the one control here.
  var app = document.querySelector('.app');
  if (app) app.inert = true;
  overlay.addEventListener('keydown', function(e) {
    if (e.key === 'Tab') { e.preventDefault(); btn.focus(); }
  });
  document.body.appendChild(overlay);
  btn.focus();
}

// --- Conversations ---
var activeConversation = null;
var conversationList = [];
var convSearchQuery = '';
var activeDm = null; // name of the agent in the direct-message view, null = channel view
var lastRenderedDayKey = null; // calendar-date key of the last rendered message (for day dividers)
var dmUnread = {}; // per-partner unread DM counts, keyed by agent name

// Overlapping conversations fetches: each takes a number, and a response is
// ignored once a newer fetch's response has been applied (its list and its
// queue snapshot are both older than what is on screen).
var convFetchSeq = 0;
var convFetchApplied = 0;

function loadConversations() {
  var myFetch = ++convFetchSeq;
  var genAtStart = pendingGeneration;
  var seqAtStart = nextPendingSeq();
  // no-store: a live list never comes from a cache, and identical GETs are
  // not serialized behind the browser's cache lock
  fetch('/api/conversations?token=' + encodeURIComponent(webToken()), { cache: 'no-store' }).then(function(r) { return r.json(); }).then(function(data) {
    if (myFetch < convFetchApplied) return; // a newer fetch already landed
    convFetchApplied = myFetch;
    activeConversation = data.active;
    conversationList = data.conversations || [];
    applyLinkPayload(data, false, genAtStart !== pendingGeneration, seqAtStart);
    renderConversationList();
  });
}

// Last-CALL-wins guard for conversation selection: without it, a slow
// response from an earlier select can land after a newer one and clobber
// the view (including any DM selection made in between).
var convSelectSeq = 0;
// Counts socket inits. An init that lands while a selection is in flight
// already painted the active room from newer data than the response.
var socketInitCount = 0;

function selectConversation(id, after) {
  var mySelect = ++convSelectSeq;
  clearRoomUnread(id);
  leavePageFor('rooms');
  historyView = null;
  jumpSeq++; // a navigation: pending message jumps must not land after it
  historyExitSeq++; // nor a pending reload of the latest page
  // Close mobile drawer if open
  if (isMobileView()) closeMobileDrawer();
  activeDm = null;
  lastRenderedDayKey = null;
  showComposerError('');
  // A reply target or draft image from another view must not leak into this channel
  clearReply();
  clearImagePreview();
  // Optimistic: immediately highlight the selected conversation + clear chat
  var meta = findConversationMeta(id);
  if (meta) {
    activeConversation = meta;
    // The previous room's task cards go at once (task ids are per room)
    resetRoomTasks(id);
    renderConversationList();
    renderDmList();
    renderPills();
    // Pins belong to the room on screen: drop the old list and fetch the
    // new room by name at once, not when the select answer lands.
    loadPins(false);
  }
  var c = document.getElementById('messages');
  c.textContent = '';
  // Show loading indicator
  var loader = document.createElement('div');
  loader.className = 'empty-state';
  loader.style.textAlign = 'center';
  loader.style.padding = '24px';
  loader.textContent = 'Loading...';
  c.appendChild(loader);

  var genAtStart = pendingGeneration;
  var seqAtStart = nextPendingSeq();
  var initsAtStart = socketInitCount;
  fetch('/api/conversations/select', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id, viewer: myName(), token: webToken() }) }).then(function(r) { return r.json(); }).then(function(data) {
      if (mySelect !== convSelectSeq) return; // superseded by a newer selection
      // A reconnect during the request re-sent init for this same room: the
      // screen already holds newer messages and queue than this response.
      // Only the snapshot is stale: room-scoped state that init does not
      // reset (the task list and panel) still switches to this room.
      if (initsAtStart !== socketInitCount && activeConversation && activeConversation.id === id) {
        resetRoomTasks(id);
        return;
      }
      if (data.conversation) {
        activeConversation = data.conversation;
        if (Array.isArray(data.pending) && genAtStart === pendingGeneration) {
          // A server snapshot of this room's queue replaces the local copy,
          // unless a reconnect or an eviction happened since the request
          mergePendingSnapshot(id, data.pending, true, seqAtStart);
        }
        allMessages = (data.messages || []).slice();
        agents = data.agents || [];
        agentsConv = data.conversation.id;
        onlineNames = new Set(agents.map(function(a) { return a.name; }));
        renderPills();
        renderChannelView();
        // Refresh tasks for the new conversation
        resetRoomTasks(activeConversation.id);
        if (typeof after === 'function' && activeConversation.id === id) after();
      }
    });
}

function newConversation() {
  fetch('/api/conversations/new', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}) }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.conversation) {
        selectConversation(data.conversation.id);
      }
    });
}

function showNoConversation() {
  var c = document.getElementById('messages');
  c.textContent = '';
  var empty = document.createElement('div');
  empty.className = 'welcome-message';
  empty.id = 'welcome';
  empty.innerHTML = '<div class="welcome-glyph"><span class="welcome-hex">&#x2B22;</span></div>' +
    '<h2>Joind</h2>' +
    '<p class="welcome-sub">Select a conversation or start a new one</p>';
  c.appendChild(empty);
  agents = [];
  agentsConv = null;
  renderPills();
}

function renderConversationList() {
  refreshPalette();
  var list = document.getElementById('conversation-list');
  var activeEl = document.getElementById('active-session');
  list.textContent = '';

  // Active conversation indicator
  if (activeConversation) {
    activeEl.textContent = activeConversation.name;
    activeEl.className = 'active-session';
    activeEl.title = 'Click to rename';
    activeEl.onclick = function() {
      // Remote rooms are administered on their home server only
      if (isRemoteConversation(activeConversation.id)) return;
      customPrompt('Rename conversation:', activeConversation.name, function(newName) {
        if (newName && newName !== activeConversation.name) {
          fetch('/api/conversations/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: activeConversation.id, name: newName }) }).then(function() { loadConversations(); });
        }
      });
    };
  } else {
    activeEl.textContent = 'No conversation selected';
    activeEl.className = 'active-session empty';
    activeEl.onclick = null;
  }
  syncChannelHeader();
  renderRemoteSections();

  // Filter
  var items = conversationList;
  if (convSearchQuery) {
    var q = convSearchQuery.toLowerCase();
    items = items.filter(function(c) { return c.name.toLowerCase().indexOf(q) >= 0; });
  }

  if (items.length === 0) {
    var empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = convSearchQuery ? 'No matches' : 'No conversations yet';
    list.appendChild(empty);
    return;
  }

  items.forEach(function(conv) {
    var li = document.createElement('li');
    li.className = 'conversation-item' + (activeConversation && conv.id === activeConversation.id ? ' active' : '');

    // Star indicator
    if (conv.starred) {
      var star = document.createElement('span');
      star.className = 'conv-star';
      star.textContent = '\u2605';
      li.appendChild(star);
    }

    var name = document.createElement('span');
    name.className = 'conv-name';
    name.textContent = conv.name;

    var count = document.createElement('span');
    count.className = 'conv-count';
    count.textContent = conv.messageCount || '';

    // Three-dot menu button
    var menuBtn = document.createElement('button');
    menuBtn.className = 'conv-menu-btn';
    menuBtn.textContent = '\u22EE';
    menuBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      showConvMenu(e, conv);
    });

    li.appendChild(name);
    li.appendChild(count);
    li.appendChild(menuBtn);
    decorateRoomRow(li, conv, false);

    // Click to select
    li.addEventListener('click', function() {
      selectConversation(conv.id);
    });

    list.appendChild(li);
  });
}

// --- Direct messages ---
function myName() {
  var el = document.getElementById('sender-name');
  return (el && el.value) || 'human';
}

// Messages that belong to the current view: in DM view, targeted messages
// between the user and activeDm; in channel view, public messages only.
function currentViewMessages(msgs) {
  if (activeDm) {
    var me = myName();
    return msgs.filter(function(m) {
      return (m.sender === activeDm && m.to && m.to.indexOf(me) >= 0) ||
             (m.sender === me && m.to && m.to.indexOf(activeDm) >= 0);
    });
  }
  return msgs.filter(function(m) { return !m.to; });
}

function messageInCurrentView(m) {
  if (activeDm) {
    var me = myName();
    return (m.sender === activeDm && m.to && m.to.indexOf(me) >= 0) ||
           (m.sender === me && m.to && m.to.indexOf(activeDm) >= 0);
  }
  return !m.to;
}

// Partners with DM history anywhere, fetched once and kept fresh on DM
// arrivals: the mailbox list must not depend on which channel is open.
var dmPartnersCache = [];
function fetchDmPartners() {
  fetch('/api/dms?token=' + encodeURIComponent(webToken()))
    .then(function(r) { return r.json(); })
    .then(function(d) {
      // Union with partners discovered over the socket while this was in flight
      var fetched = (d && d.partners) ? d.partners.map(function(p) { return p.partner; }) : [];
      dmPartnersCache.forEach(function(p) { if (fetched.indexOf(p) < 0) fetched.push(p); });
      dmPartnersCache = fetched;
      renderDmList();
    }).catch(function() {});
}

function renderDmList() {
  renderRailDmBadge();
  refreshPalette();
  var list = document.getElementById('dm-list');
  if (!list) return;
  // Presence changes rebuild the list: keyboard focus stays on its row.
  var focusedDm = document.activeElement && list.contains(document.activeElement) ? document.activeElement.getAttribute('data-dm') : null;
  list.textContent = '';
  var me = myName();
  var names = [];
  agents.forEach(function(a) {
    if (names.indexOf(a.name) < 0) names.push(a.name);
  });
  // Anyone with DM history in ANY conversation, even if offline
  dmPartnersCache.forEach(function(p) {
    if (p !== me && names.indexOf(p) < 0) names.push(p);
  });
  // Surface anyone who targeted (or was targeted by) the user, even if offline
  allMessages.forEach(function(m) {
    if (!m.to) return;
    var other = null;
    if (m.sender === me) {
      for (var i = 0; i < m.to.length; i++) {
        if (m.to[i] !== me) { other = m.to[i]; break; }
      }
    } else if (m.to.indexOf(me) >= 0) {
      other = m.sender;
    }
    if (other && names.indexOf(other) < 0) names.push(other);
  });
  if (names.length === 0) {
    var empty = document.createElement('li');
    empty.className = 'empty-state';
    empty.textContent = 'No agents connected';
    list.appendChild(empty);
    return;
  }
  var dmNow = serverNow();
  names.forEach(function(name) {
    var unread = dmUnread[name] || 0;
    var li = document.createElement('li');
    li.className = 'dm-item' + (activeDm === name ? ' active' : '') + (unread > 0 ? ' dm-unread' : '');
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('data-dm', name);
    if (activeDm === name) li.setAttribute('aria-current', 'true');

    // As in A: the avatar carries the presence dot, the state sits right.
    var st = presenceOf(name, dmNow);
    var av = presenceAvatar(name, 'xs', st.cls);
    av.classList.add('dm-avatar');

    var nm = document.createElement('span');
    nm.className = 'dm-name';
    nm.textContent = name;

    li.appendChild(av);
    li.appendChild(nm);
    li.title = name + ', ' + st.short;
    if (unread > 0) {
      var badge = document.createElement('span');
      badge.className = 'dm-unread-count';
      badge.textContent = unread;
      li.appendChild(badge);
    } else {
      var meta = document.createElement('span');
      meta.className = 'dm-meta';
      meta.textContent = st.short;
      li.appendChild(meta);
    }
    li.addEventListener('click', function() { selectDm(name); });
    li.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectDm(name);
      }
    });
    list.appendChild(li);
    if (focusedDm === name) li.focus();
  });
}

// The open mailbox thread: fetched from the server, spans EVERY
// conversation (a mailbox means everything with that person, not just
// what the active channel happens to hold). Guarded latest-wins like the
// other fetch surfaces.
var dmThread = [];
var dmFetchSeq = 0;

function dmKey(m) { return (m.conversationId || '') + ':' + m.id; }

// Union two thread slices by (conversationId, id), ordered by time then id.
function mergeDmThread(existing, incoming) {
  var byKey = {};
  existing.forEach(function(m) { byKey[dmKey(m)] = m; });
  incoming.forEach(function(m) { byKey[dmKey(m)] = m; });
  return Object.keys(byKey).map(function(k) { return byKey[k]; })
    .sort(function(a, b) { return (a.timestamp - b.timestamp) || (a.id - b.id); });
}

function selectDm(name) {
  leavePageFor('dms');
  activeDm = name;
  jumpSeq++; // a navigation: pending message jumps must not land after it
  historyExitSeq++; // nor a pending reload of the latest page
  renderHistoryChrome();
  delete dmUnread[name];
  showComposerError('');
  dmThread = [];
  lastSender = null;
  lastRenderedDayKey = null;
  // A reply target or draft image from another view must not leak into this DM
  clearReply();
  clearImagePreview();
  // Close mobile drawer if open
  if (isMobileView()) closeMobileDrawer();
  renderConversationList();
  renderDmList();
  syncChannelHeader();
  refreshDmThread(name);
  syncInputPlaceholder();
  document.getElementById('message-input').focus();
}

// Fetch (or refetch) the open mailbox's thread and repaint the pane. Does
// not touch composer state, so a reconnect mid-draft loses nothing.
function refreshDmThread(name) {
  var c = document.getElementById('messages');
  c.textContent = '';
  var loader = document.createElement('div');
  loader.className = 'empty-state';
  loader.style.textAlign = 'center';
  loader.style.padding = '24px';
  loader.textContent = 'Loading...';
  c.appendChild(loader);
  var mySeq = ++dmFetchSeq;
  fetch('/api/dms?with=' + encodeURIComponent(name) + '&token=' + encodeURIComponent(webToken()))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (mySeq !== dmFetchSeq || activeDm !== name) return; // superseded
      // Merge the snapshot with anything that arrived over the socket while
      // the fetch was in flight: union by (conversation, id), then order.
      dmThread = mergeDmThread(dmThread, data.messages || []);
      var cc = document.getElementById('messages');
      cc.textContent = '';
      lastSender = null;
      lastRenderedDayKey = null;
      if (dmThread.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.style.textAlign = 'center';
        empty.style.padding = '24px';
        empty.textContent = 'No messages with ' + name + ' yet. Say something.';
        cc.appendChild(empty);
      } else {
        dmThread.forEach(function(m) { appendMessage(m, false); });
      }
      renderPendingForActive();
      scrollToBottom();
    }).catch(function() {});
}

// Render the channel view from the already-loaded allMessages/agents state.
// Shared by the conversation-select fetch handler and view switches that
// return from a DM (e.g. opening a channel message from search results).
// Bumped on every channel render so late navigation (the decisions panel's
// jump) can tell when a conversation switch has fully landed.
var channelRenderStamp = 0;
// A decisions-panel jump hands its DM intent to the render itself: the
// render that lands FOR THE JUMP'S CONVERSATION consumes it, so no timer
// ever guesses whether a load is still pending. Newer jumps replace older
// ones; a deadline expires strays.
var pendingDmJump = null;
function renderChannelView() {
  channelRenderStamp++;
  if (activeConversation) clearRoomUnread(activeConversation.id);
  if (pendingDmJump) {
    var j = pendingDmJump;
    if (Date.now() > j.deadline) {
      pendingDmJump = null;
    } else if (activeConversation && activeConversation.id === j.conv) {
      pendingDmJump = null;
      setTimeout(function() {
        // Revalidate at execution time: a newer user navigation between the
        // render and this tick wins over the jump.
        if (!activeConversation || activeConversation.id !== j.conv) return;
        if (j.to) selectDm(j.to);
        scrollToMessageWhenReady(j.msgId, 10);
      }, 0);
    }
  }
  activeDm = null;
  dmThread = [];
  lastSender = null;
  lastRenderedDayKey = null;
  clearReply();
  clearImagePreview();
  var c = document.getElementById('messages');
  c.textContent = '';
  currentViewMessages(allMessages).forEach(function(m) { appendMessage(m, false); });
  var inHistory = historyView && activeConversation && historyView.conv === activeConversation.id;
  if (!inHistory) {
    renderPendingForActive();
    if (allMessages.length > 0) scrollToBottom();
  }
  renderHistoryChrome();
  renderConversationList();
  renderDmList();
  syncInputPlaceholder();
}

// Channel header spans, kept in sync with the active-session indicator
function syncChannelHeader() {
  var title = document.getElementById('channel-title');
  var topic = document.getElementById('channel-topic');
  if (!title || !topic) return;
  // Presence lives on the members button now (its count lists everyone the
  // panel does), so the topic no longer says "0 member(s)" in a room whose
  // agents are simply not connected.
  if (pageNow === 'crew') {
    title.textContent = 'Crew';
    topic.textContent = 'Presence, terminals and sessions';
  } else if (pageNow === 'decisions') {
    title.textContent = 'Decisions';
    topic.textContent = 'Asks with choices, across rooms';
  } else if (pageNow === 'tasks') {
    title.textContent = 'Tasks';
    topic.textContent = 'All local rooms';
  } else if (activeDm) {
    title.textContent = activeDm;
    // As in A: the partner's harness and state under a DM's title.
    var dst = presenceOf(activeDm);
    var dh = harnessOf(activeDm);
    topic.textContent = (dh ? dh + ', ' : '') + dst.short + ', direct message';
  } else if (activeConversation) {
    title.textContent = '# ' + activeConversation.name;
    var server = remoteServerOf(activeConversation.id);
    topic.textContent = '';
    if (server) appendRemoteHeaderState(topic, server);
  } else {
    title.textContent = '#';
    topic.textContent = '';
  }
  // A DM shows the partner's avatar before the title.
  var oldAv = document.getElementById('dm-head-avatar');
  if (oldAv) oldAv.remove();
  if (activeDm && !pageNow) {
    var hav = presenceAvatar(activeDm, 'head', presenceOf(activeDm).cls);
    hav.id = 'dm-head-avatar';
    hav.setAttribute('aria-hidden', 'true');
    title.parentNode.insertBefore(hav, title);
  }
  syncConvTools();
  syncLinkHint();
  syncInputPlaceholder();
}

// The toolbar follows the view: members and pins belong to a room, so a
// DM (a cross-room mailbox) hides them and closes the side panel.
function syncConvTools() {
  var tools = document.getElementById('conv-tools');
  if (tools) tools.hidden = !!pageNow;
  var inRoom = !!activeConversation && !activeDm && !pageNow;
  document.querySelectorAll('.conv-tools .room-only').forEach(function(el) { el.hidden = !inRoom; });
  if (!inRoom && sidePanelTab) closeSidePanel(false);
  var label = document.getElementById('room-search-label');
  if (label) label.textContent = activeDm ? 'Search in DM' : activeConversation ? 'Search in #' + activeConversation.name : 'Search this room';
  if (inRoom && pinsState.conv !== activeConversation.id) loadPins(false);
}

// ============================================================
// Linked servers. A remote room lives on a peer (its home server)
// and is mirrored here under the id "<server>:<room>". That id is
// used unchanged by every existing call (select, read, send, bell,
// DMs), so the room behaves like a local one. This module adds only
// what is new: the "remote: <server>" groups in the channel list,
// the link state in the header and composer, and the undelivered
// queue (pending messages) of the viewer.
// ============================================================

var links = []; // [{ name, state: 'up' | 'down', since }]
var remoteConversations = []; // [{ id, server, name, messageCount, starred, state }]
// Undelivered messages per remote room, in queue order:
// { clientId, sender, text, queuedAt, to?, state?, reason? } where `to`
// marks a queued DM and state is undefined (queued), 'waiting' (its author
// has no live registration at home yet) or 'held' (home refused it; the
// reason says why)
var pendingByConv = {};
// clientId -> { conv, id } for dispatched entries whose real message has
// not been rendered yet; the row stays until that message lands.
var pendingAwaiting = {};
var PENDING_AWAIT_MS = 15000;
// Settlement ledger, clientId -> { kind: 'state' | 'dispatched' | 'deleted',
// seq, t }. WebSocket events are ordered and authoritative; HTTP snapshots
// (a 202, a select or conversations fetch) may be older than events already
// applied, so they consult this before touching an entry.
//
// Ordering uses pendingSeq, a counter local to this page, stamped on every
// event as it arrives and on every request as it starts. It never reads a
// clock, so a clock-offset change on reconnect cannot reorder anything.
// `t` (performance.now(), monotonic) serves only the age-based expiry.
//
// Two Maps, each kept in recency order (an update re-inserts its key), so
// the oldest record is always first and trimming stops at the first record
// it keeps; every update is a direct keyed operation.
//   settledLedger: dispatched or deleted. Exempt from the count cap, expired
//     only by age, so a live-state flood can never evict the record that
//     stops an old snapshot resurrecting a delivered entry.
//   stateLedger: the latest live state. Capped at the newest 500, and also
//     expired by age.
//
// pendingGeneration moves on every socket init and on every trim pass that
// evicts anything. Each HTTP request notes it at start; a response that
// comes back in a newer generation is ignored for pending state, because
// the socket already carries the truth and the records that would have
// judged the snapshot may be gone.
var pendingSeq = 0;
function nextPendingSeq() { pendingSeq += 1; return pendingSeq; }
var pendingGeneration = 0;
function bumpPendingGeneration() { pendingGeneration += 1; }
var settledLedger = new Map();
var stateLedger = new Map();
var PENDING_LEDGER_TTL_MS = 30 * 60 * 1000;
var PENDING_LEDGER_MAX = 500;

function monotonicNow() {
  return (window.performance && typeof performance.now === 'function') ? performance.now() : 0;
}

function ledgerGet(clientId) {
  if (!clientId) return undefined;
  return settledLedger.get(clientId) || stateLedger.get(clientId);
}

function isSettledKind(rec) {
  return !!rec && (rec.kind === 'dispatched' || rec.kind === 'deleted');
}

// Record what is known about an entry. `seq` defaults to a fresh stamp (an
// event arriving now); a 202 passes the stamp its request took at start.
function notePendingLedger(clientId, kind, seq) {
  if (!clientId) return;
  var prev = ledgerGet(clientId);
  // A final outcome is never downgraded back to a live state
  if (isSettledKind(prev) && kind === 'state') return;
  var stamp = seq == null ? nextPendingSeq() : seq;
  // Never move a record backwards: a stale stamp keeps the newer one
  if (prev && prev.seq > stamp && prev.kind === kind) stamp = prev.seq;
  var rec = { kind: kind, seq: stamp, t: monotonicNow() };
  if (kind === 'state') {
    stateLedger.delete(clientId);
    stateLedger.set(clientId, rec);
  } else {
    stateLedger.delete(clientId);
    settledLedger.delete(clientId);
    settledLedger.set(clientId, rec);
  }
  trimPendingLedger();
}

// Trim from the oldest record; any eviction starts a new generation.
function trimPendingLedger() {
  var cutoff = monotonicNow() - PENDING_LEDGER_TTL_MS;
  var evicted = trimLedgerMap(settledLedger, Infinity, cutoff) +
    trimLedgerMap(stateLedger, PENDING_LEDGER_MAX, cutoff);
  if (evicted > 0) bumpPendingGeneration();
}

function trimLedgerMap(map, max, cutoff) {
  var evicted = 0;
  var it = map.keys();
  for (var step = it.next(); !step.done; step = it.next()) {
    if (map.size <= max && map.get(step.value).t >= cutoff) break;
    map.delete(step.value);
    evicted += 1;
  }
  return evicted;
}

// Whether an HTTP snapshot whose request started at `seq` may still create
// or restate the entry: not once it was dispatched or deleted, and not over
// a state that an event set after the request started.
function pendingSnapshotIsCurrent(clientId, seq) {
  var rec = ledgerGet(clientId);
  if (!rec) return true;
  if (isSettledKind(rec)) return false;
  return rec.seq < seq;
}

// Replace the queue (all rooms when conv is null, else one room) with a
// snapshot. Dispatched or deleted entries are never resurrected. With
// keepKnown (HTTP snapshots) an entry already known here keeps its current
// state, since the WebSocket may have applied newer events than the
// snapshot. Without it (init, which arrives in order on the socket) the
// snapshot is the newest truth and replaces the known state.
//
// sinceSeq (HTTP snapshots): the page-local stamp taken when the request
// started. A known entry missing from the snapshot is dropped only if
// nothing newer than the request vouches for it; an entry whose latest
// event or 202 is stamped after the request started was queued after the
// server took the snapshot, so it stays.
function mergePendingSnapshot(conv, list, keepKnown, sinceSeq) {
  var previous = {};
  Object.keys(pendingByConv).forEach(function(c) {
    if (conv !== null && c !== conv) return;
    pendingByConv[c].forEach(function(x) { previous[x.clientId] = { conv: c, entry: x }; });
  });
  if (conv === null) pendingByConv = {};
  else delete pendingByConv[conv];
  var listed = {};
  // HTTP snapshots stamp what they list with the moment they are applied,
  // so a snapshot whose request started earlier (another kind of fetch)
  // cannot drop an entry this one confirmed.
  var applySeq = sinceSeq == null ? null : nextPendingSeq();
  list.forEach(function(p) {
    if (!p || !p.clientId) return;
    listed[p.clientId] = true;
    if (isSettledKind(ledgerGet(p.clientId))) return;
    // The socket's snapshot is an event arriving now: stamp it, so a 202
    // whose request predates the reconnect cannot restate the entry.
    if (!keepKnown) notePendingLedger(p.clientId, 'state');
    else if (applySeq != null) notePendingLedger(p.clientId, 'state', applySeq);
    var known = keepKnown && previous[p.clientId];
    addPendingEntry(conv === null ? p.conversationId : conv, known ? known.entry : p);
  });
  if (sinceSeq == null) return;
  Object.keys(previous).forEach(function(clientId) {
    if (listed[clientId]) return;
    var rec = ledgerGet(clientId);
    if (rec && rec.kind === 'state' && rec.seq > sinceSeq) {
      addPendingEntry(previous[clientId].conv, previous[clientId].entry);
    }
  });
}

// Bring the visible pending rows in line with the queue after a snapshot
// that does not repaint the pane (the conversations fetch): drop rows whose
// entry is gone (rows already dispatched and awaiting their real message
// stay), then add rows for entries now visible.
function reconcilePendingRows() {
  var els = document.querySelectorAll('.message.pending');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (el.classList.contains('dispatched')) continue;
    var list = pendingByConv[el.dataset.conv] || [];
    var id = el.dataset.clientId;
    if (!list.some(function(x) { return x.clientId === id; })) el.remove();
  }
  renderPendingForActive();
}

// Accept links, remote rooms and (optionally) queued messages from any
// payload that carries them: init (fromSocket) and /api/conversations.
// skipPending: the response predates the current generation, so its
// queue snapshot is ignored (links and rooms still apply).
// sinceSeq: for an HTTP response, the stamp taken when its request started.
function applyLinkPayload(data, fromSocket, skipPending, sinceSeq) {
  if (!data) return;
  if (Array.isArray(data.links)) links = data.links.slice();
  if (Array.isArray(data.remoteConversations)) remoteConversations = data.remoteConversations.slice();
  if (Array.isArray(data.pending) && !skipPending) {
    mergePendingSnapshot(null, data.pending, !fromSocket, fromSocket ? null : sinceSeq);
    // init repaints the pane itself; an HTTP snapshot does not
    if (!fromSocket) reconcilePendingRows();
  }
}

function linkByName(name) {
  for (var i = 0; i < links.length; i++) {
    if (links[i].name === name) return links[i];
  }
  return null;
}

function remoteMetaById(id) {
  for (var i = 0; i < remoteConversations.length; i++) {
    if (remoteConversations[i].id === id) return remoteConversations[i];
  }
  return null;
}

// The home server of a conversation id, or null for a local room. Local
// ids look like "c-2026-09-25T..." and never start with a configured link
// name plus a colon, so the prefix test is safe before the list loads.
function remoteServerOf(id) {
  if (!id) return null;
  var meta = remoteMetaById(id);
  if (meta) return meta.server;
  var colon = id.indexOf(':');
  if (colon > 0 && linkByName(id.slice(0, colon))) return id.slice(0, colon);
  return null;
}

function isRemoteConversation(id) { return remoteServerOf(id) !== null; }

function findConversationMeta(id) {
  var local = conversationList.find(function(c) { return c.id === id; });
  return local || remoteMetaById(id);
}

// Link state for a server: the link entry wins, the room's own state is
// the fallback, and an unknown server counts as down.
function linkStateOf(server) {
  var link = linkByName(server);
  if (link) return link;
  var room = remoteConversations.find(function(c) { return c.server === server; });
  return { name: server, state: room && room.state === 'up' ? 'up' : 'down', since: null };
}

// `since` may be epoch milliseconds or an ISO string.
function formatLinkSince(since) {
  if (since == null || since === '') return '';
  var d = new Date(since);
  if (isNaN(d.getTime())) return '';
  var sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? formatTimeShort(d.getTime())
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + formatTimeShort(d.getTime());
}

function linkBadge(state) {
  var badge = document.createElement('span');
  badge.className = 'link-badge ' + (state === 'up' ? 'up' : 'down');
  badge.textContent = state === 'up' ? 'linked' : 'link down';
  return badge;
}

// One group per link (plus any server that only appears in the room list),
// rendered below the local channels. Local rooms are untouched.
function renderRemoteSections() {
  var host = document.getElementById('remote-sections');
  if (!host) return;
  host.textContent = '';
  var servers = [];
  links.forEach(function(l) { if (servers.indexOf(l.name) < 0) servers.push(l.name); });
  remoteConversations.forEach(function(c) { if (servers.indexOf(c.server) < 0) servers.push(c.server); });
  var q = convSearchQuery ? convSearchQuery.toLowerCase() : '';

  servers.forEach(function(server) {
    var link = linkStateOf(server);
    var down = link.state !== 'up';
    var rooms = remoteConversations.filter(function(c) { return c.server === server; });
    if (q) rooms = rooms.filter(function(c) { return c.name.toLowerCase().indexOf(q) >= 0; });
    if (q && rooms.length === 0) return;

    var group = document.createElement('div');
    group.className = 'remote-section' + (down ? ' link-down' : '');
    group.dataset.server = server;

    // Its own collapsible section (lane 4): the same header as Rooms, keyed
    // by server so the collapse is remembered.
    var heading = document.createElement('div');
    heading.className = 'remote-heading section-header';
    heading.setAttribute('data-sec', 'remote:' + server);
    heading.addEventListener('click', function() { toggleSection(heading); });
    var since = formatLinkSince(link.since);
    heading.title = (down ? 'Link down' : 'Linked') + (since ? ' since ' + since : '') +
      (down ? '. Messages you send to these rooms will queue.' : '');
    var icon = document.createElement('i');
    icon.setAttribute('data-lucide', down ? 'unlink' : 'link');
    icon.setAttribute('width', '12');
    icon.setAttribute('height', '12');
    icon.setAttribute('aria-hidden', 'true');
    var label = document.createElement('span');
    label.className = 'remote-heading-label';
    label.textContent = 'remote: ' + server;
    var h2 = document.createElement('h2');
    var arrow = document.createElement('span');
    arrow.className = 'section-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    var chev = document.createElement('i');
    chev.setAttribute('data-lucide', 'chevron-down');
    chev.setAttribute('width', '12');
    chev.setAttribute('height', '12');
    arrow.appendChild(chev);
    h2.appendChild(arrow);
    h2.appendChild(icon);
    h2.appendChild(label);
    h2.appendChild(linkBadge(link.state));
    heading.appendChild(h2);
    group.appendChild(heading);

    var ul = document.createElement('ul');
    ul.className = 'conversation-list remote-list';
    if (rooms.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'empty-state';
      empty.textContent = down ? 'Unreachable' : 'No rooms';
      ul.appendChild(empty);
    }
    rooms.forEach(function(conv) {
      var li = document.createElement('li');
      li.className = 'conversation-item remote' + (down ? ' link-down' : '') +
        (activeConversation && conv.id === activeConversation.id ? ' active' : '');
      li.title = conv.name + ' on ' + server + (down ? ' (link down)' : '');
      if (conv.starred) {
        var star = document.createElement('span');
        star.className = 'conv-star';
        star.textContent = '★';
        li.appendChild(star);
      }
      var name = document.createElement('span');
      name.className = 'conv-name';
      name.textContent = conv.name;
      li.appendChild(name);
      var queued = (pendingByConv[conv.id] || []).length;
      if (queued > 0) {
        var qBadge = document.createElement('span');
        qBadge.className = 'conv-queued';
        qBadge.textContent = queued + ' queued';
        li.appendChild(qBadge);
      }
      var count = document.createElement('span');
      count.className = 'conv-count';
      count.textContent = conv.messageCount || '';
      li.appendChild(count);
      // No menu: star, rename and delete belong to the home server.
      li.addEventListener('click', function() { selectConversation(conv.id); });
      decorateRoomRow(li, conv, true);
      ul.appendChild(li);
    });
    var body = document.createElement('div');
    body.className = 'section-body';
    body.appendChild(ul);
    group.appendChild(body);
    host.appendChild(group);
    prepareSectionHeader(heading);
  });
  if (window.lucide) lucide.createIcons({ root: host });
}

// Header suffix for a remote room: home server and link state with since.
function appendRemoteHeaderState(topic, server) {
  var link = linkStateOf(server);
  var since = formatLinkSince(link.since);
  var wrap = document.createElement('span');
  wrap.className = 'remote-header-state' + (link.state === 'up' ? '' : ' link-down');
  wrap.appendChild(document.createTextNode('on ' + server + ' '));
  var badge = linkBadge(link.state);
  badge.textContent = (link.state === 'up' ? 'up' : 'down') + (since ? ' since ' + since : '');
  badge.title = (link.state === 'up' ? 'Linked' : 'Link down') + (since ? ' since ' + since : '');
  wrap.appendChild(badge);
  topic.appendChild(wrap);
}

// One-line hint above the composer while the active remote room's link is
// down. The composer itself stays enabled: sends queue on the server.
function syncLinkHint() {
  var hint = document.getElementById('link-hint');
  if (!hint) return;
  var server = (!activeDm && activeConversation) ? remoteServerOf(activeConversation.id) : null;
  var link = server ? linkStateOf(server) : null;
  if (!link || link.state === 'up') {
    hint.hidden = true;
    hint.textContent = '';
    return;
  }
  hint.textContent = 'Link to ' + server + ' is down. Messages you send here will queue and go out when it returns.';
  hint.hidden = false;
}

function onLinkEvent(data) {
  if (!data || !data.name) return;
  var next = { name: data.name, state: data.state === 'up' ? 'up' : 'down', since: data.since };
  var found = false;
  links = links.map(function(l) {
    if (l.name !== data.name) return l;
    found = true;
    return next;
  });
  if (!found) links.push(next);
  remoteConversations.forEach(function(c) { if (c.server === data.name) c.state = next.state; });
  renderConversationList(); // also refreshes the header and the composer hint
}

// Pending payloads carry conversationId in data; the envelope's
// conversationId (the convention of every other event) is the fallback.
function pendingConvOf(event) {
  return (event.data && event.data.conversationId) || event.conversationId || null;
}

function addPendingEntry(conv, p) {
  if (!conv || !p || !p.clientId) return false;
  var list = pendingByConv[conv] || (pendingByConv[conv] = []);
  var existing = list.find(function(x) { return x.clientId === p.clientId; });
  if (existing) {
    // A repeat for a known entry updates its state (queued, waiting, held)
    var nextState = pendingStateOf(p);
    var nextReason = p.reason || p.heldReason;
    if (existing.state === nextState && existing.reason === nextReason) return false;
    existing.state = nextState;
    existing.reason = nextReason;
    var shown = pendingElement(conv, p.clientId);
    if (shown) applyPendingState(shown, existing);
    return false;
  }
  var entry = { clientId: p.clientId, sender: p.sender, text: p.text, queuedAt: p.queuedAt,
    state: pendingStateOf(p), reason: p.reason || p.heldReason };
  // A queued DM keeps its recipients so it routes to the mailbox, never
  // the channel (the same view rule as a real message).
  if (Array.isArray(p.to) && p.to.length > 0) entry.to = p.to.slice();
  list.push(entry);
  return true;
}

function pendingStateOf(p) {
  return p && (p.state === 'waiting' || p.state === 'held') ? p.state : undefined;
}

var PENDING_LABELS = {
  queued: 'queued, not delivered',
  waiting: 'waiting to register at home',
  held: 'held, not delivered',
};

// Marker text, marker style and the reason line of a pending row, from its
// entry. Called on first render and whenever the state changes.
function applyPendingState(el, p) {
  var state = p.state || 'queued';
  el.classList.remove('pending-queued', 'pending-waiting', 'pending-held');
  el.classList.add('pending-' + state);
  var txt = el.querySelector('.pending-marker-text');
  if (txt && !el.classList.contains('dispatched')) txt.textContent = PENDING_LABELS[state];
  var marker = el.querySelector('.pending-marker');
  if (marker) {
    marker.title = state === 'held' ? 'The home server refused this message' + (p.reason ? ': ' + p.reason : '')
      : state === 'waiting' ? 'Goes out once its author is registered with the home server'
      : 'Goes out in order when the link is up';
  }
  var reasonEl = el.querySelector('.pending-reason');
  if (state === 'held' && p.reason) {
    if (!reasonEl) {
      reasonEl = document.createElement('div');
      reasonEl.className = 'pending-reason';
      var tw = el.querySelector('.msg-text-wrap');
      if (tw && tw.parentNode) tw.parentNode.insertBefore(reasonEl, tw.nextSibling);
    }
    reasonEl.textContent = 'Held: ' + p.reason;
  } else if (reasonEl) {
    reasonEl.remove();
  }
}

function removePendingEntry(conv, clientId) {
  var list = pendingByConv[conv];
  if (!list) return;
  pendingByConv[conv] = list.filter(function(x) { return x.clientId !== clientId; });
  if (pendingByConv[conv].length === 0) delete pendingByConv[conv];
}

// The rendered row of a real (non-pending) message, in either view.
function realMessageElement(conv, id) {
  var els = document.querySelectorAll('.message:not(.pending)');
  for (var i = 0; i < els.length; i++) {
    if (els[i].dataset.conv === conv && els[i].dataset.id === String(id)) return els[i];
  }
  return null;
}

function pendingElement(conv, clientId) {
  var els = document.querySelectorAll('.message.pending');
  for (var i = 0; i < els.length; i++) {
    if (els[i].dataset.conv === conv && els[i].dataset.clientId === clientId) return els[i];
  }
  return null;
}

// Whether a queued entry belongs on screen now. Channel view: only the
// active room's queued channel messages. Mailbox view: queued DMs of that
// mailbox from any room, since a mailbox spans conversations.
function pendingVisibleNow(conv, p) {
  if (!messageInCurrentView(p)) return false;
  if (activeDm) return true;
  return !!(activeConversation && activeConversation.id === conv);
}

function renderPendingForActive() {
  var convs = activeDm ? Object.keys(pendingByConv)
    : (activeConversation ? [activeConversation.id] : []);
  convs.forEach(function(conv) {
    (pendingByConv[conv] || []).forEach(function(p) {
      if (pendingVisibleNow(conv, p) && !pendingElement(conv, p.clientId)) appendPending(conv, p);
    });
  });
}

// An undelivered message: the shape of a message row, dimmed, with a
// queued marker. Its author, and only its author, may delete it.
function appendPending(conv, p) {
  var c = document.getElementById('messages');
  if (!c) return;
  hideWelcome();
  // An empty mailbox's "No messages yet" line gives way to a queued DM
  var emptyLine = c.querySelector(':scope > .empty-state');
  if (emptyLine) emptyLine.remove();
  var color = getSenderColor(p.sender || '');
  var el = document.createElement('div');
  el.className = 'message pending';
  el.dataset.id = '';
  el.dataset.conv = conv;
  el.dataset.clientId = p.clientId;
  el.style.setProperty('--bubble-color', color);

  var av = document.createElement('div');
  av.className = 'msg-avatar';
  av.style.background = color;
  av.style.setProperty('--avatar-color', color);
  av.textContent = (p.sender || '?').charAt(0).toUpperCase();

  var body = document.createElement('div');
  body.className = 'msg-body';
  var hdr = document.createElement('div');
  hdr.className = 'msg-header';
  var sn = document.createElement('span');
  sn.className = 'msg-sender';
  sn.style.color = color;
  sn.textContent = p.sender || '';
  var marker = document.createElement('span');
  marker.className = 'pending-marker';
  var clock = document.createElement('i');
  clock.setAttribute('data-lucide', 'clock');
  clock.setAttribute('width', '11');
  clock.setAttribute('height', '11');
  clock.setAttribute('aria-hidden', 'true');
  var markerText = document.createElement('span');
  markerText.className = 'pending-marker-text';
  markerText.textContent = 'queued, not delivered';
  marker.appendChild(clock);
  marker.appendChild(markerText);
  hdr.appendChild(sn);
  hdr.appendChild(marker);
  if (p.queuedAt != null) {
    var tm = document.createElement('span');
    tm.className = 'msg-time';
    tm.textContent = formatTime(p.queuedAt);
    hdr.appendChild(tm);
  }
  body.appendChild(hdr);
  var tw = document.createElement('div');
  tw.className = 'msg-text-wrap';
  renderContent(tw, p.text);
  body.appendChild(tw);

  if (p.sender && p.sender === myName()) {
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'pending-delete';
    del.title = 'Delete this queued message before it is sent';
    del.setAttribute('aria-label', 'Delete queued message');
    var delIcon = document.createElement('i');
    delIcon.setAttribute('data-lucide', 'trash-2');
    delIcon.setAttribute('width', '12');
    delIcon.setAttribute('height', '12');
    delIcon.setAttribute('aria-hidden', 'true');
    var delText = document.createElement('span');
    delText.textContent = 'Delete';
    del.appendChild(delIcon);
    del.appendChild(delText);
    del.addEventListener('click', function() { deletePending(conv, p.clientId, el, del); });
    body.appendChild(del);
  }

  el.appendChild(av);
  el.appendChild(body);
  applyPendingState(el, p);
  c.appendChild(el);
  lastSender = null; // a pending row never groups with the next real message
  if (window.lucide) lucide.createIcons({ root: el });
  if (autoScroll) scrollToBottom();
}

function deletePending(conv, clientId, el, btn) {
  btn.disabled = true;
  el.classList.add('deleting');
  fetch('/api/pending/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation: conv, clientId: clientId, token: webToken() }) })
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      // The pending-deleted event normally lands first; this is idempotent.
      notePendingLedger(clientId, 'deleted');
      dropPending(conv, clientId);
    })
    .catch(function() {
      // Already dispatched, or the server refused: keep the row honest.
      btn.disabled = false;
      el.classList.remove('deleting');
      btn.title = 'Could not delete: it may already have been sent';
    });
}

function dropPending(conv, clientId) {
  removePendingEntry(conv, clientId);
  delete pendingAwaiting[clientId];
  var el = pendingElement(conv, clientId);
  if (el) el.remove();
  renderRemoteSections();
}

function onPendingEvent(event) {
  var conv = pendingConvOf(event);
  var p = event.data;
  if (!conv || !p || !p.clientId) return;
  // A repeat event after dispatch or delete (a replay) must not resurrect it
  if (isSettledKind(ledgerGet(p.clientId))) return;
  applyPendingUpsert(conv, p);
}

// seq: an explicit order stamp; omitted, the entry is stamped as arriving now
function applyPendingUpsert(conv, p, seq) {
  notePendingLedger(p.clientId, 'state', seq);
  if (!addPendingEntry(conv, p)) return;
  var stored = (pendingByConv[conv] || []).find(function(x) { return x.clientId === p.clientId; });
  if (stored && pendingVisibleNow(conv, stored) && !pendingElement(conv, p.clientId)) appendPending(conv, stored);
  renderRemoteSections();
}

function onPendingDeleted(event) {
  var conv = pendingConvOf(event);
  if (!conv || !event.data || !event.data.clientId) return;
  notePendingLedger(event.data.clientId, 'deleted');
  dropPending(conv, event.data.clientId);
}

// Dispatched: the home server assigned an id and the real message arrives
// as a normal `message` event. Whichever of the two lands second removes
// the pending row, so the room never shows the message twice.
function onPendingDispatched(event) {
  var conv = pendingConvOf(event);
  var d = event.data;
  if (!conv || !d || !d.clientId) return;
  notePendingLedger(d.clientId, 'dispatched');
  removePendingEntry(conv, d.clientId);
  renderRemoteSections();
  var el = pendingElement(conv, d.clientId);
  if (!el) return;
  if (d.id != null && realMessageElement(conv, d.id)) { el.remove(); return; }
  el.classList.add('dispatched');
  var txt = el.querySelector('.pending-marker-text');
  if (txt) txt.textContent = 'sending';
  var btn = el.querySelector('.pending-delete');
  if (btn) btn.remove();
  pendingAwaiting[d.clientId] = { conv: conv, id: d.id };
  // Safety net: a real message filtered out of this view never arrives.
  setTimeout(function() {
    if (!pendingAwaiting[d.clientId]) return;
    delete pendingAwaiting[d.clientId];
    var stale = pendingElement(conv, d.clientId);
    if (stale) stale.remove();
  }, PENDING_AWAIT_MS);
}

// Called for every message that reaches the active room: drop the pending
// row it replaces (matched by the dispatched id, or by clientId when the
// server echoes it on the message).
function settlePendingFor(conv, msg) {
  if (!conv || !msg) return;
  Object.keys(pendingAwaiting).forEach(function(clientId) {
    var w = pendingAwaiting[clientId];
    if (w.conv === conv && w.id != null && w.id === msg.id) {
      delete pendingAwaiting[clientId];
      var el = pendingElement(conv, clientId);
      if (el) el.remove();
    }
  });
  if (msg.clientId) {
    notePendingLedger(msg.clientId, 'dispatched');
    removePendingEntry(conv, msg.clientId);
    delete pendingAwaiting[msg.clientId];
    var echoed = pendingElement(conv, msg.clientId);
    if (echoed) echoed.remove();
  }
}

function showConvMenu(evt, conv) {
  closePopover();
  var pop = document.createElement('div');
  pop.className = 'conv-context-menu';
  pop.addEventListener('click', function(e) { e.stopPropagation(); });

  var actions = [
    { label: (conv.starred ? '\u2606 Unstar' : '\u2605 Star'), action: function() {
      fetch('/api/conversations/star', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: conv.id, starred: !conv.starred }) }).then(function() { loadConversations(); });
      closePopover();
    }},
    { label: '\u270E Rename', action: function() {
      closePopover();
      customPrompt('Rename:', conv.name, function(newName) {
        if (newName && newName !== conv.name) {
          fetch('/api/conversations/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: conv.id, name: newName }) }).then(function() { loadConversations(); });
        }
      });
    }},
    { label: '\u2715 Delete', danger: true, action: function() {
      if (confirm('Delete "' + conv.name + '"? This cannot be undone.')) {
        fetch('/api/conversations/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: conv.id }) }).then(function() {
            if (activeConversation && activeConversation.id === conv.id) {
              activeConversation = null;
              showNoConversation();
            }
            loadConversations();
          });
      }
      closePopover();
    }},
  ];

  actions.forEach(function(a) {
    var item = document.createElement('div');
    item.className = 'conv-menu-item' + (a.danger ? ' danger' : '');
    item.textContent = a.label;
    item.addEventListener('click', a.action);
    pop.appendChild(item);
  });

  // Position near click
  var rect = evt.target.getBoundingClientRect();
  pop.style.top = rect.bottom + 4 + 'px';
  pop.style.left = Math.min(rect.left, window.innerWidth - 140) + 'px';

  document.body.appendChild(pop);
  openPopover = pop;
}

// --- Workflow Sessions (templates) ---
var sessionTemplates = [];

function loadTemplates() {
  fetch('/api/templates').then(function(r) { return r.json(); }).then(function(tmpls) {
    sessionTemplates = tmpls;
    renderTemplates();
  });
}

function renderTemplates() {
  var list = document.getElementById('template-list');
  list.textContent = '';
  if (sessionTemplates.length === 0) {
    var e = document.createElement('div');
    e.className = 'empty-state';
    e.textContent = 'No templates loaded';
    list.appendChild(e);
    return;
  }
  // Compact rows as in A: the name, the roles and description in the
  // tooltip; a row starts the session. The Crew page shows them as cards.
  sessionTemplates.forEach(function(t) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'side-row template-row';
    row.title = (t.description ? t.description + '. ' : '') + 'Roles: ' + t.roles.join(', ') + '. Click to start.';
    var ico = document.createElement('span');
    ico.className = 'side-row-ico';
    ico.setAttribute('aria-hidden', 'true');
    ico.textContent = '≡';
    var name = document.createElement('span');
    name.className = 'side-row-name';
    name.textContent = t.name;
    row.appendChild(ico);
    row.appendChild(name);
    row.setAttribute('aria-label', 'Start session: ' + t.name);
    row.addEventListener('click', function() { startSessionUI(t); });
    list.appendChild(row);
  });
  renderCrewPage();
}

function startSessionUI(template) {
  closePopover();

  var overlay = document.createElement('div');
  overlay.className = 'session-modal-overlay';

  var modal = document.createElement('div');
  modal.className = 'session-modal';

  var title = document.createElement('div');
  title.className = 'session-modal-title';
  title.textContent = template.name;
  modal.appendChild(title);

  var desc = document.createElement('div');
  desc.className = 'session-modal-desc';
  desc.textContent = template.description;
  modal.appendChild(desc);

  // Role assignment rows with dropdowns
  var roleSelects = {};
  var online = agents.map(function(a) { return a.name; });

  template.roles.forEach(function(role, idx) {
    var row = document.createElement('div');
    row.className = 'session-modal-row';

    var label = document.createElement('label');
    label.textContent = role;

    var select = document.createElement('select');
    select.className = 'pop-select';

    // Empty option
    var emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = '-- select agent --';
    select.appendChild(emptyOpt);

    // Online agents
    online.forEach(function(name) {
      var opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });

    // Auto-assign if enough agents
    if (idx < online.length) {
      select.value = online[idx];
    }

    roleSelects[role] = select;
    row.appendChild(label);
    row.appendChild(select);
    modal.appendChild(row);
  });

  // Goal input
  var goalRow = document.createElement('div');
  goalRow.className = 'session-modal-row';
  var goalLabel = document.createElement('label');
  goalLabel.textContent = 'Goal';
  var goalInput = document.createElement('input');
  goalInput.type = 'text';
  goalInput.className = 'pop-input';
  goalInput.placeholder = 'Optional — what should the session achieve?';
  goalRow.appendChild(goalLabel);
  goalRow.appendChild(goalInput);
  modal.appendChild(goalRow);

  // Buttons
  var btnRow = document.createElement('div');
  btnRow.className = 'session-modal-btns';

  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-sm';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', function() { overlay.remove(); });

  var startBtn = document.createElement('button');
  startBtn.className = 'btn btn-send';
  startBtn.style.padding = '6px 16px';
  startBtn.style.width = 'auto';
  startBtn.style.height = 'auto';
  startBtn.style.fontSize = 'var(--fs-meta)';
  startBtn.textContent = 'Start Session';
  startBtn.addEventListener('click', function() {
    var cast = {};
    var missing = [];
    template.roles.forEach(function(role) {
      var val = roleSelects[role].value;
      if (!val) missing.push(role);
      cast[role] = val;
    });
    if (missing.length > 0) {
      alert('Please assign agents to: ' + missing.join(', '));
      return;
    }

    var sender = document.getElementById('sender-name').value || 'human';
    fetch('/api/session/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templateId: template.id,
        cast: cast,
        goal: goalInput.value.trim(),
        startedBy: sender
      })
    }).then(function(r) { return r.json(); }).then(function(session) {
      overlay.remove();
      if (session.error) {
        alert('Error: ' + session.error);
      } else {
        refreshSessionStatus();
      }
    });
  });

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(startBtn);
  modal.appendChild(btnRow);

  overlay.appendChild(modal);
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
}

function refreshSessionStatus() {
  if (signedOut) return;
  fetch('/api/sessions').then(function(r) { return r.json(); }).then(function(sessions) {
    if (signedOut) return;
    var el = document.getElementById('session-status');
    el.textContent = '';
    if (sessions.length === 0) {
      el.textContent = '';
      return;
    }
    sessions.forEach(function(s) {
      var bar = document.createElement('div');
      bar.className = 'session-bar';

      var info = document.createElement('div');
      info.className = 'session-info';
      info.textContent = s.templateName + (s.waitingFor ? ' — waiting: ' + s.waitingFor : '');

      var cancel = document.createElement('button');
      cancel.className = 'session-cancel';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', function() {
        fetch('/api/session/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: s.id })
        }).then(function() { refreshSessionStatus(); });
      });

      bar.appendChild(info);
      bar.appendChild(cancel);
      el.appendChild(bar);
    });
  });
}

// Poll session status while active (stopped on sign out)
var sessionStatusInterval = setInterval(refreshSessionStatus, 3000);

// --- Task System ---
var tasks = [];
var taskFilter = 'open';
var taskPanelOpen = false;
var initTaskCount = 0;
var initHasUrgent = false;

function renderTaskBadge() {
  // Open means not done: in progress and in review count too (lane 5).
  var openCount = tasks.filter(function(t) { return t.status !== 'done'; }).length;
  var hasUrgent = tasks.some(function(t) { return t.status !== 'done' && t.priority === 'urgent'; });
  renderTaskBadgeFromCount(openCount, hasUrgent);
}

function renderTaskBadgeFromCount(count, hasUrgent) {
  var badge = document.getElementById('task-badge');
  var countEl = document.getElementById('task-badge-count');
  if (!badge || !countEl) return;
  countEl.textContent = count > 0 ? (count > 99 ? '99+' : String(count)) : '';
  countEl.hidden = count === 0;
  badge.setAttribute('aria-label', count > 0 ? 'Tasks, ' + count + ' open' : 'Tasks');
  badge.classList.toggle('has-tasks', count > 0);
  badge.classList.toggle('has-urgent', hasUrgent);
}

// The room the `tasks` array and the task panel belong to. Task ids are per
// room, so a card must never be answered against a different room.
var tasksConvId = null;

function taskRoomIsCurrent(convId) {
  return !!(activeConversation && activeConversation.id === convId);
}

// Switch the task list, badge and open panel to this room: clear at once so
// no card of the previous room stays clickable, then fetch.
function resetRoomTasks(convId) {
  tasks = [];
  tasksConvId = convId;
  if (taskPanelOpen) renderTaskPanel();
  loadTaskCount(convId);
  if (taskPanelOpen) loadTasks(convId);
}

function loadTaskCount(convId) {
  fetch('/api/tasks/count?conversation=' + encodeURIComponent(convId))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!taskRoomIsCurrent(convId)) return; // the room changed meanwhile
      renderTaskBadgeFromCount(data.count || 0, data.hasUrgent || false);
    })
    .catch(function() { /* leave badge as-is on failure */ });
}

function loadTasks(convId) {
  var status = taskFilter === 'all' ? 'all' : taskFilter;
  fetch('/api/tasks?conversation=' + encodeURIComponent(convId) + '&status=' + status)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!taskRoomIsCurrent(convId)) return; // the room changed meanwhile
      tasks = data || [];
      tasksConvId = convId;
      renderTaskBadge();
      renderTaskPanel();
    });
}

function toggleTaskPanel() {
  var panel = document.getElementById('task-panel');
  taskPanelOpen = !taskPanelOpen;
  panel.classList.toggle('hidden', !taskPanelOpen);
  if (taskPanelOpen && activeConversation) {
    loadTasks(activeConversation.id);
  }
  if (window.lucide) lucide.createIcons({ root: panel });
  syncRailPanels();
}

function setTaskFilter(filter, btn) {
  taskFilter = filter;
  var tabs = document.querySelectorAll('.task-tab');
  tabs.forEach(function(t) { t.classList.toggle('active', t.getAttribute('data-filter') === filter); });
  if (activeConversation) loadTasks(activeConversation.id);
}

function renderTaskPanel() {
  var body = document.getElementById('task-panel-body');
  if (!body) return;
  body.textContent = '';

  var filtered = tasks.filter(function(t) {
    if (taskFilter === 'all') return true;
    // The Open tab shows every task not done (in progress and in review too).
    if (taskFilter === 'open') return t.status !== 'done';
    return t.status === taskFilter;
  });

  if (filtered.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'task-panel-empty';
    empty.textContent = taskFilter === 'open' ? 'No open tasks' : 'No completed tasks';
    body.appendChild(empty);
    return;
  }

  filtered.sort(function(a, b) {
    if (a.status !== 'done' && b.status !== 'done') {
      if (a.priority === 'urgent' && b.priority !== 'urgent') return -1;
      if (b.priority === 'urgent' && a.priority !== 'urgent') return 1;
    }
    return b.createdAt - a.createdAt;
  });

  filtered.forEach(function(task) {
    body.appendChild(renderTaskCard(task));
  });

  if (window.lucide) lucide.createIcons({ root: body });
}

function renderTaskCard(task) {
  var card = document.createElement('div');
  var active = task.status !== 'done'; // open, in progress or in review
  card.className = 'task-card' + (task.priority === 'urgent' && active ? ' urgent' : '') + (task.status === 'done' ? ' done' : '');

  var header = document.createElement('div');
  header.className = 'task-card-header';

  var idEl = document.createElement('span');
  idEl.className = 'task-card-id';
  idEl.textContent = '#' + task.id;
  header.appendChild(idEl);

  var title = document.createElement('span');
  title.className = 'task-card-title';
  title.textContent = task.title;
  title.title = task.title;
  header.appendChild(title);

  if (task.status === 'in_progress' || task.status === 'review') {
    var stateTag = document.createElement('span');
    stateTag.className = 'task-card-state';
    stateTag.textContent = task.status === 'review' ? 'in review' : 'in progress';
    header.appendChild(stateTag);
  }
  if (task.priority === 'urgent' && active) {
    var pri = document.createElement('span');
    pri.className = 'task-card-priority urgent';
    pri.textContent = 'urgent';
    header.appendChild(pri);
  }

  card.appendChild(header);

  var meta = document.createElement('div');
  meta.className = 'task-card-meta';
  var ago = timeAgo(task.createdAt);
  var parts = ['from: ' + task.creator];
  if (task.assignee) parts.push('for: ' + task.assignee);
  if (task.status === 'done' && task.respondedBy) parts.push('answered: ' + task.respondedBy);
  parts.push(ago);
  meta.textContent = parts.join(' \u00b7 ');
  card.appendChild(meta);

  if (task.description) {
    var desc = document.createElement('div');
    desc.className = 'task-card-desc';
    desc.textContent = task.description;
    card.appendChild(desc);
  }

  if (task.status === 'done' && task.response) {
    var resp = document.createElement('div');
    resp.className = 'task-card-response';
    resp.textContent = task.response;
    card.appendChild(resp);
  }

  if (active) {
    var respond = document.createElement('div');
    respond.className = 'task-respond';

    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'task-respond-input';
    input.placeholder = 'Your response...';
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitTaskResponse(task.id, input.value);
      }
    });

    var btn = document.createElement('button');
    btn.className = 'task-respond-btn';
    btn.title = 'Complete task';
    var checkIcon = document.createElement('i');
    checkIcon.setAttribute('data-lucide', 'check');
    checkIcon.setAttribute('width', '14');
    checkIcon.setAttribute('height', '14');
    btn.appendChild(checkIcon);
    btn.addEventListener('click', function() {
      submitTaskResponse(task.id, input.value);
    });

    respond.appendChild(input);
    respond.appendChild(btn);
    card.appendChild(respond);
  }

  return card;
}

function submitTaskResponse(taskId, response) {
  if (!activeConversation) return;
  // A card from another room's list must not be answered here (ids are per room)
  if (tasksConvId !== activeConversation.id) return;
  var text = (response || '').trim();
  if (!text) {
    // Focus the input to hint the user should type something
    var input = document.querySelector('.task-card .task-respond-input');
    if (input) { input.focus(); input.placeholder = 'Type a response first...'; }
    return;
  }
  var senderName = document.getElementById('sender-name').value || 'human';
  fetch('/api/tasks/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: taskId,
      status: 'done',
      response: text,
      respondedBy: senderName,
      conversation: activeConversation.id
    })
  }).then(function(r) { return r.json(); }).then(function(task) {
    if (task.error) return;
    tasks = tasks.map(function(t) { return t.id === task.id ? task : t; });
    renderTaskBadge();
    renderTaskPanel();
  });
}

function showCreateTaskForm() {
  var body = document.getElementById('task-panel-body');
  if (!body || body.querySelector('.task-create-form')) return;

  var form = document.createElement('div');
  form.className = 'task-create-form';

  // Title
  var titleLabel = document.createElement('label');
  titleLabel.textContent = 'Title';
  form.appendChild(titleLabel);
  var titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'task-create-title';
  titleInput.placeholder = 'What do you need?';
  form.appendChild(titleInput);

  // Description
  var descLabel = document.createElement('label');
  descLabel.textContent = 'Details (optional)';
  form.appendChild(descLabel);
  var descInput = document.createElement('textarea');
  descInput.className = 'task-create-desc';
  descInput.placeholder = 'Context or question...';
  descInput.rows = 2;
  form.appendChild(descInput);

  // Assignee
  var assignLabel = document.createElement('label');
  assignLabel.textContent = 'Assign to';
  form.appendChild(assignLabel);
  var assignSelect = document.createElement('select');
  assignSelect.className = 'task-create-assignee';
  var anyOpt = document.createElement('option');
  anyOpt.value = '';
  anyOpt.textContent = '(anyone)';
  assignSelect.appendChild(anyOpt);
  agents.forEach(function(a) {
    var opt = document.createElement('option');
    opt.value = a.name;
    opt.textContent = a.name;
    assignSelect.appendChild(opt);
  });
  form.appendChild(assignSelect);

  // Priority
  var priRow = document.createElement('div');
  priRow.className = 'task-priority-row';
  ['normal', 'urgent'].forEach(function(val) {
    var label = document.createElement('label');
    var radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'task-priority';
    radio.value = val;
    if (val === 'normal') radio.checked = true;
    label.appendChild(radio);
    label.appendChild(document.createTextNode(' ' + val));
    priRow.appendChild(label);
  });
  form.appendChild(priRow);

  // Buttons
  var btnRow = document.createElement('div');
  btnRow.className = 'task-create-btns';
  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-sm task-create-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', function() { form.remove(); });
  var submitBtn = document.createElement('button');
  submitBtn.className = 'btn btn-send';
  submitBtn.style.cssText = 'padding:4px 12px;width:auto;height:auto;font-size:var(--fs-meta);';
  submitBtn.textContent = 'Create';
  submitBtn.addEventListener('click', function() {
    var title = titleInput.value.trim();
    if (!title) { titleInput.focus(); return; }
    createTask({
      title: title,
      description: descInput.value.trim() || undefined,
      assignee: assignSelect.value || undefined,
      priority: form.querySelector('input[name="task-priority"]:checked').value
    });
    form.remove();
  });
  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(submitBtn);
  form.appendChild(btnRow);

  body.insertBefore(form, body.firstChild);
  titleInput.focus();

  titleInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); submitBtn.click(); }
  });
}

function createTask(opts) {
  if (!activeConversation) return;
  var senderName = document.getElementById('sender-name').value || 'human';
  fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: opts.title,
      description: opts.description,
      creator: senderName,
      assignee: opts.assignee,
      priority: opts.priority || 'normal',
      conversation: activeConversation.id
    })
  });
}

// --- Turn Guard ---
var turnGuardState = { enabled: false, limit: 20 };

function initTurnGuard(settings) {
  if (!settings) return;
  turnGuardState = settings;
  var toggle = document.getElementById('turn-guard-toggle');
  var spinner = document.getElementById('turn-guard-limit');
  if (toggle) toggle.checked = settings.enabled;
  if (spinner) {
    spinner.value = settings.limit;
    spinner.disabled = !settings.enabled;
  }
}

function toggleTurnGuard(enabled) {
  turnGuardState.enabled = enabled;
  var spinner = document.getElementById('turn-guard-limit');
  if (spinner) spinner.disabled = !enabled;
  saveTurnGuard();
}

function setTurnGuardLimit(val) {
  var n = Math.max(1, Math.min(100, parseInt(val) || 20));
  turnGuardState.limit = n;
  var spinner = document.getElementById('turn-guard-limit');
  if (spinner) spinner.value = n;
  saveTurnGuard();
}

function saveTurnGuard() {
  fetch('/api/turn-guard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(turnGuardState)
  });
}

function timeAgo(ts) {
  var diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

// --- Responsive placeholder swap (avoids wrapping at mobile widths) ---
function syncInputPlaceholder() {
  var input = document.getElementById('message-input');
  if (!input) return;
  var w = window.innerWidth;
  var ph;
  void w;
  if (activeDm) ph = 'Message ' + activeDm;
  else if (activeConversation) ph = 'Message #' + activeConversation.name;
  else ph = 'Message';
  if (input.placeholder !== ph) input.placeholder = ph;
}
window.addEventListener('resize', syncInputPlaceholder);

// --- Init ---
document.addEventListener('DOMContentLoaded', function() {
  setupInput();
  setupYouPill();
  syncInputPlaceholder();
  updateSendBtn();
  updateMuteBtn();
  // Prompt for the token first when the server uses a user-set (non-injected)
  // one, then first-boot register -> connect (registerWebName runs either way;
  // the server fails closed if the name was not accepted).
  ensureWebToken(function() {
    registerWebName(function() { connect(); });
  });
  loadTemplates();
  // Decide popover wiring
  var decideAdd = document.getElementById('decide-add');
  if (decideAdd) decideAdd.addEventListener('click', function() { addDecideOption(); });
  var decidePost = document.getElementById('decide-post');
  if (decidePost) decidePost.addEventListener('click', submitDecideForm);
  // Plus-menu and URL popover wiring
  var attachMenu = document.getElementById('attach-menu');
  if (attachMenu) attachMenu.addEventListener('keydown', onAttachMenuKey);
  document.addEventListener('mousedown', function(e) {
    if (!attachMenuOpen) return;
    var menu = document.getElementById('attach-menu');
    var plus = document.getElementById('attach-btn');
    if (menu && menu.contains(e.target)) return;
    if (plus && plus.contains(e.target)) return;
    closeAttachMenu(false);
  });
  var urlInsert = document.getElementById('url-insert');
  if (urlInsert) urlInsert.addEventListener('click', submitUrlForm);
  var urlCancel = document.getElementById('url-cancel');
  if (urlCancel) urlCancel.addEventListener('click', function() { closeUrlPopover(true); });
  var urlPop = document.getElementById('url-popover');
  if (urlPop) urlPop.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeUrlPopover(true); }
    else if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') { e.preventDefault(); submitUrlForm(); }
  });
  var decidePop = document.getElementById('decide-popover');
  if (decidePop) decidePop.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDecidePopover(); document.getElementById('message-input').focus(); }
  });

  // Show instance name in header + page title
  fetch('/api/instance').then(function(r) { return r.json(); }).then(function(info) {
    if (!info || !info.name) return;
    var el = document.getElementById('instance-name');
    if (el) el.textContent = info.name;
    var brand = document.getElementById('rail-brand');
    if (brand) { brand.title = info.name; brand.textContent = info.name.charAt(0).toUpperCase(); }
    document.title = info.name === 'Joind' ? 'Joind' : info.name + ' — Joind';
  }).catch(function() { /* ignore */ });
  // Wire conversation search
  var convSearch = document.getElementById('conv-search');
  if (convSearch) {
    convSearch.addEventListener('input', function() {
      convSearchQuery = this.value;
      renderConversationList();
    });
  }
  // Restore sidebar state (desktop only — mobile uses drawer)
  var sidebarHidden = false;
  try { sidebarHidden = localStorage.getItem('joind-sidebar') === 'hidden'; } catch (e) { /* storage unavailable */ }
  if (!isMobileView() && sidebarHidden) {
    document.getElementById('sidebar').classList.add('hidden');
  }
  initSidebarResize();
  loadCrewRoster();
  initSections();
  initRail();
  initSidePanel();
});

// renderRolesPanel is now integrated into the settings dialog

// --- Reactions ---
var QUICK_REACTIONS = ['\uD83D\uDC4D', '\u2705', '\uD83D\uDC40', '\uD83C\uDF89', '\u2764\uFE0F', '\uD83E\uDD14', '\uD83D\uDD96', '\uD83E\uDEF1', '\uD83E\uDD17', '\uD83E\uDEE1', '\uD83D\uDC4C'];
var FULL_EMOJI_SET = [
  // Faces
  '\uD83D\uDE00', '\uD83D\uDE02', '\uD83D\uDE0D', '\uD83E\uDD29', '\uD83E\uDD73', '\uD83D\uDE0E', '\uD83E\uDD13', '\uD83E\uDD2F',
  '\uD83D\uDE31', '\uD83D\uDE2D', '\uD83D\uDE24', '\uD83E\uDD75', '\uD83E\uDD76', '\uD83E\uDD21', '\uD83D\uDC80', '\uD83D\uDC7D',
  // Gestures
  '\uD83D\uDC4D', '\uD83D\uDC4E', '\uD83D\uDC4F', '\uD83D\uDE4C', '\uD83E\uDD1D', '\uD83D\uDC4A', '\u270C\uFE0F', '\uD83E\uDD1E',
  '\uD83D\uDD96', '\uD83E\uDEF1', '\uD83E\uDEE1', '\uD83D\uDC4C', '\uD83D\uDC4B', '\u270B', '\uD83E\uDD19', '\uD83D\uDCAA',
  // Hearts & symbols
  '\u2764\uFE0F', '\uD83E\uDDE1', '\uD83D\uDC9B', '\uD83D\uDC9A', '\uD83D\uDC99', '\uD83D\uDC9C', '\uD83D\uDDA4', '\uD83E\uDD0D',
  // Objects
  '\u2705', '\u274C', '\u26A0\uFE0F', '\uD83D\uDCA1', '\uD83D\uDD25', '\uD83C\uDF89', '\uD83C\uDFC6', '\uD83D\uDE80',
  '\uD83D\uDC40', '\uD83E\uDD14', '\uD83E\uDD17', '\uD83D\uDCAF', '\uD83D\uDC8E', '\uD83C\uDF1F', '\u2B50', '\uD83C\uDF08',
  // Tech & work
  '\uD83D\uDEE0\uFE0F', '\uD83D\uDD2C', '\uD83D\uDCBB', '\uD83E\uDDEA', '\uD83D\uDCC8', '\uD83D\uDCCA', '\uD83D\uDCDD', '\uD83D\uDCD6',
  '\uD83D\uDD12', '\uD83D\uDD13', '\uD83C\uDFAF', '\u23F0', '\uD83D\uDEA8', '\uD83D\uDED1', '\uD83D\uDFE2', '\uD83D\uDD34',
];
var allReactions = []; // loaded from init

function showReactPicker(messageId, anchorEl) {
  // Close any existing picker
  var existing = document.querySelector('.react-picker');
  if (existing) existing.remove();

  var picker = document.createElement('div');
  picker.className = 'react-picker';

  // Quick reactions row
  QUICK_REACTIONS.forEach(function(emoji) {
    var btn = document.createElement('button');
    btn.className = 'react-picker-btn';
    btn.textContent = emoji;
    btn.addEventListener('click', function() {
      sendReaction(messageId, emoji);
      picker.remove();
    });
    picker.appendChild(btn);
  });

  // Expand button for full panel
  var moreBtn = document.createElement('button');
  moreBtn.className = 'react-picker-btn react-more-btn';
  moreBtn.textContent = '\u00B7\u00B7\u00B7';
  moreBtn.title = 'More emojis';
  moreBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    var grid = picker.querySelector('.react-full-grid');
    if (grid) {
      grid.classList.toggle('hidden');
      return;
    }
    grid = document.createElement('div');
    grid.className = 'react-full-grid';
    FULL_EMOJI_SET.forEach(function(emoji) {
      var btn = document.createElement('button');
      btn.className = 'react-grid-btn';
      btn.textContent = emoji;
      btn.addEventListener('click', function() {
        sendReaction(messageId, emoji);
        picker.remove();
      });
      grid.appendChild(btn);
    });
    picker.appendChild(grid);
  });
  picker.appendChild(moreBtn);

  anchorEl.parentElement.appendChild(picker);
  setTimeout(function() {
    document.addEventListener('click', function closePicker(e) {
      if (picker.contains(e.target)) return;
      picker.remove();
      document.removeEventListener('click', closePicker);
    });
  }, 10);
}

// =============================================================================
// LAUNCH AGENT DIALOG
// =============================================================================

var launchDialogOverlay = null;
var launchCountdownInterval = null;
var launchPollInterval = null;
var launchCurrentId = null;
var launchCancelledInject = false;

function openLaunchDialog(preselectCrewName) {
  closeLaunchDialog();
  launchCancelledInject = false;

  var overlay = document.createElement('div');
  overlay.className = 'launch-dialog-overlay';
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeLaunchDialog();
  });

  var box = document.createElement('div');
  box.className = 'launch-dialog-box';

  // Header
  var hdr = document.createElement('div');
  hdr.className = 'launch-dialog-header';
  var title = document.createElement('div');
  title.className = 'launch-dialog-title';
  title.textContent = '\u{1F680} Launch Agent';
  var closeBtn = document.createElement('button');
  closeBtn.className = 'launch-dialog-close';
  closeBtn.textContent = '\u00D7';
  closeBtn.addEventListener('click', closeLaunchDialog);
  hdr.appendChild(title);
  hdr.appendChild(closeBtn);
  box.appendChild(hdr);

  // Content area — show loading spinner while fetching
  var content = document.createElement('div');
  content.className = 'launch-dialog-content';
  var loading = buildLaunchLoading();
  content.appendChild(loading);
  box.appendChild(content);

  // Footer placeholder (will be replaced when loaded)
  var footer = document.createElement('div');
  footer.className = 'launch-dialog-footer';
  box.appendChild(footer);

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  launchDialogOverlay = overlay;

  // Fetch all data in parallel
  Promise.all([
    fetch('/api/crew').then(function(r) { return r.json(); }).catch(function() { return []; }),
    fetch('/api/harnesses').then(function(r) { return r.json(); }).catch(function() { return []; }),
    fetch('/api/conversations?token=' + encodeURIComponent(webToken())).then(function(r) { return r.json(); }).catch(function() { return { conversations: [] }; }),
    fetch('/api/launcher/terminals').then(function(r) { return r.json(); }).catch(function() { return { wezterm: { available: false, running: false }, wt: { available: false }, manual: { available: true } }; })
  ]).then(function(results) {
    var crewList = results[0];
    var harnesses = results[1];
    var convData = results[2];
    var terminalsInfo = results[3];
    var convList = convData.conversations || convData || [];
    content.textContent = '';
    footer.textContent = '';
    buildLaunchForm(content, footer, crewList, harnesses, convList, terminalsInfo, preselectCrewName);
  }).catch(function(err) {
    content.textContent = '';
    var errMsg = document.createElement('div');
    errMsg.className = 'launch-error';
    errMsg.textContent = 'Failed to load data: ' + (err && err.message ? err.message : 'network error');
    content.appendChild(errMsg);
  });
}

function closeLaunchDialog() {
  if (launchCountdownInterval) { clearInterval(launchCountdownInterval); launchCountdownInterval = null; }
  if (launchPollInterval) { clearInterval(launchPollInterval); launchPollInterval = null; }
  launchCurrentId = null;
  if (launchDialogOverlay) { launchDialogOverlay.remove(); launchDialogOverlay = null; }
}

function buildLaunchLoading() {
  var wrap = document.createElement('div');
  wrap.className = 'launch-loading';
  for (var i = 0; i < 3; i++) {
    var dot = document.createElement('span');
    dot.className = 'launch-loading-dot';
    wrap.appendChild(dot);
  }
  var txt = document.createTextNode(' Loading');
  wrap.appendChild(txt);
  return wrap;
}

function buildLaunchForm(content, footer, crewList, harnesses, convList, terminalsInfo, preselectCrewName) {
  // Track selected state
  var selectedCrew = null;
  var selectedHarness = null;
  var selectedTerminal = null; // "wezterm" | "wt" | "manual"

  // Default terminalsInfo shape if not provided
  terminalsInfo = terminalsInfo || { wezterm: { available: false, running: false }, wt: { available: false }, manual: { available: true } };

  // --- CREW SECTION ---
  var crewSection = document.createElement('div');
  crewSection.className = 'launch-section';
  var crewLabel = document.createElement('div');
  crewLabel.className = 'launch-section-label';
  crewLabel.textContent = 'Crew Member';
  crewSection.appendChild(crewLabel);

  var crewSelect = document.createElement('select');
  crewSelect.className = 'launch-select';
  crewSelect.id = 'launch-crew-select';

  var emptyOpt = document.createElement('option');
  emptyOpt.value = '';
  emptyOpt.textContent = '-- select crew --';
  crewSelect.appendChild(emptyOpt);

  crewList.forEach(function(crew) {
    var opt = document.createElement('option');
    opt.value = crew.name;
    opt.textContent = crew.name;
    crewSelect.appendChild(opt);
  });

  // "Add folder..." option
  var addOpt = document.createElement('option');
  addOpt.value = '__add__';
  addOpt.textContent = '+ Add folder...';
  crewSelect.appendChild(addOpt);

  crewSection.appendChild(crewSelect);

  // Crew meta row
  var crewMeta = document.createElement('div');
  crewMeta.className = 'crew-meta';
  crewSection.appendChild(crewMeta);

  // Add folder inline form (hidden by default)
  var addCrewForm = buildAddCrewForm(function(newCrew) {
    // Reload after adding
    fetch('/api/crew').then(function(r) { return r.json(); }).then(function(updated) {
      // Rebuild options preserving add
      while (crewSelect.options.length > 1) crewSelect.remove(1);
      updated.forEach(function(c) {
        var o = document.createElement('option');
        o.value = c.name; o.textContent = c.name;
        crewSelect.appendChild(o);
      });
      var ao = document.createElement('option');
      ao.value = '__add__'; ao.textContent = '+ Add folder...';
      crewSelect.appendChild(ao);
      crewList = updated;
      addCrewForm.style.display = 'none';
      // Select the newly added crew. POST /api/crew returns the raw entry, with
      // no identityExists/mcpConfig, so use the enriched one just fetched or the
      // badges would read "no identity" for a folder that has one.
      if (newCrew) {
        var added = updated.find(function(c) { return c.name === newCrew.name; }) || newCrew;
        crewSelect.value = added.name;
        updateCrewMeta(added);
        selectedCrew = added;
        autoFillFromCrew(added);
      }
      updateLaunchBtn();
    }).catch(function() {});
  }, function() {
    addCrewForm.style.display = 'none';
    crewSelect.value = '';
    updateLaunchBtn();
  });
  addCrewForm.style.display = 'none';
  crewSection.appendChild(addCrewForm);

  crewSelect.addEventListener('change', function() {
    if (crewSelect.value === '__add__') {
      addCrewForm.style.display = '';
      selectedCrew = null;
      updateCrewMeta(null);
      updateLaunchBtn();
      return;
    }
    addCrewForm.style.display = 'none';
    selectedCrew = crewList.find(function(c) { return c.name === crewSelect.value; }) || null;
    updateCrewMeta(selectedCrew);
    if (selectedCrew) autoFillFromCrew(selectedCrew);
    if (typeof reloadResumeIfOpen === 'function') reloadResumeIfOpen();
    updateLaunchBtn();
  });

  function updateCrewMeta(crew) {
    crewMeta.textContent = '';
    if (!crew) return;
    if (crew.path) {
      var pathSpan = document.createElement('span');
      pathSpan.className = 'crew-meta-path';
      pathSpan.textContent = crew.path;
      pathSpan.title = crew.path;
      crewMeta.appendChild(pathSpan);
    }
    var idBadge = document.createElement('span');
    idBadge.className = 'status-badge ' + (crew.identityExists ? 'ok' : 'warn');
    idBadge.textContent = crew.identityExists ? '\u2713 identity' : '\u26A0 no identity';
    crewMeta.appendChild(idBadge);

    var hasSomeMcp = crew.hasMcpConfig ||
      (crew.mcpConfig && typeof crew.mcpConfig === 'object' &&
        Object.values(crew.mcpConfig).some(function(v) { return !!v; }));
    var mcpBadge = document.createElement('span');
    mcpBadge.className = 'status-badge ' + (hasSomeMcp ? 'ok' : 'warn');
    mcpBadge.textContent = hasSomeMcp ? '\u2713 MCP' : '\u26A0 no MCP';
    crewMeta.appendChild(mcpBadge);
  }

  content.appendChild(crewSection);

  // --- HARNESS SECTION ---
  var harnessSection = document.createElement('div');
  harnessSection.className = 'launch-section';
  var harnessLabel = document.createElement('div');
  harnessLabel.className = 'launch-section-label';
  harnessLabel.textContent = 'TUI Harness';
  harnessSection.appendChild(harnessLabel);

  var harnessGroup = document.createElement('div');
  harnessGroup.className = 'harness-radio-group';

  harnesses.forEach(function(h) {
    var lbl = document.createElement('label');
    lbl.className = 'harness-card-label' + (h.installed ? '' : ' disabled');
    if (!h.installed) lbl.title = h.label + ' not installed';

    var radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'launch-harness';
    radio.value = h.id;
    radio.disabled = !h.installed;

    var nameSpan = document.createElement('span');
    nameSpan.textContent = h.label;

    lbl.appendChild(radio);
    lbl.appendChild(nameSpan);

    if (!h.installed) {
      var notInstalled = document.createElement('span');
      notInstalled.className = 'harness-not-installed';
      notInstalled.textContent = '(not installed)';
      lbl.appendChild(notInstalled);
    }

    radio.addEventListener('change', function() {
      if (!radio.checked) return;
      // Update card styling
      harnessGroup.querySelectorAll('.harness-card-label').forEach(function(el) {
        el.classList.remove('selected');
      });
      lbl.classList.add('selected');
      selectedHarness = h;
      renderFlagsForm(h, flagsForm);
      // Picking a harness by hand must land on the same flag values that
      // autoFillFromCrew produces for the crew's default harness.
      if (selectedCrew && selectedCrew.defaultFlags) applyDefaultFlags(flagsForm, selectedCrew.defaultFlags);
      updateMcpWarning();
      if (typeof reloadResumeIfOpen === 'function') reloadResumeIfOpen();
      updateLaunchBtn();
    });

    harnessGroup.appendChild(lbl);
  });

  harnessSection.appendChild(harnessGroup);
  content.appendChild(harnessSection);

  // --- FLAGS SECTION ---
  var flagsSection = document.createElement('div');
  flagsSection.className = 'launch-section';
  var flagsLabel = document.createElement('div');
  flagsLabel.className = 'launch-section-label';
  flagsLabel.textContent = 'Harness Options';
  flagsSection.appendChild(flagsLabel);

  var flagsForm = document.createElement('div');
  flagsForm.className = 'flags-form';
  flagsSection.appendChild(flagsForm);
  content.appendChild(flagsSection);

  // --- RESUME SECTION ---
  var resumeSessionId = null;
  var resumeSection = document.createElement('div');
  resumeSection.className = 'launch-section';
  var resumeHdr = document.createElement('div');
  resumeHdr.className = 'launch-section-label';
  resumeHdr.textContent = 'Resume';
  resumeSection.appendChild(resumeHdr);

  var resumeToggleRow = document.createElement('label');
  resumeToggleRow.className = 'resume-toggle-row';
  var resumeCheckbox = document.createElement('input');
  resumeCheckbox.type = 'checkbox';
  resumeCheckbox.id = 'launch-resume-checkbox';
  var resumeToggleText = document.createElement('span');
  resumeToggleText.textContent = 'Resume previous session';
  resumeToggleRow.appendChild(resumeCheckbox);
  resumeToggleRow.appendChild(resumeToggleText);
  resumeSection.appendChild(resumeToggleRow);

  var resumeDropdownWrap = document.createElement('div');
  resumeDropdownWrap.className = 'resume-dropdown-wrap';
  resumeDropdownWrap.style.display = 'none';
  var resumeSelect = document.createElement('select');
  resumeSelect.className = 'launch-select';
  resumeSelect.id = 'launch-resume-select';
  resumeDropdownWrap.appendChild(resumeSelect);
  var resumeStatus = document.createElement('div');
  resumeStatus.className = 'resume-status';
  resumeDropdownWrap.appendChild(resumeStatus);
  resumeSection.appendChild(resumeDropdownWrap);
  content.appendChild(resumeSection);

  function formatRelativeTime(ms) {
    var d = Date.now() - ms;
    if (d < 60000) return 'just now';
    if (d < 3600000) return Math.floor(d / 60000) + 'm ago';
    if (d < 86400000) return Math.floor(d / 3600000) + 'h ago';
    if (d < 2592000000) return Math.floor(d / 86400000) + 'd ago';
    return new Date(ms).toISOString().slice(0, 10);
  }

  function loadResumeSessions() {
    if (!selectedCrew || !selectedHarness) {
      resumeSelect.textContent = '';
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Pick a crew and harness first';
      opt.disabled = true;
      resumeSelect.appendChild(opt);
      return;
    }
    resumeSelect.textContent = '';
    resumeStatus.textContent = 'Loading sessions…';
    resumeStatus.style.color = 'var(--text-muted)';
    resumeSessionId = null;
    var url = '/api/launcher/sessions?harness=' +
      encodeURIComponent(selectedHarness.id) +
      '&cwd=' + encodeURIComponent(selectedCrew.path);
    fetch(url).then(function(r) { return r.json(); }).then(function(sessions) {
      resumeSelect.textContent = '';
      if (!Array.isArray(sessions) || sessions.length === 0) {
        var opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '(no sessions found for this folder)';
        opt.disabled = true;
        resumeSelect.appendChild(opt);
        resumeStatus.textContent = selectedHarness.id === 'openclaw'
          ? 'OpenClaw resume is not supported yet'
          : 'No previous sessions found for this folder';
        resumeStatus.style.color = 'var(--text-muted)';
        resumeSessionId = null;
        updateLaunchBtn();
        return;
      }
      var placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '— pick a session —';
      resumeSelect.appendChild(placeholder);
      sessions.forEach(function(s) {
        var o = document.createElement('option');
        o.value = s.id;
        var label = s.title || s.firstMessage || s.id.slice(0, 8);
        o.textContent = label + '  ·  ' + formatRelativeTime(s.lastActivity);
        if (s.firstMessage && s.firstMessage !== label) {
          o.title = s.firstMessage;
        }
        resumeSelect.appendChild(o);
      });
      resumeStatus.textContent = sessions.length + ' session' + (sessions.length === 1 ? '' : 's') + ' found';
      resumeStatus.style.color = 'var(--text-muted)';
      updateLaunchBtn();
    }).catch(function(err) {
      resumeSelect.textContent = '';
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(failed to load)';
      opt.disabled = true;
      resumeSelect.appendChild(opt);
      resumeStatus.textContent = 'Error: ' + (err && err.message ? err.message : 'load failed');
      resumeStatus.style.color = 'var(--err-color, #f87171)';
      updateLaunchBtn();
    });
  }

  resumeCheckbox.addEventListener('change', function() {
    if (resumeCheckbox.checked) {
      resumeDropdownWrap.style.display = 'block';
      loadResumeSessions();
    } else {
      resumeDropdownWrap.style.display = 'none';
      resumeSessionId = null;
      updateLaunchBtn();
    }
  });

  resumeSelect.addEventListener('change', function() {
    resumeSessionId = resumeSelect.value || null;
    updateLaunchBtn();
  });

  // Reload sessions when crew or harness changes (if resume is toggled on)
  function reloadResumeIfOpen() {
    if (resumeCheckbox.checked) loadResumeSessions();
  }

  // --- TERMINAL SECTION ---
  var terminalSection = document.createElement('div');
  terminalSection.className = 'launch-section';
  var terminalLabel = document.createElement('div');
  terminalLabel.className = 'launch-section-label';
  terminalLabel.textContent = 'Terminal';
  terminalSection.appendChild(terminalLabel);

  var terminalGroup = document.createElement('div');
  terminalGroup.className = 'harness-radio-group';

  var terminalDefs = [
    { id: 'wezterm', label: 'WezTerm', info: terminalsInfo.wezterm || { available: false, running: false } },
    { id: 'wt', label: 'Windows Terminal', info: terminalsInfo.wt || { available: false } },
    { id: 'manual', label: 'Manual', info: terminalsInfo.manual || { available: true } },
  ];

  // Auto-select: prefer wezterm if available, then wt, then manual
  var defaultTerminal = 'manual';
  if (terminalsInfo.wezterm && terminalsInfo.wezterm.available) defaultTerminal = 'wezterm';
  else if (terminalsInfo.wt && terminalsInfo.wt.available) defaultTerminal = 'wt';
  selectedTerminal = defaultTerminal;

  terminalDefs.forEach(function(t) {
    var available = t.info.available !== false;
    var lbl = document.createElement('label');
    lbl.className = 'harness-card-label' + (available ? '' : ' disabled');
    if (!available) lbl.title = t.label + ' not available';

    var radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'launch-terminal';
    radio.value = t.id;
    radio.disabled = !available;
    if (t.id === defaultTerminal) {
      radio.checked = true;
      lbl.classList.add('selected');
    }

    var nameSpan = document.createElement('span');
    nameSpan.textContent = t.label;
    lbl.appendChild(radio);
    lbl.appendChild(nameSpan);

    // Subtitle
    var subtitle = document.createElement('span');
    subtitle.className = 'harness-not-installed';
    if (t.id === 'wezterm') {
      if (t.info.running) {
        subtitle.textContent = 'Auto-inject supported';
        subtitle.style.color = 'var(--ok-color, #4ecdc4)';
      } else if (available) {
        subtitle.textContent = 'Will open new window';
        subtitle.style.color = 'var(--text-muted)';
      } else {
        subtitle.textContent = '(not available)';
      }
    } else if (t.id === 'wt') {
      if (available) {
        subtitle.textContent = 'Manual join required';
        subtitle.style.color = 'var(--warn-color, #f59e0b)';
      } else {
        subtitle.textContent = '(not available)';
      }
    } else if (t.id === 'manual') {
      subtitle.textContent = 'Copy command to clipboard';
      subtitle.style.color = 'var(--text-muted)';
    }
    lbl.appendChild(subtitle);

    radio.addEventListener('change', function() {
      if (!radio.checked) return;
      terminalGroup.querySelectorAll('.harness-card-label').forEach(function(el) {
        el.classList.remove('selected');
      });
      lbl.classList.add('selected');
      selectedTerminal = t.id;
      updateMcpWarning();
      updateLaunchBtn();
    });

    terminalGroup.appendChild(lbl);
  });

  terminalSection.appendChild(terminalGroup);
  content.appendChild(terminalSection);

  // --- JOIN SECTION ---
  var joinSection = document.createElement('div');
  joinSection.className = 'launch-section';
  var joinSectionLabel = document.createElement('div');
  joinSectionLabel.className = 'launch-section-label';
  joinSectionLabel.textContent = 'Join';
  joinSection.appendChild(joinSectionLabel);

  var convRow = document.createElement('div');
  convRow.className = 'join-row';
  var convRowLabel = document.createElement('span');
  convRowLabel.className = 'join-row-label';
  convRowLabel.textContent = 'Conversation';
  var convSelect = document.createElement('select');
  convSelect.className = 'launch-select';
  convSelect.id = 'launch-conversation';

  var skipOpt = document.createElement('option');
  skipOpt.value = '';
  skipOpt.textContent = '(skip join)';
  convSelect.appendChild(skipOpt);

  convList.forEach(function(c) {
    var co = document.createElement('option');
    co.value = c.id || c.name;
    co.textContent = c.name;
    convSelect.appendChild(co);
  });

  // Pre-select active conversation if available
  if (activeConversation) {
    convSelect.value = activeConversation.id;
  }

  convRow.appendChild(convRowLabel);
  convRow.appendChild(convSelect);
  joinSection.appendChild(convRow);

  var joinAsRow = document.createElement('div');
  joinAsRow.className = 'join-row';
  var joinAsLabel = document.createElement('span');
  joinAsLabel.className = 'join-row-label';
  joinAsLabel.textContent = 'Join as';
  var joinAsInput = document.createElement('input');
  joinAsInput.type = 'text';
  joinAsInput.className = 'launch-input';
  joinAsInput.id = 'launch-join-as';
  joinAsInput.placeholder = 'agent name';
  joinAsInput.addEventListener('input', updateLaunchBtn);
  joinAsRow.appendChild(joinAsLabel);
  joinAsRow.appendChild(joinAsInput);
  joinSection.appendChild(joinAsRow);

  content.appendChild(joinSection);

  // --- META SECTION ---
  var metaSection = document.createElement('div');
  metaSection.className = 'launch-section';

  var metaRow = document.createElement('div');
  metaRow.className = 'launch-meta-row';

  var termStatus = document.createElement('div');
  termStatus.className = 'terminal-status-line';
  termStatus.id = 'launch-terminal-status';
  termStatus.textContent = 'WezTerm status unknown';
  metaRow.appendChild(termStatus);

  var delayRow = document.createElement('div');
  delayRow.className = 'inject-delay-row';
  var delayLabel = document.createElement('span');
  delayLabel.className = 'inject-delay-label';
  delayLabel.textContent = 'Delay';
  var delaySelect = document.createElement('select');
  delaySelect.className = 'inject-delay-select';
  delaySelect.id = 'launch-inject-delay';
  [2, 3, 4, 6, 10].forEach(function(s) {
    var o = document.createElement('option');
    o.value = s;
    o.textContent = s + 's';
    if (s === 4) o.selected = true;
    delaySelect.appendChild(o);
  });
  delayRow.appendChild(delayLabel);
  delayRow.appendChild(delaySelect);
  metaRow.appendChild(delayRow);

  metaSection.appendChild(metaRow);

  // Warning area (for no-MCP warning)
  var warnArea = document.createElement('div');
  warnArea.id = 'launch-warn-area';
  metaSection.appendChild(warnArea);

  content.appendChild(metaSection);

  // --- FOOTER ---
  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-launch-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', closeLaunchDialog);

  var goBtn = document.createElement('button');
  goBtn.className = 'btn-launch-go';
  goBtn.id = 'launch-go-btn';
  goBtn.textContent = 'Launch \u2192';
  goBtn.disabled = true;
  goBtn.addEventListener('click', function() {
    executeLaunch(harnesses, crewList, function(launchResult) {
      showLaunchStatus(content, footer, launchResult, convSelect.value, joinAsInput.value);
    });
  });

  footer.appendChild(cancelBtn);
  footer.appendChild(goBtn);

  // --- HELPER: update MCP warning based on selected harness + crew (Fix 3) ---
  function updateMcpWarning() {
    var wa = document.getElementById('launch-warn-area');
    if (!wa) return;
    wa.textContent = '';
    if (!selectedCrew) return;
    // Determine which mcpConfig key to check for the selected harness
    var harnessId = selectedHarness ? selectedHarness.id : null;
    var hasMcp;
    if (selectedCrew.mcpConfig && typeof selectedCrew.mcpConfig === 'object') {
      // Rich mcpConfig object: keyed by harness id
      hasMcp = harnessId ? !!selectedCrew.mcpConfig[harnessId] : false;
    } else {
      // Legacy boolean hasMcpConfig (claude only)
      hasMcp = harnessId === 'claude' ? !!selectedCrew.hasMcpConfig : true;
    }
    // Only show the warning when a harness is selected and its MCP config is missing
    if (harnessId && !hasMcp) {
      var warn = document.createElement('div');
      warn.className = 'launch-warning';
      warn.textContent = '\u26A0 No MCP config detected for ' + (selectedHarness ? selectedHarness.label : harnessId) + ' \u2014 command will be shown for manual launch';
      wa.appendChild(warn);
    }
  }

  // --- HELPER: autofill from crew ---
  function autoFillFromCrew(crew) {
    if (crew.joinAs) joinAsInput.value = crew.joinAs;
    if (crew.defaultHarness) {
      var radio = harnessGroup.querySelector('input[value="' + crew.defaultHarness + '"]');
      if (radio && !radio.disabled) {
        radio.checked = true;
        harnessGroup.querySelectorAll('.harness-card-label').forEach(function(el) {
          el.classList.remove('selected');
        });
        var parentLbl = radio.parentElement;
        if (parentLbl) parentLbl.classList.add('selected');
        selectedHarness = harnesses.find(function(h) { return h.id === crew.defaultHarness; }) || null;
        if (selectedHarness) renderFlagsForm(selectedHarness, flagsForm);
      }
    }
    if (crew.defaultConversation) {
      convSelect.value = crew.defaultConversation;
    }
    // Crew-specific flag defaults win over the harness defaults just rendered.
    // Flags the crew entry does not mention keep whatever the harness set.
    if (crew.defaultFlags) applyDefaultFlags(flagsForm, crew.defaultFlags);
    // Update WezTerm status
    var ts = document.getElementById('launch-terminal-status');
    if (ts) {
      var weztermAvail = terminalsInfo.wezterm && terminalsInfo.wezterm.available;
      if (weztermAvail) {
        ts.textContent = '\u2713 WezTerm available';
        ts.className = 'terminal-status-line ok';
      } else {
        ts.textContent = '\u26A0 No WezTerm \u2014 manual launch';
        ts.className = 'terminal-status-line warn';
      }
    }
    updateMcpWarning();
    updateLaunchBtn();
  }

  // --- VALIDATE + UPDATE LAUNCH BTN ---
  function updateLaunchBtn() {
    var btn = document.getElementById('launch-go-btn');
    if (!btn) return;
    var valid = (
      selectedCrew !== null &&
      selectedCrew.path &&
      selectedHarness !== null &&
      selectedHarness.installed &&
      joinAsInput.value.trim() !== ''
    );
    // When resume toggle is on, a session must be picked
    if (resumeCheckbox.checked && !resumeSessionId) valid = false;
    btn.disabled = !valid;
  }

  // Expose resume state to executeLaunch via a getter on the closure
  window.__getLaunchResumeId = function() { return resumeSessionId; };

  // Preselect a crew member (used by the crew panel's Launch button). Done last
  // so the change handler runs against a fully built form.
  if (preselectCrewName) {
    crewSelect.value = preselectCrewName;
    if (crewSelect.value === preselectCrewName) {
      crewSelect.dispatchEvent(new Event('change'));
    }
  }
}

/**
 * Apply a crew entry's saved flag values to the currently rendered flag inputs.
 * Booleans tick the checkbox, arrays fill multi-text fields one value per line,
 * everything else sets the input value. Unknown flag ids are ignored.
 */
function applyDefaultFlags(container, defaultFlags) {
  if (!container || !defaultFlags || typeof defaultFlags !== 'object') return;
  container.querySelectorAll('[data-flag-id]').forEach(function(el) {
    var id = el.dataset.flagId;
    if (!id || !Object.prototype.hasOwnProperty.call(defaultFlags, id)) return;
    var value = defaultFlags[id];
    if (el.dataset.flagType === 'boolean') {
      el.checked = value === true || value === 'true';
    } else if (el.tagName === 'SELECT') {
      // A value saved for one harness can be meaningless for another harness's
      // same-named enum. Assigning it would blank the select, so keep the
      // harness default instead.
      var match = Array.prototype.some.call(el.options, function(o) { return o.value === String(value); });
      if (match) el.value = String(value);
    } else if (Array.isArray(value)) {
      el.value = value.join('\n');
    } else if (value === null || value === undefined) {
      el.value = '';
    } else {
      el.value = String(value);
    }
  });
}

function renderFlagsForm(harness, container) {
  container.textContent = '';
  var flags = harness.flags || [];
  if (flags.length === 0) {
    var empty = document.createElement('div');
    empty.style.fontSize = 'var(--fs-meta)';
    empty.style.color = 'var(--text-muted)';
    empty.style.fontStyle = 'italic';
    empty.textContent = 'No configurable options';
    container.appendChild(empty);
    return;
  }
  flags.forEach(function(flag) {
    var row = document.createElement('div');
    row.className = 'flag-row';

    var lbl = document.createElement('label');
    lbl.className = 'flag-label';
    lbl.textContent = flag.label;
    if (flag.help) lbl.title = flag.help;
    row.appendChild(lbl);

    var input;
    if (flag.type === 'enum') {
      input = document.createElement('select');
      input.className = 'launch-select';
      (flag.options || []).forEach(function(opt) {
        var o = document.createElement('option');
        o.value = opt; o.textContent = opt;
        if (opt === flag.default) o.selected = true;
        input.appendChild(o);
      });
    } else if (flag.type === 'boolean') {
      var checkWrap = document.createElement('div');
      checkWrap.style.display = 'flex';
      checkWrap.style.alignItems = 'center';
      checkWrap.style.gap = '7px';
      input = document.createElement('input');
      input.type = 'checkbox';
      input.style.accentColor = 'var(--accent)';
      input.style.width = '15px';
      input.style.height = '15px';
      if (flag.default === true || flag.default === 'true') input.checked = true;
      checkWrap.appendChild(input);
      if (flag.help) {
        var helpSpan = document.createElement('span');
        helpSpan.style.fontSize = 'var(--fs-meta)';
        helpSpan.style.color = 'var(--text-muted)';
        helpSpan.textContent = flag.help;
        checkWrap.appendChild(helpSpan);
      }
      input.dataset.flagId = flag.id;
      input.dataset.flagType = 'boolean';
      row.appendChild(checkWrap);
      container.appendChild(row);
      return;
    } else if (flag.type === 'multi-text') {
      input = document.createElement('textarea');
      input.className = 'launch-textarea';
      input.placeholder = flag.placeholder || 'One value per line';
      if (flag.default) input.value = flag.default;
    } else {
      // text (default)
      input = document.createElement('input');
      input.type = 'text';
      input.className = 'launch-input';
      input.placeholder = flag.placeholder || '';
      if (flag.default !== undefined) input.value = flag.default;
    }

    input.dataset.flagId = flag.id;
    input.dataset.flagType = flag.type || 'text';
    row.appendChild(input);
    container.appendChild(row);
  });
}

function buildAddCrewForm(onAdd, onCancel) {
  var form = document.createElement('div');
  form.className = 'add-crew-form';

  var pathRow = document.createElement('div');
  pathRow.className = 'add-crew-form-row';
  var pathLabel = document.createElement('span');
  pathLabel.className = 'add-crew-form-label';
  pathLabel.textContent = 'Path';
  var pathInput = document.createElement('input');
  pathInput.type = 'text';
  pathInput.className = 'launch-input';
  pathInput.placeholder = '/path/to/agent/workspace';
  pathRow.appendChild(pathLabel);
  pathRow.appendChild(pathInput);
  form.appendChild(pathRow);

  var nameRow = document.createElement('div');
  nameRow.className = 'add-crew-form-row';
  var nameLabel = document.createElement('span');
  nameLabel.className = 'add-crew-form-label';
  nameLabel.textContent = 'Name';
  var nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'launch-input';
  nameInput.placeholder = 'display name';
  nameRow.appendChild(nameLabel);
  nameRow.appendChild(nameInput);
  form.appendChild(nameRow);

  var errLine = document.createElement('div');
  errLine.className = 'launch-error';
  errLine.style.display = 'none';
  form.appendChild(errLine);

  var btnRow = document.createElement('div');
  btnRow.className = 'add-crew-btns';

  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-launch-cancel';
  cancelBtn.style.padding = '4px 12px';
  cancelBtn.style.fontSize = 'var(--fs-meta)';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', onCancel);

  var addBtn = document.createElement('button');
  addBtn.className = 'btn-launch-go';
  addBtn.style.padding = '4px 12px';
  addBtn.style.fontSize = 'var(--fs-meta)';
  addBtn.textContent = 'Add';
  addBtn.addEventListener('click', function() {
    var path = pathInput.value.trim();
    var name = nameInput.value.trim();
    if (!path || !name) {
      errLine.textContent = 'Path and name are required';
      errLine.style.display = '';
      return;
    }
    errLine.style.display = 'none';
    addBtn.disabled = true;
    addBtn.textContent = '...';
    fetch('/api/crew', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, path: path })
    }).then(function(r) { return r.json(); }).then(function(crew) {
      addBtn.disabled = false;
      addBtn.textContent = 'Add';
      if (crew.error) {
        errLine.textContent = crew.error;
        errLine.style.display = '';
        return;
      }
      onAdd(crew);
    }).catch(function() {
      addBtn.disabled = false;
      addBtn.textContent = 'Add';
      errLine.textContent = 'Request failed';
      errLine.style.display = '';
    });
  });

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(addBtn);
  form.appendChild(btnRow);

  return form;
}

function executeLaunch(harnesses, crewList, onResult) {
  var crewSelect = document.getElementById('launch-crew-select');
  var joinAsInput = document.getElementById('launch-join-as');
  var convSelect = document.getElementById('launch-conversation');
  var delaySelect = document.getElementById('launch-inject-delay');
  var goBtn = document.getElementById('launch-go-btn');

  if (!crewSelect || !joinAsInput) return;

  var crewName = crewSelect.value;
  var crew = (crewList || []).find(function(c) { return c.name === crewName; });
  var crewPath = crew ? crew.path : '';
  var harnessRadio = document.querySelector('input[name="launch-harness"]:checked');
  var harnessId = harnessRadio ? harnessRadio.value : null;
  var terminalRadio = document.querySelector('input[name="launch-terminal"]:checked');
  var terminalId = terminalRadio ? terminalRadio.value : 'wezterm';
  var joinAs = joinAsInput.value.trim();
  var convId = convSelect ? convSelect.value : '';
  var delaySec = delaySelect ? parseInt(delaySelect.value, 10) : 4;
  var delayMs = (isFinite(delaySec) ? delaySec : 4) * 1000;

  // Collect flags from rendered flag inputs
  var flagsObj = {};
  document.querySelectorAll('[data-flag-id]').forEach(function(el) {
    var id = el.dataset.flagId;
    var type = el.dataset.flagType;
    if (!id) return;
    if (type === 'boolean') {
      flagsObj[id] = el.checked;
    } else if (type === 'multi-text') {
      var lines = el.value.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l; });
      flagsObj[id] = lines;
    } else {
      flagsObj[id] = el.value;
    }
  });

  var payload = {
    crewName: crewName,
    crewPath: crewPath,
    harness: harnessId,
    flags: flagsObj,
    joinAs: joinAs,
    injectDelay: delayMs,
    terminal: terminalId
  };
  if (convId) payload.conversation = convId;
  if (typeof window.__getLaunchResumeId === 'function') {
    var resumeId = window.__getLaunchResumeId();
    if (resumeId) payload.resumeSessionId = resumeId;
  }

  if (goBtn) goBtn.disabled = true;
  if (goBtn) goBtn.textContent = 'Launching...';

  fetch('/api/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function(r) { return r.json(); }).then(function(result) {
    onResult(result);
  }).catch(function(err) {
    if (goBtn) { goBtn.disabled = false; goBtn.textContent = 'Launch \u2192'; }
    var result = { error: err && err.message ? err.message : 'Network error', status: 'failed' };
    onResult(result);
  });
}

function showLaunchStatus(content, footer, result, convId, joinAs) {
  if (launchCountdownInterval) { clearInterval(launchCountdownInterval); launchCountdownInterval = null; }
  if (launchPollInterval) { clearInterval(launchPollInterval); launchPollInterval = null; }

  content.textContent = '';
  footer.textContent = '';

  var view = document.createElement('div');
  view.className = 'launch-status-view';

  // Status line
  var statusLine = document.createElement('div');
  if (result.error && result.status !== 'pending' && result.status !== 'launched') {
    statusLine.className = 'launch-status-line err';
    statusLine.textContent = '\u2716 Error: ' + result.error;
  } else if (result.paneId != null) {
    statusLine.className = 'launch-status-line ok';
    statusLine.textContent = '\u2713 Pane spawned (ID: ' + result.paneId + ')';
  } else {
    statusLine.className = 'launch-status-line warn';
    statusLine.textContent = '\u26A0 No WezTerm — manual launch';
  }
  view.appendChild(statusLine);

  if (result.paneId != null && !result.error) {
    // Countdown + inject buttons
    launchCurrentId = result.launchId;
    launchCancelledInject = false;

    var delaySelect = document.getElementById('launch-inject-delay');
    var totalDelay = (delaySelect ? parseInt(delaySelect.value) : 4);
    if (!totalDelay || isNaN(totalDelay)) totalDelay = 4;
    var remaining = totalDelay;

    var countWrap = document.createElement('div');
    countWrap.className = 'launch-countdown-wrap';

    var countEl = document.createElement('div');
    countEl.className = 'launch-countdown';
    countEl.textContent = remaining;

    var countLabel = document.createElement('div');
    countLabel.className = 'launch-countdown-label';
    countLabel.textContent = 'Injecting join command in ' + remaining + 's...';

    countWrap.appendChild(countEl);
    countWrap.appendChild(countLabel);
    view.appendChild(countWrap);

    var injectBtns = document.createElement('div');
    injectBtns.className = 'launch-inject-btns';

    var injectNowBtn = document.createElement('button');
    injectNowBtn.className = 'btn-inject-now';
    injectNowBtn.textContent = 'Inject now';
    injectNowBtn.addEventListener('click', function() {
      if (launchCountdownInterval) { clearInterval(launchCountdownInterval); launchCountdownInterval = null; }
      injectBtns.textContent = '';
      doInject(result.launchId, view, convId, joinAs);
    });

    var cancelInjectBtn = document.createElement('button');
    cancelInjectBtn.className = 'btn-inject-cancel';
    cancelInjectBtn.textContent = 'Cancel injection';
    cancelInjectBtn.addEventListener('click', function() {
      if (launchCountdownInterval) { clearInterval(launchCountdownInterval); launchCountdownInterval = null; }
      launchCancelledInject = true;
      injectBtns.textContent = '';
      countWrap.remove();
      var cancelledMsg = document.createElement('div');
      cancelledMsg.className = 'launch-status-line warn';
      cancelledMsg.textContent = '\u2715 Injection cancelled';
      view.insertBefore(cancelledMsg, view.children[1] || null);
    });

    injectBtns.appendChild(injectNowBtn);
    injectBtns.appendChild(cancelInjectBtn);
    view.appendChild(injectBtns);

    launchCountdownInterval = setInterval(function() {
      remaining--;
      countEl.textContent = remaining;
      countLabel.textContent = 'Injecting join command in ' + remaining + 's...';
      if (remaining <= 0) {
        clearInterval(launchCountdownInterval);
        launchCountdownInterval = null;
        if (!launchCancelledInject) {
          injectBtns.textContent = '';
          countWrap.remove();
          doInject(result.launchId, view, convId, joinAs);
        }
      }
    }, 1000);

  } else if (result.command) {
    // Manual mode — show command string
    var manualLabel = document.createElement('div');
    manualLabel.style.fontSize = 'var(--fs-meta)';
    manualLabel.style.color = 'var(--text-muted)';
    manualLabel.textContent = 'Run this command in the agent\'s terminal:';
    view.appendChild(manualLabel);

    var cmdBox = document.createElement('div');
    cmdBox.className = 'manual-command';
    cmdBox.textContent = result.command;
    view.appendChild(cmdBox);

    var copyBtn = document.createElement('button');
    copyBtn.className = 'btn-copy-cmd';
    copyBtn.textContent = 'Copy command';
    copyBtn.addEventListener('click', function() {
      navigator.clipboard.writeText(result.command).then(function() {
        copyBtn.textContent = '\u2713 Copied';
        copyBtn.classList.add('copied');
        setTimeout(function() {
          copyBtn.textContent = 'Copy command';
          copyBtn.classList.remove('copied');
        }, 1500);
      });
    });
    view.appendChild(copyBtn);
  }

  content.appendChild(view);

  // Status footer
  var closeBtn = document.createElement('button');
  closeBtn.className = 'btn-launch-close';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', closeLaunchDialog);

  var anotherBtn = document.createElement('button');
  anotherBtn.className = 'btn-launch-another';
  anotherBtn.textContent = 'Launch Another';
  anotherBtn.addEventListener('click', function() {
    closeLaunchDialog();
    openLaunchDialog();
  });

  footer.appendChild(closeBtn);
  footer.appendChild(anotherBtn);
}

function doInject(launchId, view, convId, joinAs) {
  var doingEl = document.createElement('div');
  doingEl.className = 'launch-status-line';
  doingEl.style.color = 'var(--text-muted)';
  doingEl.textContent = 'Injecting...';
  view.appendChild(doingEl);

  fetch('/api/launch/' + encodeURIComponent(launchId) + '/inject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  }).then(function(r) { return r.json(); }).then(function(res) {
    doingEl.remove();
    if (res.status === 'done' || res.status === 'injected') {
      var doneLine = document.createElement('div');
      doneLine.className = 'launch-done-line';
      var convName = convId ? convId : '(no conversation)';
      doneLine.textContent = '\u2713 Joined ' + convName + ' as ' + joinAs;
      view.appendChild(doneLine);
    } else {
      startLaunchPolling(launchId, view, convId, joinAs);
    }
  }).catch(function(err) {
    doingEl.remove();
    var errLine = document.createElement('div');
    errLine.className = 'launch-status-line err';
    errLine.textContent = '\u2716 Inject failed: ' + (err && err.message ? err.message : 'error');
    view.appendChild(errLine);
  });
}

function startLaunchPolling(launchId, view, convId, joinAs) {
  if (launchPollInterval) { clearInterval(launchPollInterval); launchPollInterval = null; }

  var pollIndicator = document.createElement('div');
  pollIndicator.className = 'launch-status-line';
  pollIndicator.style.color = 'var(--text-muted)';
  pollIndicator.style.fontSize = 'var(--fs-meta)';
  pollIndicator.textContent = 'Waiting for agent...';
  view.appendChild(pollIndicator);

  var joinPill = null;

  function renderJoinPill(kind, text) {
    if (!joinPill) {
      joinPill = document.createElement('div');
      view.appendChild(joinPill);
    }
    joinPill.className = 'join-pill ' + kind;
    joinPill.textContent = text;
    return joinPill;
  }

  function renderJoinTimeoutActions() {
    var actions = document.createElement('div');
    actions.className = 'join-timeout-actions';

    var retryBtn = document.createElement('button');
    retryBtn.className = 'btn-inject-now';
    retryBtn.textContent = 'Retry inject';
    retryBtn.addEventListener('click', function() {
      actions.remove();
      doInject(launchId, view, convId, joinAs);
    });

    var copyBtn = document.createElement('button');
    copyBtn.className = 'btn-copy-cmd';
    copyBtn.textContent = 'Copy command';
    copyBtn.addEventListener('click', function() {
      fetch('/api/launch/' + encodeURIComponent(launchId))
        .then(function(r) { return r.json(); })
        .then(function(res) {
          navigator.clipboard.writeText(res.command || '').then(function() {
            copyBtn.textContent = '\u2713 Copied';
            copyBtn.classList.add('copied');
            setTimeout(function() {
              copyBtn.textContent = 'Copy command';
              copyBtn.classList.remove('copied');
            }, 1500);
          });
        });
    });

    actions.appendChild(retryBtn);
    actions.appendChild(copyBtn);
    view.appendChild(actions);
  }

  var pollCount = 0;
  launchPollInterval = setInterval(function() {
    pollCount++;
    if (pollCount > 30) {
      clearInterval(launchPollInterval); launchPollInterval = null;
      pollIndicator.textContent = 'Timed out waiting for agent';
      pollIndicator.className = 'launch-status-line warn';
      return;
    }
    fetch('/api/launch/' + encodeURIComponent(launchId))
      .then(function(r) { return r.json(); })
      .then(function(res) {
        if (res.status === 'done' || res.status === 'injected') {
          clearInterval(launchPollInterval); launchPollInterval = null;
          pollIndicator.remove();
          var doneLine = document.createElement('div');
          doneLine.className = 'launch-done-line';
          var convName = convId ? convId : '(no conversation)';
          doneLine.textContent = '\u2713 Joined ' + convName + ' as ' + joinAs;
          view.appendChild(doneLine);
        } else if (res.status === 'failed') {
          clearInterval(launchPollInterval); launchPollInterval = null;
          pollIndicator.remove();
          var errLine = document.createElement('div');
          errLine.className = 'launch-status-line err';
          errLine.textContent = '\u2716 Failed: ' + (res.error || 'unknown error');
          view.appendChild(errLine);
        } else if (res.status === 'waiting-join') {
          renderJoinPill('waiting', 'waiting for ' + joinAs + ' to join...');
        } else if (res.status === 'joined') {
          pollIndicator.remove();
          renderJoinPill('ok', '\u2713 ' + joinAs + ' joined');
          setTimeout(function() {
            clearInterval(launchPollInterval); launchPollInterval = null;
          }, 2000);
        } else if (res.status === 'join-timeout') {
          clearInterval(launchPollInterval); launchPollInterval = null;
          pollIndicator.remove();
          renderJoinPill('fail', joinAs + ' did not join');
          renderJoinTimeoutActions();
        }
        // else still pending — keep polling
      }).catch(function() { /* keep polling */ });
  }, 1000);
}

// END LAUNCH DIALOG
// =============================================================================

// =============================================================================
// CREW PANEL
// =============================================================================

var crewPanelOverlay = null;

function openCrewPanel() {
  closeCrewPanel();

  var overlay = document.createElement('div');
  overlay.className = 'crew-panel-overlay';
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeCrewPanel();
  });

  var box = document.createElement('div');
  box.className = 'crew-panel-box';

  var hdr = document.createElement('div');
  hdr.className = 'crew-panel-header';
  var title = document.createElement('div');
  title.className = 'crew-panel-title';
  title.textContent = '\u{1F465} Crew';
  var closeBtn = document.createElement('button');
  closeBtn.className = 'crew-panel-close';
  closeBtn.textContent = '×';
  closeBtn.title = 'Close';
  closeBtn.addEventListener('click', closeCrewPanel);
  hdr.appendChild(title);
  hdr.appendChild(closeBtn);
  box.appendChild(hdr);

  var content = document.createElement('div');
  content.className = 'crew-panel-content';
  content.appendChild(buildLaunchLoading());
  box.appendChild(content);

  var footer = document.createElement('div');
  footer.className = 'crew-panel-footer';
  var doneBtn = document.createElement('button');
  doneBtn.className = 'btn-launch-cancel';
  doneBtn.textContent = 'Close';
  doneBtn.addEventListener('click', closeCrewPanel);
  footer.appendChild(doneBtn);
  box.appendChild(footer);

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  crewPanelOverlay = overlay;

  Promise.all([
    fetch('/api/crew').then(function(r) { return r.json(); }).catch(function() { return []; }),
    fetch('/api/crew/meta').then(function(r) { return r.json(); }).catch(function() { return {}; }),
    fetch('/api/harnesses').then(function(r) { return r.json(); }).catch(function() { return []; })
  ]).then(function(results) {
    buildCrewPanel(content, results[0] || [], results[1] || {}, results[2] || []);
  }).catch(function(err) {
    content.textContent = '';
    var errMsg = document.createElement('div');
    errMsg.className = 'launch-error';
    errMsg.textContent = 'Failed to load crew: ' + (err && err.message ? err.message : 'network error');
    content.appendChild(errMsg);
  });
}

function closeCrewPanel() {
  var wasOpen = !!crewPanelOverlay;
  if (crewPanelOverlay) { crewPanelOverlay.remove(); crewPanelOverlay = null; }
  if (wasOpen && !signedOut) loadCrewRoster(); // harness labels follow roster edits
}

function buildCrewPanel(content, crewList, meta, harnesses) {
  content.textContent = '';

  var actions = document.createElement('div');
  actions.className = 'crew-panel-actions';
  var newBtn = document.createElement('button');
  newBtn.className = 'btn-crew-new';
  newBtn.textContent = '+ New crew member';
  actions.appendChild(newBtn);
  content.appendChild(actions);

  var list = document.createElement('div');
  list.className = 'crew-panel-list';

  function refreshList() {
    fetch('/api/crew').then(function(r) { return r.json(); }).then(function(updated) {
      renderCrewRows(list, updated || [], refreshList);
    }).catch(function() {
      renderCrewRows(list, [], refreshList);
    });
  }

  var form = buildCrewScaffoldForm(meta, harnesses, refreshList);
  form.style.display = 'none';
  content.appendChild(form);

  newBtn.addEventListener('click', function() {
    var opening = form.style.display === 'none';
    form.style.display = opening ? '' : 'none';
    newBtn.textContent = opening ? 'Cancel' : '+ New crew member';
    if (opening) {
      var nameInput = document.getElementById('crew-new-name');
      if (nameInput) nameInput.focus();
    }
  });

  content.appendChild(list);
  renderCrewRows(list, crewList, refreshList);
}

function renderCrewRows(list, crewList, onChanged) {
  list.textContent = '';
  if (!Array.isArray(crewList) || crewList.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'crew-panel-empty';
    empty.textContent = 'No crew members yet. Use "New crew member" to scaffold one.';
    list.appendChild(empty);
    return;
  }
  crewList.forEach(function(crew) {
    list.appendChild(buildCrewRow(crew, onChanged));
  });
}

function buildCrewRow(crew, onChanged) {
  var row = document.createElement('div');
  row.className = 'crew-row';

  var emoji = document.createElement('span');
  emoji.className = 'crew-row-emoji';
  emoji.textContent = crew.emoji || '\u{1F464}';
  row.appendChild(emoji);

  var main = document.createElement('div');
  main.className = 'crew-row-main';

  var titleLine = document.createElement('div');
  titleLine.className = 'crew-row-title';
  var nameEl = document.createElement('span');
  nameEl.className = 'crew-row-name';
  nameEl.textContent = crew.name;
  titleLine.appendChild(nameEl);
  if (crew.role) {
    var roleEl = document.createElement('span');
    roleEl.className = 'crew-row-role';
    roleEl.textContent = crew.role;
    titleLine.appendChild(roleEl);
  }
  main.appendChild(titleLine);

  var pathEl = document.createElement('div');
  pathEl.className = 'crew-row-path';
  pathEl.textContent = crew.path || '(no path)';
  if (crew.path) pathEl.title = crew.path;
  main.appendChild(pathEl);

  var badges = document.createElement('div');
  badges.className = 'crew-row-badges';

  var idBadge = document.createElement('span');
  idBadge.className = 'status-badge ' + (crew.identityExists ? 'ok' : 'warn');
  idBadge.textContent = crew.identityExists ? '✓ identity' : '⚠ no identity';
  if (crew.identityFile) idBadge.title = crew.identityFile;
  badges.appendChild(idBadge);

  var hasSomeMcp = crew.hasMcpConfig ||
    (crew.mcpConfig && typeof crew.mcpConfig === 'object' &&
      Object.values(crew.mcpConfig).some(function(v) { return !!v; }));
  var mcpBadge = document.createElement('span');
  mcpBadge.className = 'status-badge ' + (hasSomeMcp ? 'ok' : 'warn');
  mcpBadge.textContent = hasSomeMcp ? '✓ MCP' : '⚠ no MCP';
  badges.appendChild(mcpBadge);

  if (crew.defaultHarness) {
    var harnessBadge = document.createElement('span');
    harnessBadge.className = 'status-badge missing';
    harnessBadge.textContent = crew.defaultHarness;
    harnessBadge.title = 'Default harness';
    badges.appendChild(harnessBadge);
  }

  main.appendChild(badges);
  row.appendChild(main);

  var btns = document.createElement('div');
  btns.className = 'crew-row-btns';

  var launchBtn = document.createElement('button');
  launchBtn.className = 'crew-row-btn';
  launchBtn.textContent = 'Launch';
  launchBtn.title = 'Open the launch dialog with ' + crew.name + ' selected';
  launchBtn.addEventListener('click', function() {
    closeCrewPanel();
    openLaunchDialog(crew.name);
  });
  btns.appendChild(launchBtn);

  var editBtn = document.createElement('button');
  editBtn.className = 'crew-row-btn';
  editBtn.textContent = '✎ Edit';
  editBtn.title = 'Edit role, emoji, join name and default conversation';
  editBtn.addEventListener('click', function() {
    row.textContent = '';
    row.classList.add('editing');
    buildCrewEditForm(row, crew, onChanged);
  });
  btns.appendChild(editBtn);

  var errLine = document.createElement('div');
  errLine.className = 'launch-error crew-row-error';
  errLine.style.display = 'none';

  var deleteBtn = document.createElement('button');
  deleteBtn.className = 'crew-row-btn danger';
  deleteBtn.textContent = 'Delete';
  deleteBtn.title = 'Remove the crew entry only. The folder on disk is left in place.';
  var armed = false;
  var armTimer = null;
  function disarmDelete() {
    armed = false;
    if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    deleteBtn.textContent = 'Delete';
    deleteBtn.classList.remove('armed');
  }
  deleteBtn.addEventListener('click', function() {
    if (!armed) {
      armed = true;
      deleteBtn.textContent = 'Really delete?';
      deleteBtn.classList.add('armed');
      armTimer = setTimeout(disarmDelete, 3000);
      return;
    }
    if (armTimer) { clearTimeout(armTimer); armTimer = null; }
    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Deleting...';
    fetch('/api/crew/' + encodeURIComponent(crew.name), { method: 'DELETE' })
      .then(function(r) { return r.json(); })
      .then(function(res) {
        if (res && res.error) {
          deleteBtn.disabled = false;
          disarmDelete();
          errLine.textContent = res.error;
          errLine.style.display = '';
          return;
        }
        onChanged();
      })
      .catch(function() {
        deleteBtn.disabled = false;
        disarmDelete();
        errLine.textContent = 'Delete failed';
        errLine.style.display = '';
      });
  });
  btns.appendChild(deleteBtn);

  row.appendChild(btns);
  row.appendChild(errLine);
  return row;
}

function buildCrewEditForm(row, crew, onChanged) {
  var form = document.createElement('div');
  form.className = 'crew-edit-form';

  var heading = document.createElement('div');
  heading.className = 'crew-edit-heading';
  heading.textContent = 'Editing ' + crew.name;
  form.appendChild(heading);

  function addField(labelText, value, placeholder, maxLength) {
    var fieldRow = document.createElement('div');
    fieldRow.className = 'add-crew-form-row';
    var label = document.createElement('span');
    label.className = 'add-crew-form-label';
    label.textContent = labelText;
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'launch-input';
    input.value = value || '';
    if (placeholder) input.placeholder = placeholder;
    if (maxLength) input.maxLength = maxLength;
    fieldRow.appendChild(label);
    fieldRow.appendChild(input);
    form.appendChild(fieldRow);
    return input;
  }

  var roleInput = addField('Role', crew.role, 'e.g. reviewer');
  var emojiInput = addField('Emoji', crew.emoji, '\u{1F464}', 4);
  var joinAsInput = addField('Join as', crew.joinAs, 'agent name');
  var convInput = addField('Conv', crew.defaultConversation, 'default conversation');

  var errLine = document.createElement('div');
  errLine.className = 'launch-error';
  errLine.style.display = 'none';
  form.appendChild(errLine);

  var btnRow = document.createElement('div');
  btnRow.className = 'add-crew-btns';

  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-launch-cancel';
  cancelBtn.style.padding = '4px 12px';
  cancelBtn.style.fontSize = 'var(--fs-meta)';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', function() { onChanged(); });

  var saveBtn = document.createElement('button');
  saveBtn.className = 'btn-launch-go';
  saveBtn.style.padding = '4px 12px';
  saveBtn.style.fontSize = 'var(--fs-meta)';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', function() {
    errLine.style.display = 'none';
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    var payload = {
      role: roleInput.value.trim(),
      emoji: emojiInput.value.trim(),
      joinAs: joinAsInput.value.trim(),
      defaultConversation: convInput.value.trim()
    };
    fetch('/api/crew/' + encodeURIComponent(crew.name), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function(r) { return r.json(); }).then(function(res) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
      if (res && res.error) {
        errLine.textContent = res.error;
        errLine.style.display = '';
        return;
      }
      onChanged();
    }).catch(function() {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
      errLine.textContent = 'Save failed';
      errLine.style.display = '';
    });
  });

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(saveBtn);
  form.appendChild(btnRow);

  row.appendChild(form);
  roleInput.focus();
}

function buildCrewScaffoldForm(meta, harnesses, onScaffolded) {
  var form = document.createElement('div');
  form.className = 'add-crew-form crew-scaffold-form';

  function addRow(labelText, input) {
    var fieldRow = document.createElement('div');
    fieldRow.className = 'add-crew-form-row';
    var label = document.createElement('span');
    label.className = 'add-crew-form-label';
    label.textContent = labelText;
    fieldRow.appendChild(label);
    fieldRow.appendChild(input);
    form.appendChild(fieldRow);
  }

  function textInput(id, placeholder, maxLength) {
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'launch-input';
    input.id = id;
    if (placeholder) input.placeholder = placeholder;
    if (maxLength) input.maxLength = maxLength;
    return input;
  }

  var nameInput = textInput('crew-new-name', 'Scout');
  addRow('Name', nameInput);

  var joinAsInput = textInput('crew-new-join-as', 'agent name used to join');
  addRow('Join as', joinAsInput);

  // Join name tracks the name until the user types their own.
  var joinAsTouched = false;
  joinAsInput.addEventListener('input', function() { joinAsTouched = true; });
  nameInput.addEventListener('input', function() {
    if (!joinAsTouched) joinAsInput.value = nameInput.value;
  });

  var roleInput = textInput('crew-new-role', 'e.g. reviewer');
  addRow('Role', roleInput);

  var emojiInput = textInput('crew-new-emoji', '\u{1F464}', 4);
  addRow('Emoji', emojiInput);

  var parentInput = textInput('crew-new-parent', 'parent folder');
  parentInput.value = meta && meta.crewHome ? meta.crewHome : '';
  parentInput.title = 'The crew folder is created inside this directory';
  addRow('Folder', parentInput);

  var harnessSelect = document.createElement('select');
  harnessSelect.className = 'launch-select';
  harnessSelect.id = 'crew-new-harness';
  var noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '(no default)';
  harnessSelect.appendChild(noneOpt);
  (harnesses || []).forEach(function(h) {
    var opt = document.createElement('option');
    opt.value = h.id;
    opt.textContent = h.installed ? h.label : h.label + ' (not installed)';
    harnessSelect.appendChild(opt);
  });
  addRow('Harness', harnessSelect);

  var convInput = textInput('crew-new-conversation', 'optional');
  addRow('Conv', convInput);

  var errLine = document.createElement('div');
  errLine.className = 'launch-error';
  errLine.style.display = 'none';
  form.appendChild(errLine);

  var resultBlock = document.createElement('div');
  resultBlock.className = 'crew-scaffold-result';
  resultBlock.style.display = 'none';
  form.appendChild(resultBlock);

  var btnRow = document.createElement('div');
  btnRow.className = 'add-crew-btns';

  var createBtn = document.createElement('button');
  createBtn.className = 'btn-launch-go';
  createBtn.style.padding = '4px 12px';
  createBtn.style.fontSize = 'var(--fs-meta)';
  createBtn.textContent = 'Create';
  createBtn.addEventListener('click', function() {
    var name = nameInput.value.trim();
    errLine.style.display = 'none';
    if (!name) {
      errLine.textContent = 'Name is required';
      errLine.style.display = '';
      return;
    }
    var payload = { name: name };
    if (parentInput.value.trim()) payload.parentDir = parentInput.value.trim();
    if (joinAsInput.value.trim()) payload.joinAs = joinAsInput.value.trim();
    if (roleInput.value.trim()) payload.role = roleInput.value.trim();
    if (emojiInput.value.trim()) payload.emoji = emojiInput.value.trim();
    if (harnessSelect.value) payload.defaultHarness = harnessSelect.value;
    if (convInput.value.trim()) payload.defaultConversation = convInput.value.trim();

    createBtn.disabled = true;
    createBtn.textContent = 'Creating...';
    fetch('/api/crew/scaffold', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function(r) {
      return r.json().then(function(body) { return { ok: r.ok, body: body }; });
    }).then(function(res) {
      createBtn.disabled = false;
      createBtn.textContent = 'Create';
      if (!res.ok || (res.body && res.body.error)) {
        errLine.textContent = (res.body && res.body.error) || 'Scaffold failed';
        errLine.style.display = '';
        return;
      }
      renderScaffoldResult(resultBlock, res.body);
      nameInput.value = '';
      joinAsInput.value = '';
      roleInput.value = '';
      emojiInput.value = '';
      convInput.value = '';
      joinAsTouched = false;
      onScaffolded();
    }).catch(function() {
      createBtn.disabled = false;
      createBtn.textContent = 'Create';
      errLine.textContent = 'Request failed';
      errLine.style.display = '';
    });
  });

  btnRow.appendChild(createBtn);
  form.appendChild(btnRow);

  return form;
}

function renderScaffoldResult(block, result) {
  block.textContent = '';
  block.style.display = '';

  var folderLine = document.createElement('div');
  folderLine.className = 'crew-scaffold-folder';
  folderLine.textContent = result.folder || '';
  folderLine.title = result.folder || '';
  block.appendChild(folderLine);

  var items = document.createElement('div');
  items.className = 'crew-scaffold-items';
  (result.created || []).forEach(function(entry) {
    var badge = document.createElement('span');
    badge.className = 'status-badge ok';
    badge.textContent = '✓ ' + entry;
    items.appendChild(badge);
  });
  (result.skipped || []).forEach(function(entry) {
    var badge = document.createElement('span');
    badge.className = 'status-badge warn';
    badge.textContent = '• ' + entry + ' (existed)';
    items.appendChild(badge);
  });
  block.appendChild(items);
}

// END CREW PANEL
// =============================================================================

function sendReaction(messageId, emoji) {
  var sender = document.getElementById('sender-name').value || 'human';
  fetch('/api/message/' + messageId + '/react', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: sender, emoji: emoji })
  });
}

function updateReactionPills(messageId) {
  // Refresh reaction pills from server
  fetch('/api/message/' + messageId + '?viewer=' + encodeURIComponent(myName()) + '&token=' + encodeURIComponent(webToken()))
    .then(function(r) { return r.json(); })
    .then(function() {
      // Fetch all reactions for the active conversation and rebuild for this message
      if (!activeConversation) return;
      var row = document.querySelector('.msg-reactions[data-message-id="' + messageId + '"]');
      if (!row) return;
      // Find reactions for this message from our local cache
      var msgReactions = allReactions.filter(function(r) { return r.messageId === messageId; });
      renderReactionRow(row, messageId, msgReactions);
    });
}

function renderReactionRow(row, messageId, reactions) {
  row.textContent = '';
  if (!reactions || reactions.length === 0) return;
  // Group by emoji
  var groups = {};
  reactions.forEach(function(r) {
    if (!groups[r.emoji]) groups[r.emoji] = [];
    groups[r.emoji].push(r.sender);
  });
  Object.keys(groups).forEach(function(emoji) {
    var pill = document.createElement('span');
    pill.className = 'reaction-pill';
    pill.textContent = emoji + ' ' + groups[emoji].length;
    pill.title = groups[emoji].join(', ');
    pill.addEventListener('click', function() {
      var sender = document.getElementById('sender-name').value || 'human';
      fetch('/api/message/' + messageId + '/react', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: sender, emoji: emoji })
      });
    });
    row.appendChild(pill);
  });
}

function handleMessageEdited(data) {
  // Update in-memory message
  var msg = allMessages.find(function(m) { return m.id === data.messageId; });
  if (msg) {
    msg.text = data.newText;
    msg.edited = true;
  }
  // Update DOM
  var el = document.querySelector('.message[data-id="' + data.messageId + '"]');
  if (!el) return;
  var tw = el.querySelector('.msg-text-wrap');
  if (tw) {
    // Re-render text
    tw.textContent = '';
    renderContent(tw, data.newText, el.dataset.conv);
    // Add edited badge if not present
    if (!tw.querySelector('.msg-edited-badge')) {
      var badge = document.createElement('span');
      badge.className = 'msg-edited-badge';
      badge.textContent = '(edited)';
      badge.title = 'Message has been edited';
      tw.appendChild(badge);
    }
  }
}

// --- Search ---
var searchDebounce = null;
var searchInputWired = false;
function toggleSearch() {
  var bar = document.getElementById('search-bar');
  bar.classList.toggle('hidden');
  if (!bar.classList.contains('hidden')) {
    var inp = document.getElementById('search-input');
    inp.focus();
    // Wired once: every open used to add another input listener.
    if (!searchInputWired) {
      searchInputWired = true;
      inp.addEventListener('input', function() {
        clearTimeout(searchDebounce);
        // The shown results answer the old text: drop anything still in
        // flight for it and make them inert until the new query renders.
        searchSeq++;
        setSearchResultsStale(true);
        searchDebounce = setTimeout(doSearch, 300);
      });
      inp.addEventListener('keydown', onSearchInputKeydown);
    }
  }
  syncRailPanels();
}
// Results left from an earlier query text can be neither clicked nor
// focused (inert) and are dimmed, until the current query's answer lands.
function setSearchResultsStale(stale) {
  var results = document.getElementById('search-results');
  if (!results) return;
  results.inert = stale;
  results.classList.toggle('search-results-stale', stale);
}

function closeSearch() {
  document.getElementById('search-bar').classList.add('hidden');
  document.getElementById('search-results').textContent = '';
  setSearchResultsStale(false);
  document.getElementById('search-input').value = '';
  renderSearchChips('');
  searchSeq++;
  searchState = null;
  syncRailPanels();
}
// Switch to the view that owns a message, then reveal it. Targeted
// messages open their DM thread; channel messages return to channel view.
function openMessageInView(msg) {
  // The loader opens the DM thread for a targeted message, the channel
  // (and the window around it) for a public one.
  jumpToMessage(msg.conversationId || currentConvId(), msg.id, msg);
}

// Search the room being viewed with the query grammar the server parses
// (src/search.ts): from:<name>, @<name> or mentions:<name>, #<a>-<b> for an
// id range, and free words (all must match). The active terms show as chips
// under the box; results page newest first with a "More" button.
var SEARCH_PAGE = 20;
var searchSeq = 0;
var searchState = null; // { conv, q, nextBefore }

// The same tokens as the server grammar, for the chips only (the server
// parses the query again and is the authority on what matches).
function parseSearchChips(q) {
  var chips = [];
  var re = /"([^"]*)"|(\S+)/g;
  var m;
  while ((m = re.exec(q.slice(0, 500))) !== null) {
    var raw = m[0];
    if (m[1] !== undefined) {
      if (m[1].trim()) chips.push({ kind: 'word', label: '"' + m[1].trim() + '"', raw: raw });
      continue;
    }
    var tok = m[2];
    var lower = tok.toLowerCase();
    var name;
    if (lower.indexOf('from:') === 0 && /^\w[\w-]*$/.test(name = tok.slice(5))) {
      chips.push({ kind: 'from', label: 'from: ' + name, raw: raw });
    } else if (lower.indexOf('mentions:') === 0 && /^\w[\w-]*$/.test(name = tok.slice(9).replace(/^@/, ''))) {
      chips.push({ kind: 'mention', label: 'mentions: @' + name, raw: raw });
    } else if (tok.charAt(0) === '@' && /^\w[\w-]*$/.test(name = tok.slice(1))) {
      chips.push({ kind: 'mention', label: 'mentions: @' + name, raw: raw });
    } else if (/^#\d{1,15}-#?\d{1,15}$/.test(tok)) {
      var parts = tok.replace(/#/g, '').split('-');
      var a = Number(parts[0]), b = Number(parts[1]);
      chips.push({ kind: 'range', label: 'ids #' + Math.min(a, b) + ' to #' + Math.max(a, b), raw: raw });
    } else {
      chips.push({ kind: 'word', label: tok, raw: raw });
    }
  }
  return chips;
}

function renderSearchChips(q) {
  var row = document.getElementById('search-chips');
  if (!row) return;
  row.textContent = '';
  var chips = parseSearchChips(q);
  if (chips.length === 0) { row.hidden = true; return; }
  row.hidden = false;
  chips.forEach(function(chip, idx) {
    var el = document.createElement('span');
    el.className = 'search-chip search-chip-' + chip.kind;
    var label = document.createElement('span');
    label.textContent = chip.label;
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'search-chip-x';
    x.setAttribute('aria-label', 'Remove filter ' + chip.label);
    x.textContent = '×';
    x.addEventListener('click', function() {
      var rest = chips.filter(function(_, i) { return i !== idx; }).map(function(c) { return c.raw; });
      var inp = document.getElementById('search-input');
      inp.value = rest.join(' ');
      inp.focus();
      doSearch();
    });
    el.appendChild(label);
    el.appendChild(x);
    row.appendChild(el);
  });
  var clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'btn-link search-chips-clear';
  clear.textContent = 'Clear';
  clear.addEventListener('click', function() {
    var inp = document.getElementById('search-input');
    inp.value = '';
    inp.focus();
    doSearch();
  });
  row.appendChild(clear);
}

function searchResultItem(msg, conv) {
  var item = document.createElement('div');
  item.className = 'search-result-item';
  item.setAttribute('role', 'option');
  item.tabIndex = 0;
  var sender = document.createElement('span');
  sender.className = 'search-result-sender';
  sender.style.color = getSenderColor(msg.sender);
  sender.textContent = msg.sender;
  var text = document.createElement('span');
  text.className = 'search-result-text';
  text.textContent = (msg.text || '').slice(0, 120);
  var id = document.createElement('span');
  id.className = 'search-result-id';
  id.textContent = '#' + msg.id;
  item.appendChild(sender);
  item.appendChild(text);
  item.appendChild(id);
  var open = function() {
    closeSearch();
    jumpToMessage(conv, msg.id, msg);
  };
  item.addEventListener('click', open);
  item.addEventListener('keydown', function(e) { if (e.key === 'Enter') open(); });
  return item;
}

// The message id when the whole query is one message number, else null.
function bareMessageNumber(q) {
  return window.joindUi ? window.joindUi.parseBareMessageNumber(q) : null;
}

// The "Go to message #N" result: fetched through the same endpoint as the
// #N links, so the server's DM visibility applies (fails closed), and a
// DM this viewer is not party to reads as not found, as the loader does.
// It fills in place when its fetch lands.
function gotoResultItem(conv, id) {
  var item = document.createElement('div');
  item.className = 'search-result-item search-goto';
  item.setAttribute('role', 'option');
  var head = document.createElement('span');
  head.className = 'search-goto-label';
  head.textContent = 'Go to message #' + id;
  var body = document.createElement('span');
  body.className = 'search-result-text';
  body.textContent = 'Loading';
  item.appendChild(head);
  item.appendChild(body);
  var showMissing = function(text) {
    item.classList.add('search-goto-missing');
    item.removeAttribute('tabindex');
    head.textContent = text;
    body.textContent = '';
  };
  fetch('/api/message/' + id + '?conversation=' + encodeURIComponent(conv) + '&token=' + encodeURIComponent(webToken()))
    .then(function(r) { return r.json().then(function(b) { return { ok: r.ok, body: b }; }); })
    .then(function(res) {
      // Superseded (a new query, a cleared or closed search) once detached;
      // paging the mentions keeps it.
      if (!item.isConnected) return;
      var msg = res.body;
      if (!res.ok || !msg || (msg.to && !dmPartnerOf(msg))) { showMissing(refNotFoundText(id, res.ok ? null : msg)); return; }
      var sender = document.createElement('span');
      sender.className = 'search-result-sender';
      sender.style.color = getSenderColor(msg.sender);
      sender.textContent = msg.sender;
      item.insertBefore(sender, body);
      body.textContent = String(msg.text || '').split('\n')[0].slice(0, 120);
      var time = document.createElement('span');
      time.className = 'search-result-id';
      time.textContent = msg.timestamp ? formatDay(msg.timestamp) + ' ' + formatTimeShort(msg.timestamp) : '';
      item.appendChild(time);
      item.tabIndex = 0;
      var open = function() {
        closeSearch();
        jumpToMessage(conv, id, msg);
      };
      item.addEventListener('click', open);
      item.addEventListener('keydown', function(e) { if (e.key === 'Enter') open(); });
    })
    .catch(function() { if (item.isConnected) showMissing('Could not load message #' + id); });
  return item;
}

// Enter on a bare message number jumps straight to it (the #N loader shows
// the not-found notice when it is missing or not visible to this viewer).
function onSearchInputKeydown(e) {
  if (e.key !== 'Enter' || e.isComposing) return;
  var id = bareMessageNumber(this.value);
  var conv = currentConvId();
  if (!id || !conv) return;
  e.preventDefault();
  clearTimeout(searchDebounce);
  closeSearch();
  jumpToMessage(conv, id);
}

// `more`: fetch the next (older) page of the current query and append it.
function doSearch(more) {
  var q = document.getElementById('search-input').value.trim();
  var results = document.getElementById('search-results');
  renderSearchChips(q);
  var conv = currentConvId();
  if (!q || !conv) { searchSeq++; searchState = null; results.textContent = ''; setSearchResultsStale(false); return; }
  var before = null;
  if (more === true && searchState && searchState.q === q && searchState.conv === conv) before = searchState.nextBefore;
  var mySeq = ++searchSeq;
  // A bare message number (1234 or #1234) goes to that message first; the
  // text matches below it are the messages citing it (#1234).
  var bareId = bareMessageNumber(q);
  var serverQ = bareId ? '#' + bareId : q;
  // A new query keeps the old results inert until its answer lands; the
  // bare-number view is laid out fresh at once.
  if (!before) setSearchResultsStale(!bareId);
  if (bareId && !before) {
    results.textContent = '';
    results.appendChild(gotoResultItem(conv, bareId));
    var label = document.createElement('div');
    label.className = 'search-section-label';
    label.textContent = 'Mentions of #' + bareId;
    results.appendChild(label);
  }
  var url = '/api/search?page=1&conversation=' + encodeURIComponent(conv) + '&q=' + encodeURIComponent(serverQ) +
    '&limit=' + SEARCH_PAGE + (before ? '&before=' + before : '') + '&token=' + encodeURIComponent(webToken());
  fetch(url)
    .then(function(r) { return r.json().then(function(body) { return { ok: r.ok, body: body }; }); })
    .then(function(res) {
      if (mySeq !== searchSeq) return;
      setSearchResultsStale(false);
      // The bare-number view was laid out when the query started.
      if (!before && !bareId) results.textContent = '';
      var oldMore = document.getElementById('search-more');
      if (oldMore) oldMore.remove();
      var oldNote = document.getElementById('search-coverage');
      if (oldNote) oldNote.remove();
      var body = res.body || {};
      var list = res.ok && Array.isArray(body.results) ? body.results : [];
      if (!before && list.length === 0) {
        var none = document.createElement('div');
        none.className = 'search-empty';
        none.textContent = !res.ok ? 'Search failed' : bareId ? 'No mentions' : 'No results';
        results.appendChild(none);
      }
      list.forEach(function(r) { results.appendChild(searchResultItem(r.message, conv)); });
      searchState = { conv: conv, q: q, nextBefore: body.nextBefore || null };
      if (body.nextBefore) {
        var moreBtn = document.createElement('button');
        moreBtn.type = 'button';
        moreBtn.id = 'search-more';
        moreBtn.className = 'btn btn-sm search-more';
        moreBtn.textContent = 'More results';
        moreBtn.addEventListener('click', function() { doSearch(true); });
        results.appendChild(moreBtn);
      }
      if (body.coverage && !body.coverage.complete) {
        var note = document.createElement('div');
        note.id = 'search-coverage';
        note.className = 'search-coverage';
        note.textContent = body.coverage.oldestId
          ? 'Remote room: only messages from #' + body.coverage.oldestId + ' on are held here; older history on its home server is not searched.'
          : 'Remote room: older history on its home server is not searched.';
        results.appendChild(note);
      }
    })
    .catch(function() {
      if (mySeq !== searchSeq) return;
      results.textContent = 'Search failed';
      setSearchResultsStale(false);
    });
}

// ============================================================
// Notification bell: high-signal feed (crew joins/leaves, action
// required, task picked/completed, session start/end). Everything
// else stays in the chat. Server classifies; this only renders.
// ============================================================

var notifyItems = [];
var notifyUnread = 0;
var notifyPanelOpen = false;
var notifyGeneration = null;
// Bumped whenever we move to a new server generation; in-flight fetches
// from an older world check it and discard themselves.
var notifyEpoch = 0;

function adoptNotifyGeneration(gen) {
  if (!gen || gen === notifyGeneration) return;
  notifyGeneration = gen;
  notifyEpoch++;
  notifyItems = [];
  notifyUnread = 0;
}

var NOTIFY_ICONS = {
  'crew-joined': '👋',
  'crew-left': '🚪',
  'action-required': '❗',
  'task-picked': '🤝',
  'task-completed': '✅',
  'session-started': '🧠',
  'session-ended': '🏁'
};

function loadNotifications() {
  var epochAtStart = notifyEpoch;
  fetch('/api/notifications').then(function(r) { return r.json(); }).then(function(data) {
    if (data.generation && data.generation !== notifyGeneration) {
      // A live WS event already moved us to a different world while this
      // fetch was in flight: the response is from a dead server, drop it.
      if (notifyEpoch !== epochAtStart) return;
      // New server generation: ids restarted at 1, local state is from a
      // previous world. Reset, then fall through to merge the snapshot
      // (the merge also keeps any same-generation WS arrival that raced
      // ahead of this fetch, because adoption via WS bumped the epoch).
      adoptNotifyGeneration(data.generation);
    }
    // Merge by id within one generation: WS arrivals during the fetch must
    // survive an older snapshot, and the snapshot must not resurrect rows
    // we marked read.
    var byId = {};
    (data.notifications || []).forEach(function(n) { byId[n.id] = n; });
    notifyItems.forEach(function(n) {
      if (!byId[n.id] || n.read) byId[n.id] = n;
    });
    notifyItems = Object.keys(byId).map(function(k) { return byId[k]; })
      .sort(function(a, b) { return b.id - a.id; })
      .slice(0, 100);
    notifyUnread = notifyItems.reduce(function(acc, n) { return acc + (n.read ? 0 : 1); }, 0);
    renderNotifyBadge();
    if (notifyPanelOpen) renderNotifyPanel();
  }).catch(function() {});
}

function renderNotifyBadge() {
  var badge = document.getElementById('notify-badge');
  if (!badge) return;
  if (notifyUnread > 0) {
    badge.textContent = notifyUnread > 99 ? '99+' : String(notifyUnread);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function onNotification(n, generation) {
  if (generation && notifyGeneration === null) {
    // First generation sighting still bumps the epoch so a fetch that was
    // already in flight from an unknown world discards itself on arrival.
    notifyGeneration = generation;
    notifyEpoch++;
  } else if (generation) {
    adoptNotifyGeneration(generation);
  }
  notifyItems.unshift(n);
  if (notifyItems.length > 100) notifyItems.length = 100;
  notifyUnread++;
  renderNotifyBadge();
  if (notifyPanelOpen) renderNotifyPanel();
  if (n.kind === 'action-required') {
    playSound('alert-tone');
    maybeBrowserNotify(n);
  }
}

function maybeBrowserNotify(n) {
  try {
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible') return;
    var title = (n.conversationName ? '[' + n.conversationName + '] ' : '') + 'Action required';
    new Notification(title, { body: n.text, tag: 'joind-' + n.id });
  } catch (err) { /* notification errors never break the app */ }
}

function toggleNotifyPanel() {
  if (notifyPanelOpen) { closeNotifyPanel(); return; }
  notifyPanelOpen = true;
  var overlay = document.createElement('div');
  overlay.className = 'notify-panel-overlay';
  overlay.id = 'notify-panel-overlay';
  overlay.addEventListener('click', function(e) { if (e.target === overlay) closeNotifyPanel(); });

  var box = document.createElement('div');
  box.className = 'notify-panel';

  var hdr = document.createElement('div');
  hdr.className = 'notify-panel-header';
  var title = document.createElement('span');
  title.textContent = 'Notifications';
  hdr.appendChild(title);

  var actions = document.createElement('div');
  actions.className = 'notify-panel-actions';
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    var enableBtn = document.createElement('button');
    enableBtn.className = 'btn notify-enable-btn';
    enableBtn.textContent = 'Enable alerts';
    enableBtn.title = 'Browser notifications for action-required items while this tab is in the background';
    enableBtn.addEventListener('click', function() {
      Notification.requestPermission().then(function() { enableBtn.remove(); });
    });
    actions.appendChild(enableBtn);
  }
  var markBtn = document.createElement('button');
  markBtn.className = 'btn notify-mark-btn';
  markBtn.textContent = 'Mark all read';
  markBtn.addEventListener('click', function() {
    // Capture a cutoff so an alert arriving mid-request stays unread on
    // both sides instead of being cleared locally but not on the server.
    var cutoff = notifyItems.length > 0 ? notifyItems[0].id : 0;
    if (cutoff === 0) return;
    fetch('/api/notifications/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upToId: cutoff }) })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        notifyItems.forEach(function(n) { if (n.id <= cutoff) n.read = true; });
        notifyUnread = notifyItems.reduce(function(acc, n) { return acc + (n.read ? 0 : 1); }, 0);
        renderNotifyBadge();
        renderNotifyPanel();
      }).catch(function() {});
  });
  actions.appendChild(markBtn);
  hdr.appendChild(actions);
  box.appendChild(hdr);

  var list = document.createElement('div');
  list.className = 'notify-panel-list';
  list.id = 'notify-panel-list';
  box.appendChild(list);

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  renderNotifyPanel();
  loadNotifications();
  syncRailPanels();
}

function closeNotifyPanel() {
  notifyPanelOpen = false;
  var overlay = document.getElementById('notify-panel-overlay');
  if (overlay) overlay.remove();
  syncRailPanels();
}

function renderNotifyPanel() {
  var list = document.getElementById('notify-panel-list');
  if (!list) return;
  list.textContent = '';
  if (notifyItems.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'notify-empty';
    empty.textContent = 'All quiet. The bell only rings for the important stuff.';
    list.appendChild(empty);
    return;
  }
  notifyItems.forEach(function(n) {
    var row = document.createElement('div');
    row.className = 'notify-row' + (n.read ? '' : ' unread') + (n.kind === 'action-required' ? ' action' : '');
    var icon = document.createElement('span');
    icon.className = 'notify-icon';
    icon.textContent = NOTIFY_ICONS[n.kind] || '🔔';
    row.appendChild(icon);
    var body = document.createElement('div');
    body.className = 'notify-body';
    var text = document.createElement('div');
    text.className = 'notify-text';
    text.textContent = n.text;
    body.appendChild(text);
    var meta = document.createElement('div');
    meta.className = 'notify-meta';
    var when = new Date(n.timestamp);
    meta.textContent = (n.conversationName ? n.conversationName + ' · ' : '') +
      when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    body.appendChild(meta);
    row.appendChild(body);
    row.addEventListener('click', function() {
      fetch('/api/notifications/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upToId: n.id }) })
        .then(function(r) { return r.json(); })
        .then(function(d) { notifyUnread = d.unread || 0; renderNotifyBadge(); })
        .catch(function() {});
      n.read = true;
      row.classList.remove('unread');
      if (n.conversationId && (!activeConversation || activeConversation.id !== n.conversationId)) {
        selectConversation(n.conversationId);
      }
      closeNotifyPanel();
    });
    list.appendChild(row);
  });
}

loadNotifications();

// ============================================================
// Mobile viewport: keep the composer visible above the keyboard.
// 100vh lies on mobile; visualViewport tells the truth.
// ============================================================

(function() {
  function syncViewportHeight() {
    try {
      var h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      document.documentElement.style.setProperty('--app-height', h + 'px');
    } catch (err) { /* leave the CSS fallback in charge */ }
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewportHeight);
    window.visualViewport.addEventListener('scroll', syncViewportHeight);
  }
  window.addEventListener('resize', syncViewportHeight);
  syncViewportHeight();
})();

// ============================================================
// Decisions: first-class asks. The pane lists every open ask
// addressed to the viewer across all conversations; the chip on
// a message resolves it in place. Born from a field report:
// "decisions for a human are unfindable inside agent chatter."
// ============================================================

var decisionsPanelOpen = false;
var decisionsCache = [];
// Fetch-race guards: any authoritative change (an ask event over WS, a
// completed local resolve) bumps decisionsSeq, and every GET also carries a
// fetch id so only the LATEST-STARTED request may land. Together: a stale
// snapshot can never overwrite newer state, whether it raced an event or
// merely another fetch.
var decisionsSeq = 0;
var decisionsFetchId = 0;

function resolveAsk(messageId, conversationId) {
  fetch('/api/message/' + messageId + '/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: webToken(), conversation: conversationId || (activeConversation && activeConversation.id) })
  }).then(function(r) { return r.json(); }).then(function(d) {
    if (d && d.ask) applyAskResolution(messageId, d.ask, conversationId);
    // The resolution is the new truth: invalidate anything in flight, then
    // start a fresh (and by construction latest) refresh.
    decisionsSeq++;
    refreshDecisionsBadge();
  }).catch(function() {});
}

// Message ids are per conversation: only touch the rendered chip when the
// resolution belongs to the conversation currently on screen.
function applyAskResolution(messageId, ask, conversationId) {
  var conv = conversationId || (activeConversation && activeConversation.id) || '';
  // Update whichever caches hold this exact (conversation, id): the active
  // room's list, and an open mailbox thread that may span rooms.
  if (activeConversation && activeConversation.id === conv) {
    var m = allMessages.find(function(x) { return x.id === messageId; });
    if (m) m.ask = ask;
  }
  dmThread.forEach(function(x) {
    if (x.id === messageId && (x.conversationId || '') === conv) x.ask = ask;
  });
  // Conv-qualified: a mailbox pane can show A:7 and B:7 side by side.
  var chip = document.querySelector('.message[data-id="' + messageId + '"][data-conv="' + conv + '"] .ask-chip');
  if (chip) {
    chip.className = 'ask-chip resolved';
    chip.textContent = 'RESOLVED' + (ask && ask.resolvedBy ? ' by ' + ask.resolvedBy : '');
    chip.disabled = true;
  }
}

function refreshDecisionsBadge() {
  var seqAtStart = decisionsSeq;
  var fetchId = ++decisionsFetchId;
  fetch('/api/decisions?state=open&token=' + encodeURIComponent(webToken()))
    .then(function(r) { return r.json(); })
    .then(function(d) {
      // Only the latest-started fetch may land, and only if no ask event
      // superseded it while in flight.
      if (fetchId !== decisionsFetchId || decisionsSeq !== seqAtStart) return;
      decisionsCache = (d && d.decisions) || [];
      var badge = document.getElementById('decisions-badge');
      if (badge) {
        if (decisionsCache.length > 0) {
          badge.textContent = decisionsCache.length > 99 ? '99+' : String(decisionsCache.length);
          badge.hidden = false;
        } else {
          badge.hidden = true;
        }
      }
      if (decisionsPanelOpen) renderDecisionsPanel();
      refreshPalette();
      // The page reloads its three views with the badge.
      if (pageNow === 'decisions') loadDecisionsPage();
    }).catch(function() {});
}

function toggleDecisionsPanel() {
  if (decisionsPanelOpen) { closeDecisionsPanel(); return; }
  decisionsPanelOpen = true;
  var overlay = document.createElement('div');
  overlay.className = 'notify-panel-overlay';
  overlay.id = 'decisions-panel-overlay';
  overlay.addEventListener('click', function(e) { if (e.target === overlay) closeDecisionsPanel(); });
  var box = document.createElement('div');
  box.className = 'notify-panel';
  var hdr = document.createElement('div');
  hdr.className = 'notify-panel-header';
  var title = document.createElement('span');
  title.textContent = 'Decisions waiting on you';
  hdr.appendChild(title);
  box.appendChild(hdr);
  var list = document.createElement('div');
  list.className = 'notify-panel-list';
  list.id = 'decisions-panel-list';
  box.appendChild(list);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  renderDecisionsPanel();
  refreshDecisionsBadge();
  syncRailPanels();
}

function closeDecisionsPanel() {
  decisionsPanelOpen = false;
  var overlay = document.getElementById('decisions-panel-overlay');
  if (overlay) overlay.remove();
  syncRailPanels();
}

function renderDecisionsPanel() {
  var list = document.getElementById('decisions-panel-list');
  if (!list) return;
  list.textContent = '';
  if (decisionsCache.length === 0) {
    var empty = document.createElement('div');
    empty.className = 'notify-empty';
    empty.textContent = 'Nothing waiting on you. Enjoy it while it lasts.';
    list.appendChild(empty);
    return;
  }
  decisionsCache.forEach(function(d) {
    var row = document.createElement('div');
    row.className = 'notify-row action';
    var icon = document.createElement('span');
    icon.className = 'notify-icon';
    icon.textContent = '⚖️';
    row.appendChild(icon);
    var body = document.createElement('div');
    body.className = 'notify-body';
    var text = document.createElement('div');
    text.className = 'notify-text';
    text.textContent = d.sender + ': ' + (d.text.length > 140 ? d.text.slice(0, 137) + '...' : d.text);
    body.appendChild(text);
    var meta = document.createElement('div');
    meta.className = 'notify-meta';
    meta.textContent = (d.conversationName || d.conversationId) + ' · #' + d.messageId;
    body.appendChild(meta);
    row.appendChild(body);
    var resolveBtn = document.createElement('button');
    resolveBtn.className = 'btn notify-mark-btn';
    resolveBtn.textContent = 'Resolve';
    resolveBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      resolveAsk(d.messageId, d.conversationId);
      decisionsCache = decisionsCache.filter(function(x) {
        return !(x.messageId === d.messageId && x.conversationId === d.conversationId);
      });
      renderDecisionsPanel();
    });
    row.appendChild(resolveBtn);
    row.addEventListener('click', function() {
      // Hand the intent to the render: re-selecting is idempotent and always
      // produces exactly one render for this conversation, which consumes the
      // jump. No pending-load guessing, no timers racing completions.
      pendingDmJump = {
        conv: d.conversationId,
        to: (d.to && d.to.length > 0) ? (d.sender === myName() ? d.to[0] : d.sender) : null,
        msgId: d.messageId,
        deadline: Date.now() + 8000,
      };
      selectConversation(d.conversationId);
      closeDecisionsPanel();
    });
    list.appendChild(row);
  });
}

// Retry until the message element exists (conversation loads are async),
// then scroll; gives up quietly after `tries` beats of 200ms.
// `navSeq`, when given, binds the retries to one jump: they stop once a
// navigation or another jump moves jumpSeq on.
function scrollToMessageWhenReady(id, tries, conv, navSeq) {
  if (navSeq !== undefined && navSeq !== jumpSeq) return;
  var el = conv ? messageElementFor(conv, id) : document.querySelector('.message[data-id="' + id + '"]');
  if (el) { leavePageFor('rooms'); highlightMessageEl(el); return; }
  if (tries > 0) setTimeout(function() { scrollToMessageWhenReady(id, tries - 1, conv, navSeq); }, 200);
}

refreshDecisionsBadge();
// dm partners load on ws.onopen, after viewer registration settles
