/**
 * Joind MCP Tools — conversation-scoped chat tools.
 *
 * Agents join a specific conversation. All subsequent tool calls
 * route to that conversation. Different conversations are isolated.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConversationManager } from "./manager.js";
import type { TaskStore } from "./tasks.js";
import { checkWezTerm, discoverWezTerm, getWeztermPath, getWeztermEnv } from "./terminals.js";

const execFileAsync = promisify(execFile);

/**
 * Auto-detect WezTerm pane ID for a newly joining agent.
 * Finds unclaimed panes (not already assigned to another agent) and returns the best match.
 */
async function autoDetectWezTermPane(manager: ConversationManager): Promise<number | undefined> {
  try {
    const panes = await discoverWezTerm();
    console.log(`  [wezterm] Found ${panes.length} panes: ${panes.map(p => `${p.weztermPaneId}:${p.type}:${p.name}`).join(", ")}`);
    // Collect all pane IDs already claimed by agents in any conversation
    const claimedPanes = new Set<number>();
    for (const conv of manager.listConversations()) {
      const room = manager.getRoom(conv.id);
      if (room) {
        for (const a of room.who()) {
          if (a.weztermPaneId != null) claimedPanes.add(a.weztermPaneId);
        }
      }
    }
    console.log(`  [wezterm] Claimed panes: ${[...claimedPanes].join(", ") || "none"}`);
    // Find unclaimed agent-type panes (claude, codex, gemini)
    const unclaimed = panes.filter(
      (p) => p.weztermPaneId != null && !claimedPanes.has(p.weztermPaneId!) && p.type !== "unknown"
    );
    if (unclaimed.length === 1) {
      console.log(`  [wezterm] Auto-detected pane ${unclaimed[0].weztermPaneId} (${unclaimed[0].name})`);
      return unclaimed[0].weztermPaneId!;
    }
    if (unclaimed.length === 0) {
      console.log(`  [wezterm] No unclaimed agent panes found`);
    } else {
      console.log(`  [wezterm] ${unclaimed.length} unclaimed agent panes — cannot auto-detect: ${unclaimed.map(p => `${p.weztermPaneId}:${p.name}`).join(", ")}`);
    }
  } catch (err) {
    console.log(`  [wezterm] Auto-detect error: ${(err as Error).message?.slice(0, 100)}`);
  }
  return undefined;
}

// Session bindings are a FALLBACK — agent name bindings are primary.
// This means MCP reconnects don't break routing as long as the agent
// previously joined via chat_join (which sets the name binding).
const sessionBindings = new Map<string | undefined, string>(); // sessionId → conversationId

function getRoom(manager: ConversationManager, extra: { sessionId?: string }, senderHint?: string) {
  // 1. Agent name binding (survives MCP reconnects)
  if (senderHint) {
    const agentConvId = manager.getAgentConversationId(senderHint);
    if (agentConvId) {
      const room = manager.getRoom(agentConvId);
      if (room) return { room, convId: agentConvId };
    }
  }
  // 2. MCP session binding (set on chat_join, lost on reconnect)
  const convId = sessionBindings.get(extra.sessionId);
  if (convId) {
    const room = manager.getRoom(convId);
    if (room) return { room, convId };
  }
  // No fallback — agent must chat_join first to avoid cross-conversation pollution
  return null;
}

