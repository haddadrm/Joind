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

  // How many pills (in order) fit in `available` px. All of them when their
  // widths and the gaps between them fit; otherwise the largest count that
  // still leaves room for the +N chip (and its gap) after them.
  function pillsThatFit(widths, available, gap, chipWidth) {
    var n = widths.length;
    var total = 0;
    for (var i = 0; i < n; i++) total += widths[i] + (i > 0 ? gap : 0);
    if (total <= available) return n;
    var used = chipWidth;
    var k = 0;
    while (k < n && used + widths[k] + gap <= available) {
      used += widths[k] + gap;
      k++;
    }
    return k;
  }

  // --- Redesign lane 2: the rail and the members panel ---

  // The rail views that change what the sidebar shows. Anything else (a
  // stale or hand-edited stored value) falls back to rooms.
  var RAIL_VIEWS = ['rooms', 'dms', 'crew'];
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

  return {
    railView: railView,
    sectionInView: sectionInView,
    offlineAuthors: offlineAuthors,
    memberGroups: memberGroups,
    membersSummary: membersSummary,
    parseBareMessageNumber: parseBareMessageNumber,
    sidebarDragOutcome: sidebarDragOutcome,
    pillPresence: pillPresence,
    orderByPresence: orderByPresence,
    shortAge: shortAge,
    pillsThatFit: pillsThatFit
  };
});
