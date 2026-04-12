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
var onlineNames = new Set();
var mentionMenuIndex = -1;
var openPopover = null;
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
    btn.innerHTML = isMuted ? '<i data-lucide="volume-x" width="18" height="18"></i>' : '<i data-lucide="volume-2" width="18" height="18"></i>';
    btn.style.opacity = isMuted ? '0.5' : '1';
    btn.title = isMuted ? 'Unmute' : 'Mute';
    if (window.lucide) lucide.createIcons({ root: btn });
  }
}

function saveSoundSettings() {
  localStorage.setItem('joind-sounds', JSON.stringify(soundSettings));
}

// --- WebSocket ---
function connect() {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws');
  var dot = document.getElementById('connection-dot');

  ws.onopen = function() { dot.classList.remove('disconnected'); };
  ws.onmessage = function(e) {
    var event = JSON.parse(e.data);
    switch (event.type) {
      case 'init':
        agents = event.data.agents;
        onlineNames = new Set(agents.map(function(a) { return a.name; }));
        allMessages = (event.data.messages || []).slice();
        activeConversation = event.data.activeConversation || null;
        conversationList = event.data.conversations || [];
        initTaskCount = event.data.openTaskCount || 0;
        initHasUrgent = event.data.hasUrgentTask || false;
        if (event.data.turnGuard) initTurnGuard(event.data.turnGuard);
        if (event.data.roles) { availableRoles = event.data.roles; }
        if (event.data.reactions) allReactions = event.data.reactions;
        if (activeConversation) {
          renderPills();
          renderMessages(event.data.messages || []);
          renderTaskBadgeFromCount(initTaskCount, initHasUrgent);
        } else {
          showNoConversation();
          renderTaskBadgeFromCount(0, false);
        }
        renderConversationList();
        break;
      case 'conversation-created':
      case 'conversation-renamed':
      case 'conversation-deleted':
        loadConversations();
        break;
      case 'message':
        // Filter: only render messages for the active conversation
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) {
          break;
        }
        hideWelcome();
        allMessages.push(event.data);
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
        if (lastScanResults.length > 0) renderTerminals(lastScanResults);
        break;
      case 'leave':
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) break;
        onlineNames.delete(event.data.name);
        staleNames.delete(event.data.name);
        typingNames.delete(event.data.name);
        agents = agents.filter(function(a) { return a.name !== event.data.name; });
        renderPills();
        renderTypingBar();
        if (lastScanResults.length > 0) renderTerminals(lastScanResults);
        break;
      case 'rename':
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) break;
        var d = event.data;
        onlineNames.delete(d.oldName); onlineNames.add(d.newName);
        agents = agents.filter(function(a) { return a.name !== d.oldName; });
        agents.push(d.agent); renderPills();
        // Update cached terminal data with new name
        lastScanResults.forEach(function(t) {
          if (t.tabTitle === d.oldName) t.tabTitle = d.newName;
          if (t.pid === d.agent.pid) t.tabTitle = d.newName;
          if (t.weztermPaneId != null && t.weztermPaneId === d.agent.weztermPaneId) t.tabTitle = d.newName;
        });
        if (lastScanResults.length > 0) renderTerminals(lastScanResults);
        break;
      case 'role':
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) break;
        agents = agents.map(function(a) { return a.name === event.data.name ? event.data : a; });
        renderPills();
        break;
      case 'typing':
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) break;
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
      case 'message-deleted':
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) break;
        var delId = event.data.id;
        allMessages = allMessages.filter(function(m) { return m.id !== delId; });
        var delEl = document.querySelector('.message[data-id="' + delId + '"]');
        if (delEl) {
          delEl.style.transition = 'opacity 0.2s, max-height 0.3s';
          delEl.style.opacity = '0';
          delEl.style.maxHeight = delEl.offsetHeight + 'px';
          setTimeout(function() { delEl.style.maxHeight = '0'; delEl.style.padding = '0'; delEl.style.margin = '0'; }, 200);
          setTimeout(function() { delEl.remove(); }, 500);
        }
        break;
      case 'task-created':
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) break;
        tasks.push(event.data);
        renderTaskBadge();
        if (taskPanelOpen) renderTaskPanel();
        if (event.data.priority === 'urgent') playSound('alert-tone');
        break;
      case 'task-updated':
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) break;
        tasks = tasks.map(function(t) { return t.id === event.data.id ? event.data : t; });
        renderTaskBadge();
        if (taskPanelOpen) renderTaskPanel();
        break;
      case 'turn-guard':
        initTurnGuard(event.data);
        break;
      case 'roles-updated':
        availableRoles = event.data;
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
        var rRow = document.querySelector('.msg-reactions[data-message-id="' + event.data.messageId + '"]');
        if (rRow) {
          var msgR = allReactions.filter(function(r) { return r.messageId === event.data.messageId; });
          renderReactionRow(rRow, event.data.messageId, msgR);
        }
        break;
      case 'message-edited':
        if (!activeConversation || (event.conversationId && event.conversationId !== activeConversation.id)) break;
        handleMessageEdited(event.data);
        break;
    }
  };
  ws.onclose = function() { dot.classList.add('disconnected'); setTimeout(connect, 2000); };
}