export function registerTools(server: McpServer, manager: ConversationManager, taskStore?: TaskStore): void {

  server.registerTool(
    "chat_join",
    {
      title: "Join a Joind conversation",
      description:
        "Join a conversation in the Joind chat. Returns immediately — " +
        "your terminal stays interactive. When someone @mentions you, " +
        "a prompt will appear in your terminal.",
      inputSchema: z.object({
        name: z.string().describe("Your display name in the chat"),
        pid: z.number().describe("Your terminal process ID"),
        conversation: z.string().optional().describe(
          "Conversation ID to join. Omit to join the active conversation."
        ),
        weztermPaneId: z.number().optional().describe(
          "WezTerm pane ID (from $WEZTERM_PANE env var). Enables reliable @mention injection."
        ),
      }),
    },
    async ({ name, pid, conversation, weztermPaneId }, extra) => {
      // Determine which conversation to join
      let convId = conversation || manager.getActiveId();
      if (!convId) {
        // No active conversation — create one and make it active for web UI
        const meta = manager.createConversation();
        convId = meta.id;
        manager.setActive(convId);
      }

      const room = manager.getRoom(convId);
      if (!room) {
        return { content: [{ type: "text" as const, text: "Conversation not found: " + convId }] };
      }

      // Auto-detect WezTerm pane if not provided
      let resolvedPaneId = weztermPaneId;
      if (resolvedPaneId == null && await checkWezTerm()) {
        resolvedPaneId = await autoDetectWezTermPane(manager);
      }

      const agent = room.join(name, pid, resolvedPaneId);
      manager.bindAgent(name, convId);
      sessionBindings.set(extra.sessionId, convId);
      room.touch(name);

      // Name the WezTerm tab to just the agent name
      if (agent.weztermPaneId != null) {
        const wtEnv = Object.keys(getWeztermEnv()).length > 0 ? { ...process.env, ...getWeztermEnv() } : undefined;
        execFileAsync(getWeztermPath(), ["cli", "set-tab-title", name, "--pane-id", String(agent.weztermPaneId)], { env: wtEnv })
          .catch(() => {});
      }

      const meta = manager.getMeta(convId);
      const online = room.whoNames();

      // Include last 15 messages so the agent has immediate context
      const recent = room.read(undefined, 15);
      const recentText = recent.length > 0
        ? "\n\nRecent messages:\n" + recent.map((m) => `[#${m.id} ${m.sender}] ${m.text}`).join("\n")
        : "";
      const totalCount = room.messageCount();
      const historyHint = totalCount > 15
        ? `\n\n(Showing last 15 of ${totalCount} messages. Use chat_read with since= for more history.)`
        : "";

      return {
        content: [{
          type: "text" as const,
          text:
            `Joined conversation "${meta?.name ?? convId}".\n` +
            `Online: ${online.join(", ") || "just you"}` +
            recentText + historyHint,
        }],
      };
    }
  );

  server.registerTool(
    "chat_send",
    {
      title: "Send a chat message",
      description: "Send a message in your current conversation. Use @name to mention agents.",
      inputSchema: z.object({
        sender: z.string().describe("Your name"),
        text: z.string().describe("Message text. Use @name to mention agents."),
        replyTo: z.number().optional().describe("Message ID to reply to"),
      }),
    },
    async ({ sender, text, replyTo }, extra) => {
      const target = getRoom(manager, extra, sender);
      if (!target) {
        return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
      }
      target.room.touch(sender);
      target.room.setTyping(sender, false);

      // Auto-name conversation from first non-system message
      manager.autoName(target.convId, text);

      const msg = target.room.send(sender, text, { replyTo });
      return { content: [{ type: "text" as const, text: `Message #${msg.id} sent` }] };
    }
  );

  server.registerTool(
    "chat_read",
    {
      title: "Read chat messages",
      description: "Read recent messages from your current conversation.",
      inputSchema: z.object({
        sender: z.string().optional().describe("Your name (for routing to your conversation)"),
        since: z.number().optional().describe("Message ID to read from (exclusive). Omit for latest."),
        limit: z.number().optional().describe("Max messages to return (default 50)"),
      }),
    },
    async ({ sender, since, limit }, extra) => {
      const target = getRoom(manager, extra, sender);
      if (!target) {
        return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
      }
      const msgs = target.room.read(since, limit);
      const formatted = msgs
        .map((m) => {
          const reply = m.replyTo ? ` [reply to #${m.replyTo}]` : "";
          return `[#${m.id} ${m.sender}${reply}] ${m.text}`;
        })
        .join("\n");
      return { content: [{ type: "text" as const, text: formatted || "(no messages)" }] };
    }
  );

  server.registerTool(
    "chat_who",
    {
      title: "See who is in the conversation",
      description: "List agents in your current conversation.",
      inputSchema: z.object({
        sender: z.string().optional().describe("Your name (for routing to your conversation)"),
      }),
    },
    async ({ sender }, extra) => {
      const target = getRoom(manager, extra, sender);
      if (!target) {
        return { content: [{ type: "text" as const, text: "Not in a conversation." }] };
      }
      const names = target.room.whoNames();
      const meta = manager.getMeta(target.convId);
      return {
        content: [{
          type: "text" as const,
          text: `Conversation: ${meta?.name ?? target.convId}\nOnline: ${names.length ? names.join(", ") : "(nobody)"}`,
        }],
      };
    }
  );

  server.registerTool(
    "chat_leave",
    {
      title: "Leave the conversation",
      description: "Disconnect from the Joind conversation.",
      inputSchema: z.object({
        name: z.string().describe("Your name"),
      }),
    },
    async ({ name }, extra) => {
      const target = getRoom(manager, extra, name);
      if (target) {
        target.room.leave(name);
      }
      manager.unbindAgent(name);
      sessionBindings.delete(extra.sessionId);
      return { content: [{ type: "text" as const, text: `${name} disconnected` }] };
    }
  );

  server.registerTool(
    "chat_typing",
    {
      title: "Signal typing status",
      description: "Signal that you are typing (or stopped) in the conversation.",
      inputSchema: z.object({
        name: z.string().describe("Your name"),
        typing: z.boolean().describe("true if typing, false if stopped"),
      }),
    },
    async ({ name, typing }, extra) => {
      const target = getRoom(manager, extra, name);
      if (target) {
        target.room.setTyping(name, typing);
      }
      return { content: [{ type: "text" as const, text: `${name} is ${typing ? "now shown as typing" : "no longer typing"}` }] };
    }
  );

  // --- Task tools ---

  if (taskStore) {
    server.registerTool(
      "chat_task",
      {
        title: "Create a task / request input",
        description:
          "Request input, a decision, or action from someone. Creates a visible task " +
          "that won't get lost in chat flow. Use for decisions, approvals, and questions.",
        inputSchema: z.object({
          sender: z.string().describe("Your name"),
          title: z.string().describe("Short title: what you need"),
          description: z.string().optional().describe("Details or context"),
          assignee: z.string().optional().describe("Who should respond (omit for anyone)"),
          priority: z.enum(["normal", "urgent"]).optional().describe("Urgency level"),
        }),
      },
      async ({ sender, title, description, assignee, priority }, extra) => {
        const target = getRoom(manager, extra, sender);
        if (!target) {
          return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
        }
        const task = taskStore.create(target.convId, {
          title, description, creator: sender, assignee, priority,
        });
        // Post system message so other agents see it via chat_read
        const assignText = task.assignee ? ` for ${task.assignee}` : "";
        const urgentText = task.priority === "urgent" ? " (urgent)" : "";
        target.room.send("system",
          `[Task #${task.id}${assignText}] ${sender} needs: ${task.title}${urgentText}`
        );
        return {
          content: [{
            type: "text" as const,
            text: `Task #${task.id} created${assignText}${urgentText}: ${task.title}`,
          }],
        };
      }
    );

    server.registerTool(
      "chat_tasks",
      {
        title: "Check tasks and responses",
        description:
          "List tasks in the conversation, or resolve a specific task. " +
          "Provide id + response to mark a task as done with your answer.",
        inputSchema: z.object({
          sender: z.string().optional().describe("Your name (for routing)"),
          status: z.enum(["open", "done", "all"]).optional().describe("Filter (default: open)"),
          id: z.number().optional().describe("Get or resolve a specific task"),
          response: z.string().optional().describe("Response text — resolves the task as done"),
        }),
      },
      async ({ sender, status, id, response }, extra) => {
        const target = getRoom(manager, extra, sender);
        if (!target) {
          return { content: [{ type: "text" as const, text: "Not in a conversation. Call chat_join first." }] };
        }

        // Resolve a task
        if (id != null && response != null) {
          const task = taskStore.update(target.convId, id, {
            status: "done", response, respondedBy: sender ?? "agent",
          });
          if (!task) {
            return { content: [{ type: "text" as const, text: `Task #${id} not found` }] };
          }
          target.room.send("system",
            `[Task #${task.id} done] ${task.respondedBy} responded: ${response.slice(0, 200)}`
          );
          return { content: [{ type: "text" as const, text: `Task #${id} resolved` }] };
        }

        // Get single task
        if (id != null) {
          const task = taskStore.get(target.convId, id);
          if (!task) {
            return { content: [{ type: "text" as const, text: `Task #${id} not found` }] };
          }
          const lines = [
            `[Task #${task.id} ${task.status.toUpperCase()}${task.priority === "urgent" ? " URGENT" : ""}] ${task.title}`,
          ];
          if (task.description) lines.push(`  ${task.description}`);
          lines.push(`  Created by: ${task.creator}${task.assignee ? ` | Assigned to: ${task.assignee}` : ""}`);
          if (task.response) lines.push(`  Response (${task.respondedBy}): ${task.response}`);
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        }

        // List tasks
        const tasks = taskStore.list(target.convId, { status: status ?? "open" });
        if (tasks.length === 0) {
          return { content: [{ type: "text" as const, text: `No ${status ?? "open"} tasks` }] };
        }
        const formatted = tasks.map((t) => {
          const urgent = t.priority === "urgent" ? " URGENT" : "";
          const assign = t.assignee ? ` → ${t.assignee}` : "";
          const resp = t.response ? ` | Response: ${t.response.slice(0, 100)}` : "";
          return `[#${t.id} ${t.status.toUpperCase()}${urgent}] ${t.title}${assign}${resp}`;
        }).join("\n");
        return { content: [{ type: "text" as const, text: formatted }] };
      }
    );
  }

  server.registerPrompt(
    "join",
    {
      title: "Join Joind conversation",
      description: "Connect to a Joind conversation",
      argsSchema: {
        name: z.string().describe("Your display name"),
      },
    },
    ({ name }) => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text:
            `Join the Joind chat as "${name}". ` +
            `First find your terminal PID by running echo $PPID. ` +
            `Also check for WezTerm: echo $WEZTERM_PANE — if set, pass it as weztermPaneId. ` +
            `Then call chat_join with name="${name}", your PID, and weztermPaneId if available.`,
        },
      }],
    })
  );
}
