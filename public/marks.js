// Joind marks (6 Oct 2026, decisions in variant B and M1): the server badge,
// the favicon, member marks and read-only seats in the member list.
//
// The pure helpers here are loaded by the tests with a stand-in `module`;
// the DOM builders take the document so they run in JSDOM too. The page
// loads this before app.js (defines window.joindMarks).
//
// The default badge rule matches src/server-badge.ts exactly (the first
// letter or digit of the name, upper-cased, on a palette colour picked by an
// FNV-1a hash of the lower-cased name); tests/marks.test.ts holds the two in
// step. The page uses it only for a server that did not send its own badge
// (a peer too old to send one, or a host this server has no link to).
(function(root, factory) {
  if (typeof module === 'object' && module && 'exports' in module) {
    module.exports = factory();
  } else {
    root.joindMarks = factory();
  }
})(typeof window !== 'undefined' ? window : this, function() {
  'use strict';

  // White text clears 4.5:1 on each (same list as src/server-badge.ts).
  var PALETTE = ['#0e7490', '#b45309', '#15803d', '#1d4ed8', '#be123c', '#475569', '#4d7c0f', '#a21caf'];
  var CODE = /^[\p{L}\p{N}]{1,2}$/u;
  var COLOR = /^#[0-9a-fA-F]{6}$/;
  var FIRST = /[\p{L}\p{N}]/u;
  // The Lucide hexagon and eye, drawn inline so a mark never waits on the icon CDN.
  var HEX_PATH = 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z';
  var EYE_PATH = 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z';
  // The accent in each theme (public/style.css --accent light, --accent-bright dark).
  var ACCENT_LIGHT = '#7330e3';
  var ACCENT_DARK = '#a78bfa';
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function badgeHash(name) {
    var s = String(name || '').toLowerCase();
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function defaultBadge(name) {
    var m = FIRST.exec(String(name || ''));
    var first = m ? m[0].toUpperCase() : 'J';
    return { code: Array.from(first).slice(0, 2).join(''), color: PALETTE[badgeHash(name) % PALETTE.length] };
  }

  // A badge as received (from /api/instance, a link, a socket event):
  // both fields valid, or null. Nothing unchecked reaches a style.
  function validBadge(b) {
    if (!b || typeof b !== 'object') return null;
    var code = typeof b.code === 'string' ? b.code.trim() : '';
    var color = typeof b.color === 'string' ? b.color.trim() : '';
    if (!CODE.test(code) || !COLOR.test(color)) return null;
    return { code: code, color: color.toLowerCase() };
  }

  // The badge for a server name. ctx: { selfName, selfBadge, links }.
  // This server: its own badge; a linked server: the badge it sent; anyone
  // else (or nothing valid sent): the default for the name.
  function badgeFor(server, ctx) {
    ctx = ctx || {};
    if (server && server === ctx.selfName) return validBadge(ctx.selfBadge) || defaultBadge(server);
    var list = Array.isArray(ctx.links) ? ctx.links : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].name === server) {
        var b = validBadge(list[i].badge);
        if (b) return b;
        break;
      }
    }
    return defaultBadge(server);
  }

  // The server a member's terminal lives on, when that is not this server:
  // its `host`, else (in a remote room) the room's home. Null for a member
  // on this server.
  function memberHost(agent, roomServer, selfName) {
    if (!agent) return null;
    var h = agent.host || roomServer || null;
    return h && h !== selfName ? h : null;
  }

  function joinRouteLabel(route) {
    if (route === 'mcp') return 'MCP';
    if (route === 'rest') return 'REST';
    return 'not stated';
  }

  // The active seats of one room, by name.
  function seatsForRoom(seats, convId) {
    if (!Array.isArray(seats) || !convId) return [];
    return seats.filter(function(s) { return s && s.conversationId === convId && typeof s.name === 'string'; })
      .slice().sort(function(a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0; });
  }

  // The members button's count and label with the room's seats added (the
  // panel lists them, so the count does too).
  function seatSummary(summary, seatCount) {
    var s = summary || { count: 0, label: 'No members yet' };
    var n = seatCount > 0 ? seatCount : 0;
    if (n === 0) return { count: s.count, label: s.label };
    var seatText = n + ' read only';
    return { count: s.count + n, label: s.count > 0 ? s.label + ', ' + seatText : 'Members: ' + seatText };
  }

  // True when the seat read within the window (its dot is green).
  function seatReadRecently(seat, nowMs, windowMs) {
    return !!(seat && typeof seat.lastUsedAt === 'number' && nowMs - seat.lastUsedAt <= windowMs);
  }

  // WCAG contrast of white text on a #rrggbb colour.
  function whiteContrast(hex) {
    if (!COLOR.test(String(hex || ''))) return 0;
    var c = [1, 3, 5].map(function(i) {
      var v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    var l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    return 1.05 / (l + 0.05);
  }

  function escapeXml(s) {
    return String(s).replace(/[<>&'"]/g, function(ch) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch];
    });
  }

  // The favicon: the outlined hexagon in the accent (the darker accent on a
  // light tab strip, the lighter one on a dark strip, by the SVG's own
  // colour-scheme query), with a faint fill so it holds at 16 px. With a
  // badge, the server's code on its colour in the top corner.
  function faviconSvg(badge) {
    var b = validBadge(badge);
    var parts = [
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>",
      '<style>.h{stroke:' + ACCENT_LIGHT + ';fill:' + ACCENT_LIGHT + '}@media (prefers-color-scheme:dark){.h{stroke:' + ACCENT_DARK + ';fill:' + ACCENT_DARK + '}}</style>',
      "<path class='h' fill-opacity='0.16' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round' d='" + HEX_PATH + "'/>"
    ];
    if (b) {
      parts.push("<rect x='11' y='0' width='13' height='12' rx='3' fill='" + b.color + "'/>");
      parts.push("<text x='17.5' y='9.2' text-anchor='middle' font-family='Arial,Helvetica,sans-serif' font-weight='700' font-size='" + (Array.from(b.code).length > 1 ? 7 : 9) + "' fill='#ffffff'>" + escapeXml(b.code) + '</text>');
    }
    parts.push('</svg>');
    return parts.join('');
  }

  function faviconHref(badge) {
    return 'data:image/svg+xml,' + encodeURIComponent(faviconSvg(badge));
  }

  // --- DOM builders -----------------------------------------------------

  function icon(doc, d, size, circle) {
    var svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var p = doc.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
    if (circle) {
      var c = doc.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', '12');
      c.setAttribute('cy', '12');
      c.setAttribute('r', '3');
      svg.appendChild(c);
    }
    return svg;
  }

  function hexIcon(doc, size) { return icon(doc, HEX_PATH, size, false); }
  function eyeIcon(doc, size) { return icon(doc, EYE_PATH, size, true); }

  // The server badge: a code on its colour. `inline` for a heading.
  function badgeEl(doc, badge, inline) {
    var b = validBadge(badge);
    var el = doc.createElement('span');
    el.className = 'sbadge' + (inline ? ' inline' : '');
    el.setAttribute('aria-hidden', 'true');
    if (!b) { el.hidden = true; return el; }
    el.textContent = b.code;
    el.style.background = b.color;
    return el;
  }

  // The read-only seat's eye badge (same corner as the server badge).
  function eyeBadgeEl(doc, size) {
    var el = doc.createElement('span');
    el.className = 'kbadge';
    el.setAttribute('aria-hidden', 'true');
    el.appendChild(eyeIcon(doc, size || 9));
    return el;
  }

  return {
    PALETTE: PALETTE,
    badgeHash: badgeHash,
    defaultBadge: defaultBadge,
    validBadge: validBadge,
    badgeFor: badgeFor,
    memberHost: memberHost,
    joinRouteLabel: joinRouteLabel,
    seatsForRoom: seatsForRoom,
    seatSummary: seatSummary,
    seatReadRecently: seatReadRecently,
    whiteContrast: whiteContrast,
    faviconSvg: faviconSvg,
    faviconHref: faviconHref,
    hexIcon: hexIcon,
    eyeIcon: eyeIcon,
    badgeEl: badgeEl,
    eyeBadgeEl: eyeBadgeEl
  };
});
