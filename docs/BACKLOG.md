# Joind Backlog

Low-priority items, kept where the repo can see them.

- **Decision briefs on asks** (2026-09-21, from Curzon's follow-up): an open ask carries no substance beyond the message body, so Rami still needs a digest before he can decide. Design sketch: (a) the Decisions panel renders the asking message's first paragraph (up to ~300 chars) as the brief instead of a 140-char truncation; (b) an ask combined with `choices` renders those options as clickable buttons directly in the panel, and choosing one auto-resolves the ask, making askFor + choices the structured payload (options, recommendation first, consequences in the paragraph) with zero new schema.

- **Indexed DM pair histories** (2026-09-22, Codex gate minor): `collectDmThread` and `collectDmPartners` scan every conversation's full history per call and sort before applying the cap. Fine at current scale; the growth fix is an in-memory index keyed by pair (built at load, updated on send) with bounded newest-first retrieval.
- **App interface redesign** (2026-09-15, low priority): a full pass over the web UI's look and feel. The 2026-09-15 work already modernised the mobile composer (floating pill) and added the notification bell; the redesign would revisit the overall layout, density, and visual language. Reference points from earlier discussions: BUZZ by Block sets the bar for crew UX; the Enjaaz design system governs styled deliverables generally.
- **ACP launch mode** (research done 2026-08-23, refreshed brief in docs/research/2026-08-23-acp-headless-launch.md): a third LaunchStrategy spawning agents as headless ACP subprocesses; adapter of choice is Zed's prebuilt claude-agent-acp binary on Windows.
- **Orca inject backend** (2026-09-14): inject.ts only speaks WezTerm and Windows console typing, so @mentions cannot wake an agent living in an Orca terminal; the Orca CLI can type into its own terminals and would make a clean third backend. Interim answer is the resident listen loop.
