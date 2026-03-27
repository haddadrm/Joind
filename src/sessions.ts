/**
 * Joind Session Engine — orchestrates structured multi-phase agent workflows.
 *
 * A session is a template (code-review, debate, planning...) with agents
 * assigned to roles. The engine advances through phases, triggering each
 * agent via injection when it's their turn. Agents respond via chat_send,
 * and the engine detects the response and advances.
 */

import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { ChatRoom } from "./room.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, "..", "templates");

// Dissent mandate for review/critique roles
const DISSENT_ROLES = new Set([
  "reviewer", "red_team", "critic", "challenger", "against",
]);
const DISSENT_LINE =
  "Provide your own independent analysis. Do not repeat or defer to other participants.";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionTemplate {
  id: string;
  name: string;
  description: string;
  roles: string[];
  phases: SessionPhase[];
}

interface SessionPhase {
  name: string;
  participants: string[];
  prompt: string;
  is_output?: boolean;
  timeout?: number;
}

export interface Session {
  id: number;
  templateId: string;
  templateName: string;
  cast: Record<string, string>; // role → agent name
  goal: string;
  startedBy: string;
  startedAt: number;
  status: "active" | "complete" | "cancelled";
  currentPhase: number;
  currentTurn: number; // index within phase.participants
  waitingFor: string | null; // agent name we're waiting for
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Template loader
// ---------------------------------------------------------------------------

const templates = new Map<string, SessionTemplate>();

export function loadTemplates(): void {
  templates.clear();
  try {
    for (const file of readdirSync(TEMPLATES_DIR)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = readFileSync(join(TEMPLATES_DIR, file), "utf-8");
        const tmpl = JSON.parse(raw) as SessionTemplate;
        templates.set(tmpl.id, tmpl);
      } catch {
        /* skip bad templates */
      }
    }
  } catch {
    /* templates dir missing */
  }
  console.log(`  Loaded ${templates.size} session templates`);
}

export function getTemplates(): SessionTemplate[] {
  return [...templates.values()];
}

export function getTemplate(id: string): SessionTemplate | undefined {
  return templates.get(id);
}

// ---------------------------------------------------------------------------
// Session Engine
// ---------------------------------------------------------------------------

let nextSessionId = 1;
const activeSessions = new Map<number, Session>();

export function startSession(
  templateId: string,
  cast: Record<string, string>,
  goal: string,
  startedBy: string,
  room: ChatRoom
): Session | null {
  const tmpl = templates.get(templateId);
  if (!tmpl) return null;

  // Validate cast — all roles must be assigned
  for (const role of tmpl.roles) {
    if (!cast[role]) return null;
  }

  const session: Session = {
    id: nextSessionId++,
    templateId,
    templateName: tmpl.name,
    cast,
    goal,
    startedBy,
    startedAt: Date.now(),
    status: "active",
    currentPhase: 0,
    currentTurn: 0,
    waitingFor: null,
  };

  activeSessions.set(session.id, session);

  // Announce session start
  const castDesc = Object.entries(cast)
    .map(([role, name]) => `${role}: ${name}`)
    .join(", ");
  room.send("system", `Session started: ${tmpl.name}${goal ? " — " + goal : ""} [${castDesc}]`);

  // Start first phase
  advancePhase(session, tmpl, room);

  return session;
}

function advancePhase(session: Session, tmpl: SessionTemplate, room: ChatRoom): void {
  if (session.currentPhase >= tmpl.phases.length) {
    // All phases complete
    session.status = "complete";
    session.waitingFor = null;
    room.send("system", `Session complete: ${tmpl.name}`);
    activeSessions.delete(session.id);
    return;
  }

  const phase = tmpl.phases[session.currentPhase];
  session.currentTurn = 0;

  room.send("system", `Phase ${session.currentPhase + 1}/${tmpl.phases.length}: ${phase.name}`);

  triggerCurrentTurn(session, tmpl, room);
}

function triggerCurrentTurn(session: Session, tmpl: SessionTemplate, room: ChatRoom): void {
  const phase = tmpl.phases[session.currentPhase];
  if (session.currentTurn >= phase.participants.length) {
    // All turns in this phase done — advance to next phase
    session.currentPhase++;
    advancePhase(session, tmpl, room);
    return;
  }

  const role = phase.participants[session.currentTurn];
  const agentName = session.cast[role];
  if (!agentName) {
    // Skip missing cast member
    session.currentTurn++;
    triggerCurrentTurn(session, tmpl, room);
    return;
  }

  session.waitingFor = agentName;

  // Start turn timeout — auto-advance if the agent doesn't respond
  const timeoutSec = phase.timeout ?? 120;
  session.timeoutHandle = setTimeout(() => {
    if (session.status !== "active" || session.waitingFor !== agentName) return;
    room.send("system", `${agentName} timed out (${timeoutSec}s) in phase "${phase.name}"`);
    session.waitingFor = null;
    session.currentTurn++;
    triggerCurrentTurn(session, tmpl, room);
  }, timeoutSec * 1000);

  // Build the prompt for this agent
  let prompt = `[joind:session] Your turn in "${tmpl.name}" session.`;
  prompt += ` Phase: ${phase.name}. Your role: ${role}.`;
  if (session.goal) prompt += ` Goal: ${session.goal}.`;
  prompt += ` Instructions: ${phase.prompt}`;

  if (DISSENT_ROLES.has(role)) {
    prompt += ` ${DISSENT_LINE}`;
  }

  prompt += ` Read context: curl -s "http://127.0.0.1:4200/api/agent/read?sender=${agentName}&since=0&limit=30" — ` +
    `Respond: curl -s -X POST http://127.0.0.1:4200/api/agent/send -H "Content-Type: application/json" -d '{"sender":"${agentName}","text":"YOUR_RESPONSE"}'`;

  // Inject into the agent's terminal
  const agent = room.getAgent(agentName);
  if (agent?.active) {
    import("./inject.js").then((mod) => {
      console.log(`  → Session: triggering ${agentName} (role: ${role}, phase: ${phase.name})`);
      mod.inject(agent.pid, prompt).catch((err) => {
        console.error(`  ✗ Session injection failed for ${agentName}: ${err}`);
      });
    });
  } else {
    room.send("system", `Waiting for ${agentName} (${role}) — agent not online`);
  }
}

/**
 * Called when a chat message arrives. If we're waiting for this sender
 * in an active session, advance to the next turn.
 */
export function onMessage(sender: string, room: ChatRoom): void {
  for (const session of activeSessions.values()) {
    if (session.status !== "active") continue;
    if (session.waitingFor !== sender) continue;

    // This agent responded — clear timeout and advance
    const tmpl = templates.get(session.templateId);
    if (!tmpl) continue;

    if (session.timeoutHandle) {
      clearTimeout(session.timeoutHandle);
      session.timeoutHandle = undefined;
    }

    session.waitingFor = null;
    session.currentTurn++;

    // Small delay before triggering next turn (let the message render)
    setTimeout(() => {
      triggerCurrentTurn(session, tmpl, room);
    }, 2000);

    break; // One session per message
  }
}

export function getActiveSessions(): Session[] {
  return [...activeSessions.values()];
}

export function cancelSession(id: number, room: ChatRoom): boolean {
  const session = activeSessions.get(id);
  if (!session) return false;
  if (session.timeoutHandle) {
    clearTimeout(session.timeoutHandle);
    session.timeoutHandle = undefined;
  }
  session.status = "cancelled";
  session.waitingFor = null;
  activeSessions.delete(id);
  room.send("system", `Session cancelled: ${session.templateName}`);
  return true;
}
