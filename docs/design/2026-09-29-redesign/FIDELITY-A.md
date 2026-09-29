# Redesign A: fidelity pass (lane 3b)

29 Sep 2026. Mockup `A-slack-rail.html` against the build on branch `redesign-a`, side by side in Playwright at 1280 px and 400 px, area by area. Paired screenshots in the scratchpad: `fidelity-<area>-mock.png` and `fidelity-<area>-build.png`, with a `-400` suffix for the phone width. Areas: chat, members, pins, crew, dms, decisions, tasks, search, menu, settings, light, and the phone drawer (`fidelity-drawer-400-*`). The build shots come from a throwaway server seeded with a copy of one room, six joined agents and a crew roster with harnesses.

Every visible divergence is listed. "Fixed to match A" means the build now shows what A shows. "Kept on purpose" gives the reason, usually a working feature the mockup did not show, or a later lane.

## Crew, avatars and pills (first, as Rami asked)

| Area | Divergence | Status | Note |
|---|---|---|---|
| Crew rail section | A shows a Crew page in the content column (member cards, Terminals, Session templates); the build only switched the sidebar | Fixed to match A | Crew is now a page titled "Crew, Presence, terminals and sessions": member cards (you first, "human, here"), terminal cards with Invite or Dismiss and a Scan button, template cards with Start |
| Crew sidebar | A lists the crew as rows (avatar with presence dot, one-word state), then Terminals and Session templates as compact rows; the build had "Crew roster" and "Launch an agent" links and big template cards | Fixed to match A | Rows now read active, turn, idle, silent or offline; templates are one-line rows that start the session; the roster and launcher moved to the page head and the sidebar head "+" |
| Crew page actions | A has no buttons on the page | Kept on purpose | "Crew roster" and "Launch an agent" are the only way into the roster editor and the launcher |
| Avatars | A draws every member as a rounded square with the presence dot on its corner (DM rows, crew rows, cards, members panel, the toolbar stack); the build had a separate green dot beside a small avatar and circles in the stack | Fixed to match A | One avatar with a corner dot everywhere; the toolbar stack uses rounded squares |
| Presence colours | A: active green, working accent (turn running), idle orange, silent and offline gray; the build had stale gray and silent orange | Fixed to match A | "idle" is the server's stale (presence lost); "working" is a running turn |
| Harness pills | A tags each message header with the harness ("Claude Code", "Codex CLI", "OpenClaw") or "remote: y530"; the build showed an upper-case role badge after the time | Fixed to match A | The tag comes from a Codex queue join, the terminal scan by pid, or the crew roster's default harness; a hosted member shows remote: server; order is sender, tag, role, id, time |
| Role badge | A shows no role | Kept on purpose | Joind roles are a feature; the badge stays, now mixed case and after the harness tag |
| Members panel rows | A: you first ("Admiral (Rami), human, here"), then harness, state in the sub line, names in the bright text, remote as plain text; the build omitted you, led with the role, coloured the names and used a remote chip | Fixed to match A | You are listed first under Active now; the sub line is harness (or hosted, remote: server), role, state |
| Members count | A counts the human in the button; the build counts agents and recent authors | Kept on purpose | The button counts crew; you are in the list, not the count |

## Rail

| Area | Divergence | Status | Note |
|---|---|---|---|
| Brand | A has a letter tile; the build had a hexagon icon | Fixed to match A | The tile shows the instance name's initial; the full name is its tooltip and is in your menu |
| Order | A puts Search with the sections, above the spacer; the build put it at the foot | Fixed to match A | |
| Tasks icon | A uses a board icon; the build used a clipboard | Fixed to match A | |
| Rooms badge | A shows the rooms' unread total | Fixed to match A | Counted from the socket since the page loaded (the server keeps read cursors for agents only) |
| Your avatar | A shows the avatar only, with a green presence dot | Fixed to match A | The dot is the connection status (red and pulsing when the socket drops); the name label is gone at desktop; the phone tab reads "You" |

