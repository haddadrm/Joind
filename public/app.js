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
};

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
var replyingTo = null; // message we're replying to
var typingNames = new Set(); // agents currently typing
var staleNames = new Set(); // agents marked as stale
var replyingTo = null; // current reply target (message object or null)

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
        if (activeConversation) {
          renderPills();
          renderMessages(event.data.messages || []);
        } else {
          showNoConversation();
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
        if (event.conversationId && activeConversation && event.conversationId !== activeConversation.id) {
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
        if (event.conversationId && activeConversation && event.conversationId !== activeConversation.id) break;
        onlineNames.add(event.data.name);
        staleNames.delete(event.data.name);
        agents = agents.filter(function(a) { return a.name !== event.data.name; });
        agents.push(event.data); renderPills();
        if (lastScanResults.length > 0) renderTerminals(lastScanResults);
        break;
      case 'leave':
        if (event.conversationId && activeConversation && event.conversationId !== activeConversation.id) break;
        onlineNames.delete(event.data.name);
        staleNames.delete(event.data.name);
        typingNames.delete(event.data.name);
        agents = agents.filter(function(a) { return a.name !== event.data.name; });
        renderPills();
        renderTypingBar();
        if (lastScanResults.length > 0) renderTerminals(lastScanResults);
        break;
      case 'rename':
        var d = event.data;
        onlineNames.delete(d.oldName); onlineNames.add(d.newName);
        agents = agents.filter(function(a) { return a.name !== d.oldName; });
        agents.push(d.agent); renderPills();
        break;
      case 'role':
        agents = agents.map(function(a) { return a.name === event.data.name ? event.data : a; });
        renderPills();
        break;
      case 'typing':
        if (event.data.typing) {
          typingNames.add(event.data.name);
        } else {
          typingNames.delete(event.data.name);
        }
        renderPills();
        break;
      case 'stale':
        staleNames.add(event.data.name);
        renderPills();
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

    if (a.role) {
      var role = document.createElement('span');
      role.className = 'pill-role';
      role.textContent = a.role;
      pill.appendChild(dot); pill.appendChild(name); pill.appendChild(role);
    } else {
      pill.appendChild(dot); pill.appendChild(name);
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

  // Role — preset buttons + custom input
  var PRESET_ROLES = [
    {emoji: '\uD83D\uDD0D', label: 'reviewer'},
    {emoji: '\uD83C\uDFD7\uFE0F', label: 'architect'},
    {emoji: '\u2B50', label: 'lead'},
    {emoji: '\uD83D\uDCCA', label: 'analyst'},
    {emoji: '\u26A0\uFE0F', label: 'critic'},
    {emoji: '\uD83D\uDCA1', label: 'creative'},
    {emoji: '\uD83D\uDEE0\uFE0F', label: 'builder'},
    {emoji: '\uD83C\uDFAF', label: 'moderator'},
    {emoji: '\uD83D\uDD2C', label: 'researcher'},
    {emoji: '\uD83C\uDFBC', label: 'orchestrator'},
    {emoji: '\uD83D\uDC1B', label: 'debugger'},
    {emoji: '\uD83E\uDDEA', label: 'tester'},
    {emoji: '\uD83D\uDCDD', label: 'planner'},
    {emoji: '\uD83D\uDCD6', label: 'scribe'},
    {emoji: '\uD83D\uDE08', label: 'devil-advocate'},
    {emoji: '\u274C', label: 'clear'},
  ];

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
  PRESET_ROLES.forEach(function(r) {
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
  removeBtn.textContent = 'Remove from chat';
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
  var c = document.getElementById('messages');
  var el = document.createElement('div');
  el.dataset.id = msg.id;

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
        quote.textContent = orig.sender + ': ' + orig.text.slice(0, 80);
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

    body.appendChild(hdr); body.appendChild(tw);

    var actions = document.createElement('div');
    actions.className = 'msg-actions';

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
  if (scroll) scrollToBottom();
  addCodeCopyButtons(el);
}

function renderContent(parent, text) {
  if (typeof marked !== 'undefined') {
    // Ensure real newlines (WebSocket/JSON may deliver literal \n)
    text = text.replace(/\\n/g, '\n');
    var html = marked.parse(text);
    html = html.replace(/@(\w[\w-]*)/g, function(match, name) {
      var c = getSenderColor(name);
      return '<span class="mention" style="color:' + c + ';background:' + c + '20">@' + name + '</span>';
    });
    parent.innerHTML = html;
  } else {
    renderTextWithMentions(parent, text);
  }
}

function renderTextWithMentions(parent, text) {
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
  if (evt) evt.stopPropagation();
  closePopover();
  var anchor = evt ? (evt.currentTarget || evt.target) : null;
  var pop = document.createElement('div');
  pop.className = 'pill-popover';
  pop.style.width = '260px';
  pop.style.maxHeight = '400px';
  pop.style.overflowY = 'auto';
  pop.addEventListener('click', function(e) { e.stopPropagation(); });

  var hdr = document.createElement('div');
  hdr.className = 'pop-header';
  hdr.textContent = 'Sound Settings';
  pop.appendChild(hdr);

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
  pop.appendChild(globalRow);

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
  pop.appendChild(muteRow);

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
  pop.appendChild(previewBtn);

  // Per-agent section
  if (agents.length > 0) {
    var agentDivider = document.createElement('div');
    agentDivider.style.borderTop = '1px solid var(--border)';
    agentDivider.style.margin = '0';
    pop.appendChild(agentDivider);

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
    pop.appendChild(agentHdr);

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
      pop.appendChild(row);
    });
  }

  // Append to body, then position relative to the Config button
  document.body.appendChild(pop);
  var popRect = pop.getBoundingClientRect();

  if (anchor) {
    var rect = anchor.getBoundingClientRect();
    // Position to the right of the sidebar button, aligned to its top
    var left = rect.right + 6;
    var top = rect.top;
    // If it overflows right edge, position to the left of the button instead
    if (left + popRect.width > window.innerWidth - 8) {
      left = rect.left - popRect.width - 6;
    }
    // If it overflows bottom, shift up
    if (top + popRect.height > window.innerHeight - 8) {
      top = window.innerHeight - popRect.height - 8;
    }
    // Clamp top
    top = Math.max(8, top);
    left = Math.max(8, left);
    pop.style.top = top + 'px';
    pop.style.left = left + 'px';
  } else {
    // Fallback: center of viewport
    pop.style.top = Math.max(8, (window.innerHeight - popRect.height) / 2) + 'px';
    pop.style.left = Math.max(8, (window.innerWidth - popRect.width) / 2) + 'px';
  }

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
function scanTerminals() {
  var btn = document.getElementById('scan-btn');
  btn.textContent = '...'; btn.disabled = true;
  fetch('/api/terminals').then(function(r) { return r.json(); }).then(function(t) {
    lastScanResults = t;
    renderTerminals(t); btn.textContent = 'Scan'; btn.disabled = false;
  }).catch(function() { lastScanResults = []; renderTerminals([]); btn.textContent = 'Scan'; btn.disabled = false; });
}

function renderTerminals(terminals) {
  var list = document.getElementById('terminal-list');
  list.textContent = '';
  if (terminals.length === 0) {
    var e = document.createElement('li'); e.className = 'empty-state'; e.textContent = 'No agents found';
    list.appendChild(e); return;
  }
  terminals.forEach(function(t) {
    var li = document.createElement('li'); li.className = 'terminal-item';
    var type = document.createElement('span'); type.className = 'terminal-type ' + t.type; type.textContent = t.type;
    var info = document.createElement('div'); info.className = 'terminal-info';
    if (t.tabTitle) {
      var title = document.createElement('span'); title.className = 'terminal-tab-title'; title.textContent = t.tabTitle;
      info.appendChild(title);
    }
    var pid = document.createElement('span'); pid.className = 'terminal-pid'; pid.textContent = 'PID ' + t.pid;
    info.appendChild(pid);
    var joined = agents.some(function(a) { return a.pid === t.pid; });
    var inv = document.createElement('button'); inv.className = 'terminal-invite';
    inv.textContent = joined ? 'Joined' : 'Invite'; inv.disabled = joined;
    if (!joined) inv.addEventListener('click', function() { inviteTerminal(t); });
    li.appendChild(type); li.appendChild(info); li.appendChild(inv); list.appendChild(li);
  });
}

function inviteTerminal(t) {
  var defaultName = t.tabTitle || t.type;
  customPrompt('Name for this ' + t.type + ' agent:', defaultName, function(name) {
    if (!name) return;
    var payload = { name: name, pid: t.pid };
    if (t.wtSession) payload.wtSession = t.wtSession;
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