// --- Agent pills with popover ---
function renderPills() {
  var c = document.getElementById('agent-pills');
  c.textContent = '';
  agents.forEach(function(a) {
    var pill = document.createElement('div');
    var pillClass = 'agent-pill';
    if (staleNames.has(a.name)) pillClass += ' stale';
    if (typingNames.has(a.name)) pillClass += ' working';
    pill.className = pillClass;
    var color = getSenderColor(a.name);
    pill.style.setProperty('--pill-color', color);
    pill.style.borderColor = color + '30';

    var dot = document.createElement('span');
    dot.className = 'pill-dot';
    // Green = online (default CSS), agent color only when stale

    var name = document.createElement('span');
    name.className = 'pill-name'; name.style.color = color;
    name.textContent = a.name;

    pill.appendChild(dot); pill.appendChild(name);
    if (a.role) {
      var role = document.createElement('span');
      role.className = 'pill-role';
      role.textContent = a.role;
      pill.appendChild(role);
    }
    if (a.status) {
      var statusEl = document.createElement('span');
      statusEl.className = 'pill-status';
      statusEl.textContent = a.status;
      pill.appendChild(statusEl);
    }

    pill.addEventListener('click', function(e) {
      e.stopPropagation();
      showPopover(pill, a);
    });
    c.appendChild(pill);
  });
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
  pid.textContent = 'PID ' + agent.pid;
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
          body: JSON.stringify({ oldName: agent.name, newName: newName }) });
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
  roleDisplay.style.fontSize = '11px';
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

  // Position — clamp to viewport
  document.body.appendChild(pop);
  var rect = anchor.getBoundingClientRect();
  var popRect = pop.getBoundingClientRect();
  var top = rect.bottom + 6;
  var left = rect.left;

  // Clamp right edge
  if (left + popRect.width > window.innerWidth - 8) {
    left = window.innerWidth - popRect.width - 8;
  }
  // Clamp bottom edge — flip above if needed
  if (top + popRect.height > window.innerHeight - 8) {
    top = rect.top - popRect.height - 6;
  }
  pop.style.top = Math.max(8, top) + 'px';
  pop.style.left = Math.max(8, left) + 'px';

  openPopover = pop;
}

function closePopover() {
  if (openPopover) { openPopover.remove(); openPopover = null; }
}
document.addEventListener('click', closePopover);

// --- Messages ---
function hideWelcome() { var w = document.getElementById('welcome'); if (w) w.remove(); }

function renderMessages(msgs) {
  hideWelcome();
  var c = document.getElementById('messages');
  c.textContent = '';
  lastSender = null;
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

    // Reply quote (before header)
    if (msg.replyTo) {
      var orig = allMessages.find(function(m) { return m.id === msg.replyTo; });
      if (orig) {
        var quote = document.createElement('div');
        quote.className = 'reply-quote';
        quote.textContent = orig.sender + ': ' + (orig.text || '').slice(0, 80);
        quote.style.borderLeftColor = getSenderColor(orig.sender);
        quote.addEventListener('click', function() { scrollToMessage(orig.id); });
        body.appendChild(quote);
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
    tm.className = 'msg-time'; tm.textContent = formatTime(msg.timestamp);
    hdr.appendChild(sn); hdr.appendChild(mid); hdr.appendChild(tm);

    // Show role badge if agent has one
    var agent = agents.find(function(a) { return a.name === msg.sender; });
    if (agent && agent.role) {
      var badge = document.createElement('span');
      badge.className = 'msg-role-badge'; badge.textContent = agent.role;
      badge.style.borderColor = color + '40'; badge.style.color = color;
      hdr.appendChild(badge);
    }

    var tw = document.createElement('div');
    tw.className = 'msg-text-wrap';
    renderContent(tw, msg.text);

    // Image display
    if (msg.image) {
      var img = document.createElement('img');
      img.className = 'msg-image';
      img.src = msg.image;
      img.addEventListener('click', function() { openLightbox(msg.image); });
      tw.appendChild(img);
    }

    // Edited badge
    if (msg.edited) {
      var editedBadge = document.createElement('span');
      editedBadge.className = 'msg-edited-badge';
      editedBadge.textContent = '(edited)';
      editedBadge.title = 'Message has been edited';
      tw.appendChild(editedBadge);
    }

    body.appendChild(hdr); body.appendChild(tw);

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
        body: JSON.stringify({ id: msg.id })
      });
    });
    actions.appendChild(delBtn);

    el.dataset.id = msg.id;
    el.appendChild(av); el.appendChild(body); el.appendChild(actions);

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

