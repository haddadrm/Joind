// Pure helpers for the page, kept apart from app.js so the tests can load
// them under Node: the bare message number in the search box, the sidebar
// drag outcome, member presence (order, short ages, how many pills fit
// before a +N chip), and the rail and members panel (which sections a rail
// view shows, offline authors, the panel's groups, the button's count).
//
// Loaded as a plain script in the page (defines window.joindUi) and
// evaluated by the tests with a stand-in `module`.
(function(root, factory) {
  if (typeof module === 'object' && module && 'exports' in module) {
    module.exports = factory();
  } else {
    root.joindUi = factory();
  }
})(typeof window !== 'undefined' ? window : this, function() {
  'use strict';

  // A search query that is only a message number: `1234` or `#1234`, with
  // surrounding spaces. The same digit bound as the #N links (1 to 12
  // digits). Returns the id, or null for anything else (a range, a word).
  function parseBareMessageNumber(q) {
    var m = /^#?(\d{1,12})$/.exec(String(q == null ? '' : q).trim());
    if (!m) return null;
    var id = Number(m[1]);
    return id >= 1 && Number.isSafeInteger(id) ? id : null;
  }

  // Where a sidebar drag lands. `raw` is the pointer's distance from the
  // app's left edge. Below `collapseAt` the release collapses the sidebar;
  // the width shown meanwhile stays clamped to [min, max].
  function sidebarDragOutcome(raw, min, max, collapseAt) {
    var w = Math.max(min, Math.min(max, Math.round(raw)));
    return { width: w, collapse: raw < collapseAt };
  }

  // Presence of one member for the strip: stale (presence lost) outranks
  // silent (quiet for more than 30 minutes); everyone else is online.
  var SILENT_AFTER_MS = 30 * 60000;
  function pillPresence(stale, quietMs) {
    if (stale) return 'stale';
    if (quietMs != null && quietMs > SILENT_AFTER_MS) return 'silent';
    return 'online';
  }

  var PRESENCE_RANK = { online: 0, stale: 1, silent: 2 };
  // Online first, then stale, then silent; the incoming order holds within
  // each group. `presenceOf(item)` names the group. Returns a new array.
  function orderByPresence(items, presenceOf) {
    return items
      .map(function(item, i) { return { item: item, i: i, r: PRESENCE_RANK[presenceOf(item)] || 0 }; })
      .sort(function(a, b) { return a.r - b.r || a.i - b.i; })
      .map(function(x) { return x.item; });
  }

  // The short age on a pill: 45m, 9h, 3d.
  function shortAge(ms) {
    var m = Math.max(0, Math.round(ms / 60000));
    if (m < 60) return m + 'm';
    var h = Math.floor(m / 60);
    if (h < 48) return h + 'h';
    return Math.floor(h / 24) + 'd';
  }

  // --- Redesign lane 2: the rail and the members panel ---

  // The rail views that change what the sidebar shows. Anything else (a
  // stale or hand-edited stored value) falls back to rooms.
  var RAIL_VIEWS = ['rooms', 'dms', 'crew', 'decisions', 'tasks'];
  function railView(value) {
    return RAIL_VIEWS.indexOf(value) >= 0 ? value : 'rooms';
  }

  // Whether a sidebar section belongs to a view. `views` is the section's
  // space-separated data-views list; a section without one shows in every
  // view.
  function sectionInView(views, view) {
    if (views == null || String(views).trim() === '') return true;
    return String(views).trim().split(/\s+/).indexOf(view) >= 0;
  }

  // Room members who are not connected: the authors of the loaded messages
  // who are not in `present` and are not `me`, newest post first, at most
  // `limit`. System lines and this server's local lines (negative ids) are
  // not authors. Returns [{ name, lastAt }].
  function offlineAuthors(messages, present, me, limit) {
    var seen = {};
    var out = [];
    var max = limit == null ? 20 : limit;
    for (var i = (messages || []).length - 1; i >= 0 && out.length < max; i--) {
      var m = messages[i];
      if (!m || typeof m.sender !== 'string' || m.sender === '' || m.sender === 'system') continue;
      if (typeof m.id === 'number' && m.id < 0) continue;
      if (m.sender === me || present.indexOf(m.sender) >= 0) continue;
      if (Object.prototype.hasOwnProperty.call(seen, m.sender)) continue;
      seen[m.sender] = true;
      out.push({ name: m.sender, lastAt: typeof m.timestamp === 'number' ? m.timestamp : null });
    }
    return out;
  }

  // The panel's groups, in order, each [key, label, items], empty groups
  // left out. Connected members are grouped by presence: online is Active
  // now, stale (presence lost) is Idle, silent (quiet 30 minutes) is Silent;
  // `offline` fills the last group. The incoming order holds within a group.
  var GROUPS = [['active', 'Active now'], ['idle', 'Idle'], ['silent', 'Silent'], ['offline', 'Offline']];
  var GROUP_OF = { online: 'active', stale: 'idle', silent: 'silent' };
  function memberGroups(items, presenceOf, offline) {
    var by = { active: [], idle: [], silent: [], offline: (offline || []).slice() };
    items.forEach(function(item) { by[GROUP_OF[presenceOf(item)] || 'active'].push(item); });
    return GROUPS
      .filter(function(g) { return by[g[0]].length > 0; })
      .map(function(g) { return [g[0], g[1], by[g[0]]]; });
  }

  // The members button: the count it shows and the words behind it.
  function membersSummary(connected, offline) {
    var total = connected + offline;
    if (total === 0) return { count: 0, label: 'No members yet' };
    var parts = [connected + ' connected'];
    if (offline > 0) parts.push(offline + ' offline');
    return { count: total, label: 'Members: ' + parts.join(', ') };
  }

  // --- Redesign lane 3b ---

  // Whether text mentions @name as a whole word (case-insensitive): not
  // inside an email address or a longer name (@Ramiro, rami@host).
  function mentionsName(text, name) {
    if (!name) return false;
    var esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^\\w@])@' + esc + '(?![\\w-])', 'i').test(String(text == null ? '' : text));
  }

  // --- Redesign lane 5: the task board ---

  var BOARD_COLUMNS = [['open', 'Open'], ['in_progress', 'In progress'], ['review', 'In review'], ['done', 'Done']];
  function boardColumns() {
    return BOARD_COLUMNS.map(function(c) { return [c[0], c[1]]; });
  }

  // The cards a board shows. `f`: { view: 'all' | 'mine' | 'urgent', room:
  // a conversation id or 'all', who: assignee names to keep (empty keeps
  // everyone; '' stands for unassigned), me: the viewer's name }.
  function filterBoardTasks(tasks, f) {
    var who = (f && f.who) || [];
    return (tasks || []).filter(function(t) {
      if (f && f.view === 'mine' && t.assignee !== f.me) return false;
      if (f && f.view === 'urgent' && !(t.priority === 'urgent' && t.status !== 'done')) return false;
      if (f && f.room && f.room !== 'all' && t.conversationId !== f.room) return false;
      if (who.length > 0 && who.indexOf(t.assignee || '') < 0) return false;
      return true;
    });
  }

  // Cards by column: an unknown state goes to Open; urgent first, then the
  // most recently updated.
  function groupByStatus(tasks) {
    var out = { open: [], in_progress: [], review: [], done: [] };
    (tasks || []).forEach(function(t) {
      (Object.prototype.hasOwnProperty.call(out, t.status) ? out[t.status] : out.open).push(t);
    });
    Object.keys(out).forEach(function(k) {
      out[k].sort(function(a, b) {
        var ua = a.priority === 'urgent' && k !== 'done' ? 0 : 1;
        var ub = b.priority === 'urgent' && k !== 'done' ? 0 : 1;
        return ua - ub || (b.updatedAt || 0) - (a.updatedAt || 0);
      });
    });
    return out;
  }

  // --- Redesign lane 6: the command palette ---

  // How well a query matches a label: 0 for no match; higher is better. A
  // prefix of the label beats a word start, which beats a substring, which
  // beats letters in order (subsequence). Case-insensitive; spaces in the
  // query are ignored for the subsequence test.
  function paletteScore(query, label) {
    var q = String(query == null ? '' : query).trim().toLowerCase();
    var l = String(label == null ? '' : label).toLowerCase();
    if (!q) return 1;
    if (l.indexOf(q) === 0) return 400 - Math.min(l.length, 200);
    var words = l.split(/[^a-z0-9]+/);
    for (var i = 0; i < words.length; i++) {
      if (words[i] && words[i].indexOf(q) === 0) return 300 - Math.min(l.length, 200);
    }
    if (l.indexOf(q) >= 0) return 200 - Math.min(l.length, 200);
    var qs = q.replace(/\s+/g, '');
    var at = 0;
    for (var k = 0; k < l.length && at < qs.length; k++) {
      if (l[k] === qs[at]) at++;
    }
    return at === qs.length ? 100 - Math.min(l.length, 99) : 0;
  }

  // The items that match, best first; equal scores keep their given order
  // (so groups stay in the order the palette lists them). Each item has a
  // label and optional keywords that also match. At most `limit`.
  function paletteRank(items, query, limit) {
    var max = limit == null ? 50 : limit;
    return (items || [])
      .map(function(item, i) {
        var s = paletteScore(query, item.label);
        if (item.keywords) {
          var ks = paletteScore(query, item.keywords);
          if (ks > 0) s = Math.max(s, Math.round(ks / 2));
        }
        return { item: item, i: i, s: s };
      })
      .filter(function(x) { return x.s > 0; })
      .sort(function(a, b) { return b.s - a.s || a.i - b.i; })
      .slice(0, max)
      .map(function(x) { return x.item; });
  }

  // --- Composer plus-menu (29 Sep 2026) ---

  // A link card's url: http or https only, parsed and re-serialised, with
  // no credentials. Anything else (javascript:, data:, a bare word) is null.
  function linkCardUrl(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s || s.length > 2048 || /[\u0000- \u007f]/.test(s)) return null;
    if (!/^https?:\/\//i.test(s)) return null;
    var u;
    try { u = new URL(s); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname || u.username || u.password) return null;
    return u.href;
  }

  // What a card shows without a title: host and path (no query, no
  // fragment, no trailing slash on a bare host).
  function linkCardLabel(href) {
    var u;
    try { u = new URL(href); } catch (e) { return String(href || ''); }
    var path = u.pathname === '/' ? '' : u.pathname;
    try { path = decodeURI(path); } catch (e) { /* keep it encoded */ }
    return u.host + path;
  }

  // Markdown characters escaped so a title or a file name stays literal
  // link text. Newlines become spaces.
  function escapeLinkText(t) {
    return String(t == null ? '' : t).replace(/[\r\n\t]+/g, ' ').replace(/[\\`*_\[\]<>~|#!]/g, '\\$&').trim();
  }

  // The Markdown a link card is written as: a plain link whose title is
  // "card", so any reader (an agent, an older page, a linked server) sees
  // an ordinary link and this page draws it as a card. Null for a url the
  // card refuses.
  function linkCardMarkdown(raw, title) {
    var href = linkCardUrl(raw);
    if (!href) return null;
    var t = String(title == null ? '' : title).replace(/\s+/g, ' ').trim().slice(0, 200);
    var text = escapeLinkText(t || href);
    return '[' + text + '](<' + href.replace(/[<>\s]/g, encodeURIComponent) + '> "card")';
  }

  // A file upload as the Markdown link chat_upload writes: a paperclip,
  // the escaped name, the upload url.
  function fileLinkMarkdown(name, url) {
    var n = escapeLinkText(String(name || 'file').slice(0, 120)) || 'file';
    return '📎 [' + n + '](' + url + ')';
  }

  // Every image a message carries, whichever schema wrote it (`images` for
  // two or more, else `image`), keeping only this server's upload urls.
  var UPLOAD_URL = /^\/data\/files\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
  function messageImageList(msg) {
    if (!msg) return [];
    var list = Array.isArray(msg.images) && msg.images.length > 0 ? msg.images : (msg.image ? [msg.image] : []);
    var out = [];
    list.forEach(function(u) {
      if (typeof u === 'string' && UPLOAD_URL.test(u) && u.indexOf('..') < 0 && out.indexOf(u) < 0) out.push(u);
    });
    return out;
  }

  // Snippets matching a filter: every word must appear in the title or the
  // text (case-insensitive); title matches first, then the stored order.
  function filterSnippets(list, q) {
    var words = String(q == null ? '' : q).toLowerCase().split(/\s+/).filter(Boolean);
    var items = (Array.isArray(list) ? list : []).map(function(s, i) { return { s: s, i: i }; });
    if (words.length === 0) return items.map(function(x) { return x.s; });
    return items.filter(function(x) {
      var hay = (String(x.s.title || '') + '\n' + String(x.s.text || '')).toLowerCase();
      return words.every(function(w) { return hay.indexOf(w) >= 0; });
    }).map(function(x) {
      var t = String(x.s.title || '').toLowerCase();
      return { s: x.s, i: x.i, t: words.every(function(w) { return t.indexOf(w) >= 0; }) ? 0 : 1 };
    }).sort(function(a, b) { return a.t - b.t || a.i - b.i; }).map(function(x) { return x.s; });
  }

  // Text inserted into a value at [start, end): the new value and caret.
  // `ownLine` puts the text on a line of its own.
  function insertText(value, start, end, text, ownLine) {
    var v = String(value == null ? '' : value);
    var a = Math.max(0, Math.min(v.length, start == null ? v.length : start));
    var b = Math.max(a, Math.min(v.length, end == null ? a : end));
    var t = String(text == null ? '' : text);
    if (ownLine) {
      if (a > 0 && v.charAt(a - 1) !== '\n') t = '\n' + t;
      if (b < v.length && v.charAt(b) !== '\n') t = t + '\n';
    }
    return { value: v.slice(0, a) + t + v.slice(b), caret: a + t.length };
  }

  // Which images of a batch still fit under the per-message cap.
  function imagesThatFit(have, adding, max) {
    var room = Math.max(0, max - have);
    return { take: Math.min(room, adding), refused: Math.max(0, adding - room) };
  }

  return {
    linkCardUrl: linkCardUrl,
    linkCardLabel: linkCardLabel,
    linkCardMarkdown: linkCardMarkdown,
    fileLinkMarkdown: fileLinkMarkdown,
    messageImageList: messageImageList,
    filterSnippets: filterSnippets,
    insertText: insertText,
    imagesThatFit: imagesThatFit,
    paletteScore: paletteScore,
    paletteRank: paletteRank,
    boardColumns: boardColumns,
    filterBoardTasks: filterBoardTasks,
    groupByStatus: groupByStatus,
    mentionsName: mentionsName,
    railView: railView,
    sectionInView: sectionInView,
    offlineAuthors: offlineAuthors,
    memberGroups: memberGroups,
    membersSummary: membersSummary,
    parseBareMessageNumber: parseBareMessageNumber,
    sidebarDragOutcome: sidebarDragOutcome,
    pillPresence: pillPresence,
    orderByPresence: orderByPresence,
    shortAge: shortAge
  };
});
