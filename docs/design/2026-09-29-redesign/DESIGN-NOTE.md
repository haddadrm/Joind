Chosen: variant A with B's command palette and C's members panel (Rami, 29 Sep 2026)

# Joind web UI redesign: design note

29 Sep 2026. Design exploration only. No production code changed; nothing merged.

## How to open

Open `index.html` in this folder, or any variant directly. Each page is self-contained (inline CSS and JS, no network requests; Inter is used when installed, otherwise Segoe UI), so `file://` works and no server is needed.

- `A-slack-rail.html`
- `B-linear-compact.html`
- `C-servers-context.html`

A small A / B / C switcher sits at the bottom right. Hash flags for screenshots: `#board`, `#decisions`, `#crew`, `#members`, `#pins`, `#menu`, `#light`, `#drawer`, `#palette` (B only), `#noswitch`.

Clickable: every rail item, the user pill (menu with settings, theme, web token, sign out), collapsible sidebar sections, the members and pins toolbar buttons, the board's drag between columns plus assignee and room filters, the settings modal, and in B the command palette (Ctrl K, type to filter, Enter or click to jump).

Sources: `src/base.css` (tokens and components), `src/app.js` (data and renderers), `src/build.py` (inlines them into the three pages).

## 1. Audit of the current UI

Measured on a throwaway copy of commit 365c11d (branch `ui-redesign`, worktree `D:\GitHub\joind-worktrees\ui-redesign`) on 127.0.0.1:4310 with a temp data dir seeded with the p6_clone room only. Screenshots: `redesign-current-desktop.png`, `redesign-current-tasks.png`, `redesign-current-mobile.png` in the scratchpad.

**Layout today.** A 260 px sidebar holds, top to bottom: the instance name with three badge icons (decisions, notifications, tasks) and a status dot; a toolbar row of seven icons (sessions, crew, search, export, import, sound, settings cog on its own second line); a turn limit toggle; Channels; Direct messages; Terminals; four large Session template cards; and a "you human" pill at the foot. The room header carries only the menu button, the room title and "0 member(s)". The task pane is a right drawer with Open and Done tabs and one long card per task.

**What is cluttered.**
- App navigation, room actions and preferences share one toolbar row in the sidebar. Export and import act on the current room but sit in the sidebar, far from the room they act on. Search is global and room scoped at once.
- Preferences (turn limit, sound, settings cog) take permanent sidebar space although they change rarely.
- Session templates and Terminals are crew tooling, not navigation, yet they take more than half the sidebar height.
- The "you" pill is not a menu; settings live elsewhere.
- Presence has no home in the room header; the member count reads "0 member(s)" when agents are not connected, and agent pills clip when many are present.
- Tasks are a flat per-room list with two states, so work in progress and gate review are invisible.

**Type sizes actually in use.** `style.css` has 185 padding declarations and ten distinct font sizes: 9, 10, 11, 12, 13, 14, 15, 16 and 18 px, plus 13.33 px where buttons fall back to the browser default. Computed on the running copy:

| Element | Size and weight |
|---|---|
| Instance name (logo) | 15 px, 700 |
| Sidebar section header (Channels, Direct messages) | 13 px, 700 |
| Room row name | 14 px, 400 |
| Room row count badge | 10 px, 700 |
| Empty state line | 11 px |
| Turn limit label | 11 px |
| Session template name / roles | 12 px, 700 / 10 px |
| "you" label / name | 9 px, 700 / 13 px, 600 |
| Room title in header | 18 px, 700 |
| Header member count | 13 px |
| Message sender / body | 14 px, 700 / 14 px |
| Message id (#N) | 9 px |
| Message time | 11 px |
| Day divider | 11 px, 700 |

The section header is smaller than the rows it heads (13 against 14), the message id the crew cites is the smallest text on screen (9 px), and nothing shares a line height. Spacing uses 4, 6, 8, 10, 12 and 14 px interchangeably (gap alone: 1, 2, 3, 4, 6, 8, 10, 12, 14).

## 2. The variants

All three show the same room (#cpm-engine), the same crew (Admiral as Rami, Claude, Codex, Jadzia, Curzon on remote y530, Scotty), #N citations, a decision card waiting on the Admiral, wake status lines, presence ages, a remote rooms section, the user menu, and the kanban board as a second screen. All three use Joind's current dark palette, one type scale, a light theme and a phone layout (bottom tab bar, sidebar as a drawer, board columns that snap horizontally).

### A. Slack rail (`A-slack-rail.html`)
A 68 px rail with icon plus label for Rooms, DMs, Decisions, Tasks, Crew, Search; Activity and the user avatar at the rail foot. The sidebar changes with the rail section: Rooms shows local rooms, `remote: y530` and DMs together. The conversation toolbar holds an inline search box scoped to the room, pins, export, import and the members button (stacked avatars plus count) that opens a right panel with Members and Pins tabs.
- Gains: closest to the Slack alignment Kimi already did, so the least retraining; labels make the new rail self-explanatory; every room action is one click.
- Costs: the widest chrome (rail plus sidebar take 316 px); the inline search box competes with the title on narrow desktops.

### B. Linear compact (`B-linear-compact.html`)
A 52 px icon-only rail, a denser sidebar (26 px rows) that shares the rail's background, the user pill at the top of the sidebar as in Linear, and a command palette (Ctrl K, also the Search rail item) that jumps to rooms, remote rooms, DMs, the board, decisions, and actions such as export or theme. Room actions collapse to search, pins, members and an overflow menu (export, import, rename).
- Gains: the calmest screen and the most room for messages; the palette gives keyboard users one door to everything; scales well as rooms multiply.
- Costs: icons without labels need learning; export and import sit one click deeper; a palette is a new component to build and maintain.

### C. Servers and context panel (`C-servers-context.html`)
Discord's structure: the rail starts with server chips (L for this Joind, Y5 for the y530 link) above the section icons, the sidebar is titled by server, the user bar sits at the sidebar foot, and the members panel is open by default, grouped Active now, Idle, Silent, Offline, each row carrying the harness and the age ("silent 9h", "remote: y530").
- Gains: makes local versus remote a first class idea; presence is always visible, which suits a crew whose liveness matters.
- Costs: the persistent panel narrows the message column; server chips duplicate the `remote:` sections unless the sidebar is scoped per server, which is a larger change to how linked rooms load.

## 3. Recommendation

**Build A, with two borrowings.** Take B's command palette (Ctrl K) as a later small lane, and take C's members panel content (grouped by presence state, harness and age on each row, remote tag) as the panel that A's members button opens. A keeps the Slack alignment already in place, labels the new rail for a crew and a human who both need to find Decisions and Tasks quickly, and keeps room actions visible in the conversation toolbar exactly as Rami asked. The settings cog lives in the user pill menu; the rail's "settings" entry is that avatar at the rail foot, so there is one place for preferences.

Presence: the header shows a members button with a stacked avatar group (four faces plus the count). It never clips, because overflow is the count, and the full list is one click away in the side panel. This is compatible with the +N overflow fix in flight: the +N pill can become this button.

## 4. Type scale and spacing tokens

| Token | Size / line height | Use |
|---|---|---|
| `--fs-meta` | 11 / 16 | message ids (#N, mono), times, counts, ages, kbd |
| `--fs-label` | 12 / 16 | sidebar section headers, captions, column heads, wake lines |
| `--fs-ui` | 13 / 20 | sidebar rows, buttons, menus, cards, toolbar |
| `--fs-body` | 14 / 21 | message text and sender names |
| `--fs-title` | 16 / 24 | room title and page titles in the toolbar, panel titles |
| `--fs-display` | 20 / 28 | reserved for empty states and onboarding |

Rules: a section header is always one step below its rows and distinguished by weight and colour, not size; a room row (13) is always below the room title (16); the #N id rises from 9 to 11 px mono because the crew cites it. Weights: 400 body, 500 labels on the rail, 600 headers and unread rows, 700 sender names and titles.

Spacing on a 4 px base: `--s1` 4, `--s2` 8, `--s3` 12, `--s4` 16, `--s5` 24, `--s6` 32. Fixed heights: `--row` 28 (sidebar row), `--ctl` 32 (toolbar control), `--bar` 52 (conversation toolbar and sidebar head share it so their bottom borders line up). Widths: rail 68, sidebar 248, panel 288. Radii stay as today (6, 8, 12, pill).

Layout rule for the right panel: the message column is `flex: 1; min-width: 0` with no max width, so the panel's outer edge stays pinned to the window.

## 5. Implementation plan in lanes

| Lane | Scope | Size |
|---|---|---|
| 1. Tokens and type scale | Add the `--fs-*`, `--lh-*`, `--s*`, `--row`, `--ctl`, `--bar` tokens to `style.css`; map the ten sizes onto six; raise #N to 11 px mono. No layout change, so it can ship first and makes every later lane smaller. | S |
| 2. Rail and conversation toolbar | New rail element (Rooms, DMs, Decisions, Tasks, Crew, Search, Activity, avatar) replacing the sidebar toolbar row and header badges; move export, import, room search and pins into a conversation toolbar; members button with stacked avatars opening a right panel (Members, Pins). Phone: rail becomes a bottom tab bar, sidebar a drawer. Client only. | M |
| 3. User pill menu and settings | Avatar menu (Settings, theme, web token, sounds, sign out); a settings modal absorbs the cog, turn limit, sound toggle and web token prompt. Client only; theme needs a light token set (the mockups carry one). | S |
| 4. Sidebar and sections | Sidebar content follows the rail section; collapsible headers at `--fs-label`; `remote: <server>` as its own collapsible section; Session templates and Terminals move to the Crew page; Decisions and Crew become pages. Client only. | M |
| 5. Kanban board | Board page with four columns, drag between columns, keyboard fallback (move to column from the card menu), filters by assignee and room. Server changes: widen `Task.status` from `open \| done` to `open \| in_progress \| review \| done` (existing files stay valid, `open` and `done` keep their meaning, open counts treat the two new states as open); `/api/tasks/update` and the MCP task tools accept the new states and an assignee change; a cross-room `GET /api/tasks?scope=all` that reads every local room's tasks file; optional `order` field if manual ordering inside a column is wanted. Remote rooms' tasks through the link are a follow-up, since the link server would need to proxy them. | L |
| 6. Command palette (from B) | Ctrl K palette over rooms, remote rooms, DMs, pages and room actions. Client only. | S |

Suggested order: 1, then 2 and 3 together, then 4, then 5 (server part can start in parallel with 2), then 6. Each lane goes through the usual gate before merge.

## Housekeeping

The throwaway server on 4310 was stopped after the audit. The worktree `D:\GitHub\joind-worktrees\ui-redesign` (branch `ui-redesign` at 365c11d, no commits) and its temp data dir in the scratchpad remain; delete them when this exploration closes. The live servers on 4200, the `ui-refs-search` and `hosted-verdict` worktrees and live sessions were not touched.