function renderContent(parent, text) {
  if (!text) { parent.textContent = ''; return; }
  if (typeof marked !== 'undefined') {
    // Ensure real newlines (WebSocket/JSON may deliver literal \n)
    text = text.replace(/\\n/g, '\n');
    var html = marked.parse(text);
    html = html.replace(/@(\w[\w-]*)/g, function(match, name) {
      var c = getSenderColor(name);
      var safe = name.replace(/[<>"'&]/g, function(ch) {
        return {'<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;",'&':'&amp;'}[ch] || ch;
      });
      return '<span class="mention" style="color:' + c + ';background:' + c + '20">@' + safe + '</span>';
    });
    parent.innerHTML = html;
  } else {
    renderTextWithMentions(parent, text);
  }
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
  scrollToBottom();
  autoScroll = true;
  unreadCount = 0;
  updateNewMsgsPill();
}

// --- Image upload ---
var pendingImage = null; // { url } — image attached to current draft

function uploadImage(file) {
  fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': file.type }, body: file })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      pendingImage = { url: data.url };
      showImagePreview(data.url);
    });
}

function showImagePreview(url) {
  var bar = document.getElementById('image-preview');
  var thumb = document.getElementById('image-preview-thumb');
  thumb.src = url;
  bar.classList.remove('hidden');
  document.getElementById('message-input').focus();
}