## Sidebar

| Area | Divergence | Status | Note |
|---|---|---|---|
| Head | A: the view title and a "+"; the build showed the instance name under the title and the connection dot | Fixed to match A | "+" is New room in Rooms and Launch an agent in Crew; DMs has no action (no new-DM flow exists) |
| Section add | A shows the section "+" on hover; the build had a "+ New" button | Fixed to match A | Hover or keyboard focus shows it |
| Room rows | A: "#" glyph, bold when unread, a red mention count or a soft unread count; the build showed the total message count as the badge | Fixed to match A | The total count moved to the row tooltip; rows are now keyboard operable (Enter) |
| Remote rows | A: a globe glyph | Fixed to match A | |
| Find a room | Not in A | Kept on purpose | Existing room filter |
| DM rows | A: avatar with dot, name, state on the right ("working", "idle 14m", "offline 2d") | Fixed to match A | The unread count replaces the state when there is one |

## Conversation toolbar

| Area | Divergence | Status | Note |
|---|---|---|---|
| Search field | A: "Search in #room"; the build "Search # room" | Fixed to match A | "Search in DM" in a DM |
| Sidebar toggle | A has no toggle at desktop | Kept on purpose | It collapses the sidebar (the polish lane's feature) |
| DM header | A shows the partner's avatar and "harness, state" | Fixed to match A | |
| Pins in a DM | A shows pins in a DM | Kept on purpose | Pins belong to a room; a DM is a cross-room mailbox |
| Phone toolbar | A has no search button on a phone | Fixed to match A | Search moved into the More menu with export and import |
| Room topic | A shows a topic | Kept on purpose | Rooms have no topic field; remote rooms show the link state there |

## Messages and composer

| Area | Divergence | Status | Note |
|---|---|---|---|
| Time | A shows hours and minutes; the build showed seconds | Fixed to match A | The full date and time is the tooltip |
| Mentions of you | A tints the row with an accent bar | Fixed to match A | @you as a whole word, or a decision asked of you |
| System lines | A shows wake lines in the text column with a dot; the build centred them in italics | Fixed to match A | All system lines use A's wake style |
| Composer | A: the field, then a bar with attach, decision, task, the hint and send; the build had one row and the hint below | Fixed to match A | Attach opens an image picker (upload as before); task opens the new-task form |
| Placeholder | A: "Message #room" | Fixed to match A | "Message name" in a DM |
| Phone header clipping | The build clipped the time at 400 px | Fixed | Headers wrap |

## Menu, settings, theme, phone

| Area | Divergence | Status | Note |
|---|---|---|---|
| Menu head | A: name, "active, human" | Fixed to match A | "active, human, instance" |
| Menu items | A adds "Sounds on" and a "Ctrl ," hint | Fixed to match A | Sounds is a checkbox item; Ctrl+, (Cmd+, on a Mac) opens Settings |
| Settings content | A shows five rows with switches | Kept on purpose | The modal also carries colour, per-agent sounds, roles and Clear view, all existing features; the Done button now matches A |
| Theme control | A uses a switch | Kept on purpose | Two named choices read clearer than an unlabelled switch |
| Light theme | Matches A's palette | Kept on purpose, darker text | Muted, success, warning and danger are darker than A so every text colour clears 4.5:1 (lane 3 gate) |
| Phone tab bar | A has six tabs, no Activity | Kept on purpose | The bell has no other home on a phone |

## Pages A shows that come later

| Area | Status | Note |
|---|---|---|
| Decisions page | Kept for lane 4 | The rail opens the decisions panel until then |
| Tasks board | Kept for lane 5 | The rail opens the task panel until then |
| Search page (across rooms and DMs, recent searches, filter chips) | Kept on purpose | Search is per room on the server; a cross-room search needs a server route, outside lanes 4 to 6; the command palette (lane 6) covers jumping |
