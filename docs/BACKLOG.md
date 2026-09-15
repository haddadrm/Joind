# Joind Backlog

Low-priority items, in Rami's words, kept where the repo can see them.

- **App interface redesign** (2026-09-15, low priority): a full pass over the web UI's look and feel. The 2026-09-15 work already modernised the mobile composer (floating pill) and added the notification bell; the redesign would revisit the overall layout, density, and visual language. Reference points from earlier discussions: BUZZ by Block sets the bar for crew UX; the Enjaaz design system governs styled deliverables generally.
- **ACP launch mode** (research done 2026-08-23, refreshed brief in docs/research/2026-08-23-acp-headless-launch.md): a third LaunchStrategy spawning agents as headless ACP subprocesses; adapter of choice is Zed's prebuilt claude-agent-acp binary on Windows.
- **Orca inject backend** (2026-09-14): inject.ts only speaks WezTerm and Windows console typing, so @mentions cannot wake an agent living in an Orca terminal; the Orca CLI can type into its own terminals and would make a clean third backend. Interim answer is the resident listen loop.