function clearImagePreview() {
  pendingImage = null;
  document.getElementById('image-preview').classList.add('hidden');
  document.getElementById('image-preview-thumb').src = '';
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

// --- Send ---
function sendMessage() {
  var input = document.getElementById('message-input');
  var sender = document.getElementById('sender-name');
  var text = input.value.trim();
  if (!text && !pendingImage) return;
  var payload = { sender: sender.value || 'human', text: text || '[image]' };
  if (replyingTo) payload.replyTo = replyingTo.id;
  if (pendingImage) payload.image = pendingImage.url;
  input.value = ''; input.style.height = 'auto'; input.focus(); updateSendBtn();
  syncHighlight();
  clearReply();
  clearImagePreview();
  fetch('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload) });
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
  window.open('/api/export', '_blank');
}

// --- Global sound setting (popover, not prompt) ---
function openSoundSettings(evt) {
  openSettings(evt, 'sounds');
}

function openSettings(evt, defaultTab) {
  if (evt) evt.stopPropagation();
  closePopover();
  var anchor = evt ? (evt.currentTarget || evt.target) : null;
  var pop = document.createElement('div');
  pop.className = 'pill-popover settings-popover';
  pop.style.width = '320px';
  pop.style.height = '440px';
  pop.style.display = 'flex';
  pop.style.flexDirection = 'column';
  pop.addEventListener('click', function(e) { e.stopPropagation(); });

  // Tab bar
  var tabBar = document.createElement('div');
  tabBar.className = 'settings-tab-bar';
  var soundsTab = document.createElement('button');
  soundsTab.className = 'settings-tab' + (defaultTab !== 'roles' ? ' active' : '');
  soundsTab.textContent = 'Sounds';
  var rolesTab = document.createElement('button');
  rolesTab.className = 'settings-tab' + (defaultTab === 'roles' ? ' active' : '');
  rolesTab.textContent = 'Roles';
  tabBar.appendChild(soundsTab);
  tabBar.appendChild(rolesTab);
  pop.appendChild(tabBar);

  // Panels
  var soundsPanel = document.createElement('div');
  soundsPanel.className = 'settings-panel';
  if (defaultTab === 'roles') soundsPanel.style.display = 'none';
  var rolesPanel = document.createElement('div');
  rolesPanel.className = 'settings-panel';
  if (defaultTab !== 'roles') rolesPanel.style.display = 'none';

  soundsTab.addEventListener('click', function() {
    soundsTab.classList.add('active'); rolesTab.classList.remove('active');
    soundsPanel.style.display = ''; rolesPanel.style.display = 'none';
  });
  rolesTab.addEventListener('click', function() {
    rolesTab.classList.add('active'); soundsTab.classList.remove('active');
    rolesPanel.style.display = ''; soundsPanel.style.display = 'none';
  });

  // === Sounds panel content ===

  // Global sound
  var globalRow = document.createElement('div');
  globalRow.className = 'pop-row';
  var globalLabel = document.createElement('label');
  globalLabel.textContent = 'Global';
  var globalSelect = document.createElement('select');
  globalSelect.className = 'pop-select';
  SOUNDS.forEach(function(s) {
    var opt = document.createElement('option');
    opt.value = s; opt.textContent = s;
    if (soundSettings._global === s) opt.selected = true;
    globalSelect.appendChild(opt);
  });
  globalSelect.addEventListener('change', function() {
    soundSettings._global = globalSelect.value;
    saveSoundSettings();
    var wasMuted = isMuted; isMuted = false;
    playSound('_preview');
    isMuted = wasMuted;
  });
  globalRow.appendChild(globalLabel);
  globalRow.appendChild(globalSelect);
  soundsPanel.appendChild(globalRow);

  // Mute toggle
  var muteRow = document.createElement('div');
  muteRow.className = 'pop-row';
  var muteLabel = document.createElement('label');
  muteLabel.textContent = 'Mute';
  var muteCheck = document.createElement('input');
  muteCheck.type = 'checkbox';
  muteCheck.checked = isMuted;
  muteCheck.style.accentColor = 'var(--accent)';
  muteCheck.addEventListener('change', function() {
    isMuted = muteCheck.checked;
    localStorage.setItem('joind-muted', JSON.stringify(isMuted));
    updateMuteBtn();
  });
  muteRow.appendChild(muteLabel);
  muteRow.appendChild(muteCheck);
  soundsPanel.appendChild(muteRow);

  // Preview button
  var previewBtn = document.createElement('button');
  previewBtn.className = 'btn btn-sm';
  previewBtn.textContent = 'Preview';
  previewBtn.style.margin = '6px 12px 8px';
  previewBtn.style.width = 'calc(100% - 24px)';
  previewBtn.addEventListener('click', function() {
    var wasMuted = isMuted;
    isMuted = false;
    playSound('_preview');
    isMuted = wasMuted;
  });
  soundsPanel.appendChild(previewBtn);

  // Per-agent section
  if (agents.length > 0) {
    var agentDivider = document.createElement('div');
    agentDivider.style.borderTop = '1px solid var(--border)';
    agentDivider.style.margin = '0';
    soundsPanel.appendChild(agentDivider);

    var agentHdr = document.createElement('div');
    agentHdr.className = 'pop-row';
    agentHdr.style.paddingTop = '8px';
    agentHdr.style.paddingBottom = '2px';
    var agentHdrLabel = document.createElement('span');
    agentHdrLabel.style.fontSize = '9px';
    agentHdrLabel.style.textTransform = 'uppercase';
    agentHdrLabel.style.letterSpacing = '1px';
    agentHdrLabel.style.color = 'var(--text-muted)';
    agentHdrLabel.style.fontWeight = '600';
    agentHdrLabel.textContent = 'Per Agent';
    agentHdr.appendChild(agentHdrLabel);
    soundsPanel.appendChild(agentHdr);

    agents.forEach(function(a) {
      var row = document.createElement('div');
      row.className = 'pop-row';
      var lbl = document.createElement('label');
      lbl.textContent = a.name;
      lbl.title = a.name;
      lbl.style.width = '60px';
      lbl.style.overflow = 'hidden';
      lbl.style.textOverflow = 'ellipsis';
      lbl.style.whiteSpace = 'nowrap';
      lbl.style.color = getSenderColor(a.name);
      var sel = document.createElement('select');
      sel.className = 'pop-select';
      // "default" option uses global setting
      var defOpt = document.createElement('option');
      defOpt.value = '';
      defOpt.textContent = '(global)';
      if (!soundSettings[a.name]) defOpt.selected = true;
      sel.appendChild(defOpt);
      SOUNDS.forEach(function(s) {
        var opt = document.createElement('option');
        opt.value = s; opt.textContent = s;
        if (soundSettings[a.name] === s) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', function() {
        if (sel.value === '') {
          delete soundSettings[a.name];
        } else {
          soundSettings[a.name] = sel.value;
        }
        saveSoundSettings();
      });
      row.appendChild(lbl);
      row.appendChild(sel);
      soundsPanel.appendChild(row);
    });
  }

  pop.appendChild(soundsPanel);

  // === Roles panel content ===
  // Presets section
  var presetsLabel = document.createElement('div');
  presetsLabel.className = 'role-subsection-label';
  presetsLabel.textContent = 'Presets';
  rolesPanel.appendChild(presetsLabel);

  var presetList = document.createElement('div');
  presetList.className = 'role-list';
  (availableRoles.preset || []).forEach(function(r) {
    var item = document.createElement('div');
    item.className = 'role-item preset';
    item.textContent = r.emoji + ' ' + r.label;
    presetList.appendChild(item);
  });
  rolesPanel.appendChild(presetList);

  // Custom section
  var customLabel = document.createElement('div');
  customLabel.className = 'role-subsection-label';
  customLabel.style.marginTop = '10px';
  customLabel.textContent = 'Custom';
  rolesPanel.appendChild(customLabel);

  var customList = document.createElement('div');
  customList.className = 'role-list';
  (availableRoles.custom || []).forEach(function(r) {
    var item = document.createElement('div');
    item.className = 'role-item custom';
    var label = document.createElement('span');
    label.textContent = r.emoji + ' ' + r.label;
    var delBtn = document.createElement('button');
    delBtn.className = 'role-delete-btn';
    delBtn.textContent = '\u00D7';
    delBtn.title = 'Delete custom role';
    delBtn.addEventListener('click', function() {
      fetch('/api/roles/' + encodeURIComponent(r.label), { method: 'DELETE' }).then(function() {
        item.remove();
      });
    });
    item.appendChild(label);
    item.appendChild(delBtn);
    customList.appendChild(item);
  });
  rolesPanel.appendChild(customList);

  // Add new role form
  var addForm = document.createElement('div');
  addForm.className = 'role-add-form';
  addForm.style.marginTop = '8px';
  var emojiInput = document.createElement('input');
  emojiInput.type = 'text';
  emojiInput.className = 'role-emoji-input';
  emojiInput.placeholder = 'emoji';
  emojiInput.maxLength = 4;
  var labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'role-label-input';
  labelInput.placeholder = 'role name';
  var addBtn = document.createElement('button');
  addBtn.className = 'btn btn-sm';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', function() {
    var em = emojiInput.value.trim();
    var lb = labelInput.value.trim();
    if (!em || !lb) return;
    fetch('/api/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: em, label: lb })
    }).then(function(resp) {
      if (resp.ok) { emojiInput.value = ''; labelInput.value = ''; closePopover(); openSettings(null, 'roles'); }
    });
  });
  addForm.appendChild(emojiInput);
  addForm.appendChild(labelInput);
  addForm.appendChild(addBtn);
  rolesPanel.appendChild(addForm);

  pop.appendChild(rolesPanel);

  // Always center the settings dialog
  document.body.appendChild(pop);
  var popRect = pop.getBoundingClientRect();
  pop.style.top = Math.max(8, (window.innerHeight - popRect.height) / 2) + 'px';
  pop.style.left = Math.max(8, (window.innerWidth - popRect.width) / 2) + 'px';

  openPopover = pop;
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

  // Paste handler for images
  input.addEventListener('paste', function(e) {
    var items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        e.preventDefault();
        uploadImage(items[i].getAsFile());
        return;
      }
    }
  });

  // Drop handler for images on chat area
  var chatArea = document.getElementById('messages');
  chatArea.addEventListener('dragover', function(e) { e.preventDefault(); chatArea.classList.add('drag-over'); });
  chatArea.addEventListener('dragleave', function() { chatArea.classList.remove('drag-over'); });
  chatArea.addEventListener('drop', function(e) { e.preventDefault(); chatArea.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) uploadImage(e.dataTransfer.files[0]);
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

function syncHighlight() {
  var input = document.getElementById('message-input');
  var highlight = document.getElementById('input-highlight');
  if (!highlight) return;

  var text = input.value;
  // Escape HTML, then color exact or uniquely identifiable @mentions inline.
  var escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  var html = escaped.replace(/@(\w[\w-]*)/g, function(match, name) {
    var color = resolveMentionColor(name);
    if (!color) return match;
    return '<span class="hl-mention" style="color:' + color + '">' + match + '</span>';
  });
  // Add trailing space so highlight div matches textarea height
  highlight.innerHTML = html + '\n';
  // Sync scroll
  highlight.scrollTop = input.scrollTop;
}

function syncHighlightScroll() {
  var input = document.getElementById('message-input');
  var highlight = document.getElementById('input-highlight');
  if (highlight) highlight.scrollTop = input.scrollTop;
}

function updateSendBtn() {
  document.getElementById('send-btn').classList.toggle('inactive', !document.getElementById('message-input').value.trim());
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
  if (autoScanRunning) return;
  autoScanRunning = true;
  fetch('/api/terminals').then(function(r) { return r.json(); }).then(function(t) {
    autoScanRunning = false;
    // Only re-render if something changed (compare by pid+paneId+tabTitle fingerprint)
    var oldFp = lastScanResults.map(function(x) { return x.pid + ':' + (x.weztermPaneId || '') + ':' + (x.tabTitle || ''); }).sort().join('|');
    var newFp = t.map(function(x) { return x.pid + ':' + (x.weztermPaneId || '') + ':' + (x.tabTitle || ''); }).sort().join('|');
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
}

function inviteTerminal(t) {
  var defaultName = t.tabTitle || t.type;
  customPrompt('Name for this ' + t.type + ' agent:', defaultName, function(name) {
    if (!name) return;
    var payload = { name: name, pid: t.pid };
    if (t.wtSession) payload.wtSession = t.wtSession;
    if (t.weztermPaneId != null) payload.weztermPaneId = t.weztermPaneId;
    fetch('/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  });
}

function kickAgent(name) {
  fetch('/api/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) });
}

// --- Sidebar toggle ---
function toggleSidebar() {
  var sb = document.getElementById('sidebar');
  sb.classList.toggle('hidden');
  localStorage.setItem('joind-sidebar', sb.classList.contains('hidden') ? 'hidden' : 'visible');
}

function toggleSection(header) {
  header.classList.toggle('collapsed');
  var body = header.nextElementSibling;
  if (body) body.classList.toggle('collapsed');
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
  title.style.fontSize = '14px';
  title.textContent = message;
  modal.appendChild(title);

  var input = document.createElement('input');
  input.type = 'text';
  input.className = 'pop-input';
  input.style.width = '100%';
  input.style.marginTop = '12px';
  input.style.marginBottom = '16px';
  input.style.fontSize = '13px';
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
  okBtn.style.fontSize = '12px';
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

// --- "You" pill ---
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
    display.style.color = getSenderColor(name);
    localStorage.setItem('joind-sender-name', name);
  }
  senderInput.addEventListener('input', syncName);
  senderInput.addEventListener('change', syncName);

  // Click pill → popover with name, color, sound
  pill.addEventListener('click', function(e) {
    e.stopPropagation();
    closePopover();

    var pop = document.createElement('div');
    pop.className = 'pill-popover';
    pop.addEventListener('click', function(ev) { ev.stopPropagation(); });

    var currentName = senderInput.value || 'human';
    var color = getSenderColor(currentName);

    // Header
    var hdr = document.createElement('div');
    hdr.className = 'pop-header';
    var hdrTitle = document.createElement('span');
    hdrTitle.textContent = 'Your Profile';
    hdrTitle.style.color = color;
    hdrTitle.style.fontWeight = '700';
    hdr.appendChild(hdrTitle);
    pop.appendChild(hdr);

    // Name
    var nameRow = document.createElement('div');
    nameRow.className = 'pop-row';
    var nameLabel = document.createElement('label');
    nameLabel.textContent = 'Name';
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = currentName;
    nameInput.className = 'pop-input';
    nameInput.addEventListener('keydown', function(ev) {
      if (ev.key === 'Enter') {
        senderInput.value = nameInput.value.trim() || 'human';
        syncName();
        closePopover();
      }
    });
    nameRow.appendChild(nameLabel);
    nameRow.appendChild(nameInput);
    pop.appendChild(nameRow);

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
    COLORS.forEach(function(c) {
      var dot = document.createElement('span');
      dot.className = 'pop-color-dot' + (color === c ? ' active' : '');
      dot.style.background = c;
      dot.addEventListener('click', function() {
        var name = (nameInput.value.trim() || 'human').toLowerCase();
        SENDER_COLORS[name] = c;
        localStorage.setItem('joind-colors', JSON.stringify(SENDER_COLORS));
        recolorMessages(name, c);
        syncName();
        closePopover();
      });
      colorDots.appendChild(dot);
    });
    colorRow.appendChild(colorDots);
    pop.appendChild(colorRow);

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
      if (soundSettings._global === s) opt.selected = true;
      soundSelect.appendChild(opt);
    });
    soundSelect.addEventListener('change', function() {
      soundSettings._global = soundSelect.value;
      saveSoundSettings();
      var wasMuted = isMuted; isMuted = false;
      playSound('_preview');
      isMuted = wasMuted;
    });
    soundRow.appendChild(soundLabel);
    soundRow.appendChild(soundSelect);
    pop.appendChild(soundRow);

    // Position — clamp to viewport
    document.body.appendChild(pop);
    var rect = pill.getBoundingClientRect();
    var popRect = pop.getBoundingClientRect();
    var ptop = rect.bottom + 6;
    var pleft = rect.left;
    if (pleft + popRect.width > window.innerWidth - 8) {
      pleft = window.innerWidth - popRect.width - 8;
    }
    if (ptop + popRect.height > window.innerHeight - 8) {
      ptop = rect.top - popRect.height - 6;
    }
    pop.style.top = Math.max(8, ptop) + 'px';
    pop.style.left = Math.max(8, pleft) + 'px';

    openPopover = pop;
    nameInput.focus();
    nameInput.select();
  });

  syncName();
}

// --- Conversations ---
var activeConversation = null;
var conversationList = [];
var convSearchQuery = '';

function loadConversations() {
  fetch('/api/conversations').then(function(r) { return r.json(); }).then(function(data) {
    activeConversation = data.active;
    conversationList = data.conversations || [];
    renderConversationList();
  });
}

function selectConversation(id) {
  // Optimistic: immediately highlight the selected conversation + clear chat
  var meta = conversationList.find(function(c) { return c.id === id; });
  if (meta) {
    activeConversation = meta;
    renderConversationList();
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

  fetch('/api/conversations/select', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id }) }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.conversation) {
        activeConversation = data.conversation;
        allMessages = (data.messages || []).slice();
        agents = data.agents || [];
        onlineNames = new Set(agents.map(function(a) { return a.name; }));
        lastSender = null;
        renderPills();
        c.textContent = '';
        if (allMessages.length > 0) {
          allMessages.forEach(function(m) { appendMessage(m, false); });
          scrollToBottom();
        }
        renderConversationList();
        // Refresh tasks for the new conversation
        tasks = [];
        loadTaskCount(activeConversation.id);
        if (taskPanelOpen) loadTasks(activeConversation.id);
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
  renderPills();
}

function renderConversationList() {
  var list = document.getElementById('conversation-list');
  var activeEl = document.getElementById('active-session');
  list.textContent = '';

  // Active conversation indicator
  if (activeConversation) {
    activeEl.textContent = activeConversation.name;
    activeEl.className = 'active-session';
    activeEl.title = 'Click to rename';
    activeEl.onclick = function() {
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

    // Click to select
    li.addEventListener('click', function() {
      selectConversation(conv.id);
    });

    list.appendChild(li);
  });
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
  sessionTemplates.forEach(function(t) {
    var card = document.createElement('div');
    card.className = 'template-card';

    var name = document.createElement('div');
    name.className = 'template-name';
    name.textContent = t.name;

    var desc = document.createElement('div');
    desc.className = 'template-desc';
    desc.textContent = t.description;

    var roles = document.createElement('div');
    roles.className = 'template-roles';
    roles.textContent = t.roles.join(', ');

    var startBtn = document.createElement('button');
    startBtn.className = 'btn btn-sm';
    startBtn.textContent = 'Start';
    startBtn.style.marginTop = '4px';
    startBtn.addEventListener('click', function() { startSessionUI(t); });

    card.appendChild(name);
    card.appendChild(desc);
    card.appendChild(roles);
    card.appendChild(startBtn);
    list.appendChild(card);
  });
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
  startBtn.style.fontSize = '11px';
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
  fetch('/api/sessions').then(function(r) { return r.json(); }).then(function(sessions) {
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

// Poll session status while active
setInterval(refreshSessionStatus, 3000);

// --- Task System ---
var tasks = [];
var taskFilter = 'open';
var taskPanelOpen = false;
var initTaskCount = 0;
var initHasUrgent = false;

function renderTaskBadge() {
  var openCount = tasks.filter(function(t) { return t.status === 'open'; }).length;
  var hasUrgent = tasks.some(function(t) { return t.status === 'open' && t.priority === 'urgent'; });
  renderTaskBadgeFromCount(openCount, hasUrgent);
}

function renderTaskBadgeFromCount(count, hasUrgent) {
  var badge = document.getElementById('task-badge');
  var countEl = document.getElementById('task-badge-count');
  if (!badge || !countEl) return;
  countEl.textContent = count;
  badge.classList.toggle('has-tasks', count > 0);
  badge.classList.toggle('has-urgent', hasUrgent);
}

function loadTaskCount(convId) {
  fetch('/api/tasks/count?conversation=' + encodeURIComponent(convId))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      renderTaskBadgeFromCount(data.count || 0, data.hasUrgent || false);
    })
    .catch(function() { /* leave badge as-is on failure */ });
}

function loadTasks(convId) {
  var status = taskFilter === 'all' ? 'all' : taskFilter;
  fetch('/api/tasks?conversation=' + encodeURIComponent(convId) + '&status=' + status)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      tasks = data || [];
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
    if (a.status === 'open' && b.status === 'open') {
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
  card.className = 'task-card' + (task.priority === 'urgent' && task.status === 'open' ? ' urgent' : '') + (task.status === 'done' ? ' done' : '');

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

  if (task.priority === 'urgent' && task.status === 'open') {
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

  if (task.status === 'open') {
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
  submitBtn.style.cssText = 'padding:4px 12px;width:auto;height:auto;font-size:11px;';
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

// --- Init ---
document.addEventListener('DOMContentLoaded', function() {
  setupInput();
  setupYouPill();
  updateSendBtn();
  updateMuteBtn();
  connect();
  loadTemplates();
  // Wire conversation search
  var convSearch = document.getElementById('conv-search');
  if (convSearch) {
    convSearch.addEventListener('input', function() {
      convSearchQuery = this.value;
      renderConversationList();
    });
  }
  // Restore sidebar state
  if (localStorage.getItem('joind-sidebar') === 'hidden') {
    document.getElementById('sidebar').classList.add('hidden');
  }
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

function openLaunchDialog() {
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
    fetch('/api/conversations').then(function(r) { return r.json(); }).catch(function() { return { conversations: [] }; }),
    fetch('/api/launcher/terminals').then(function(r) { return r.json(); }).catch(function() { return { wezterm: { available: false, running: false }, wt: { available: false }, manual: { available: true } }; })
  ]).then(function(results) {
    var crewList = results[0];
    var harnesses = results[1];
    var convData = results[2];
    var terminalsInfo = results[3];
    var convList = convData.conversations || convData || [];
    content.textContent = '';
    footer.textContent = '';
    buildLaunchForm(content, footer, crewList, harnesses, convList, terminalsInfo);
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

function buildLaunchForm(content, footer, crewList, harnesses, convList, terminalsInfo) {
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
      // Select the newly added crew
      if (newCrew) {
        crewSelect.value = newCrew.name;
        updateCrewMeta(newCrew);
        selectedCrew = newCrew;
        autoFillFromCrew(newCrew);
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
}

function renderFlagsForm(harness, container) {
  container.textContent = '';
  var flags = harness.flags || [];
  if (flags.length === 0) {
    var empty = document.createElement('div');
    empty.style.fontSize = '11px';
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
        helpSpan.style.fontSize = '10px';
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
  cancelBtn.style.fontSize = '11px';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', onCancel);

  var addBtn = document.createElement('button');
  addBtn.className = 'btn-launch-go';
  addBtn.style.padding = '4px 12px';
  addBtn.style.fontSize = '11px';
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
    manualLabel.style.fontSize = '11px';
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
  pollIndicator.style.fontSize = '11px';
  pollIndicator.textContent = 'Waiting for agent...';
  view.appendChild(pollIndicator);

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
        }
        // else still pending — keep polling
      }).catch(function() { /* keep polling */ });
  }, 1000);
}

// END LAUNCH DIALOG
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
  fetch('/api/message/' + messageId)
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
    renderContent(tw, data.newText);
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
function toggleSearch() {
  var bar = document.getElementById('search-bar');
  bar.classList.toggle('hidden');
  if (!bar.classList.contains('hidden')) {
    var inp = document.getElementById('search-input');
    inp.focus();
    inp.addEventListener('input', function() {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(doSearch, 300);
    });
  }
}
function closeSearch() {
  document.getElementById('search-bar').classList.add('hidden');
  document.getElementById('search-results').textContent = '';
  document.getElementById('search-input').value = '';
}
function doSearch() {
  var q = document.getElementById('search-input').value.trim();
  var results = document.getElementById('search-results');
  if (!q) { results.textContent = ''; return; }
  fetch('/api/search?q=' + encodeURIComponent(q) + '&limit=20')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      results.textContent = '';
      if (!data || data.length === 0) {
        results.textContent = 'No results';
        return;
      }
      data.forEach(function(r) {
        var item = document.createElement('div');
        item.className = 'search-result-item';
        var sender = document.createElement('span');
        sender.className = 'search-result-sender';
        sender.style.color = getSenderColor(r.message.sender);
        sender.textContent = r.message.sender;
        var text = document.createElement('span');
        text.className = 'search-result-text';
        text.textContent = r.message.text.slice(0, 120);
        var id = document.createElement('span');
        id.className = 'search-result-id';
        id.textContent = '#' + r.message.id;
        item.appendChild(sender);
        item.appendChild(text);
        item.appendChild(id);
        item.addEventListener('click', function() {
          var el = document.querySelector('.message[data-id="' + r.message.id + '"]');
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add('highlight');
            setTimeout(function() { el.classList.remove('highlight'); }, 2000);
          }
          closeSearch();
        });
        results.appendChild(item);
      });
    });
}
