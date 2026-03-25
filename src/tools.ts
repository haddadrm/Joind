/**
 * Joind MCP Tools — conversation-scoped chat tools.
 *
 * Agents join a specific conversation. All subsequent tool calls
 * route to that conversation. Different conversations are isolated.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConversationManager } from "./manager.js";

// Track which MCP session is bound to which conversation
const sessionBindings = new Map<string | undefined, string>(); // sessionId → conversationId

function getRoom(manager: ConversationManager, extra: { sessionId?: string }, senderHint?: string) {
  // Try session binding first
  const convId = sessionBindings.get(extra.sessionId);
  if (convId) {
    const room = manager.getRoom(convId);
    if (room) return { room, convId };
  }
  // Try agent binding
  if (senderHint) {
    const agentConvId = manager.getAgentConversationId(senderHint);
    if (agentConvId) {
      const room = manager.getRoom(agentConvId);
      if (room) return { room, convId: agentConvId };
    }
  }
  // Fallback to active conversation
  const activeId = manager.getActiveId();
  if (activeId) {
    const room = manager.getRoom(activeId);
    if (room) return { room, convId: activeId };
  }
  return null;
}

export function registerTools(server: McpServer, manager: ConversationManager): void {

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
      }),
    },
    async ({ name, pid, conversation }, extra) => {
      // Determine which conversation to join
      let convId = conversation || manager.getActiveId();
      if (!convId) {
        // No active conversation — create one
        const meta = manager.createConversation();
        convId = meta.id;
      }

      const room = manager.getRoom(convId);
      if (!room) {
        return { content: [{ type: "text" as const, text: "Conversation not found: " + convId }] };
      }

      const agent = room.join(name, pid);
      manager.bindAgent(name, convId);
      sessionBindings.set(extra.sessionId, convId);
      room.touch(name);

      const meta = manager.getMeta(convId);
      const online = room.whoNames();

      return {
        content: [{
          type: "text" as const,
          text:
            `Joined conversation "${meta?.name ?? convId}".\n` +
            `Online in this conversation: ${online.join(", ") || "just you"}\n\n` +
            `Use chat_send to send messages, chat_read to catch up, chat_leave to disconnect.`,
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
        since: z.number().optional().describe("Message ID to read from (exclusive). Omit for latest."),
        limit: z.number().optional().describe("Max messages to return (default 50)"),
      }),
    },
    async ({ since, limit }, extra) => {
      const target = getRoom(manager, extra);
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
      inputSchema: z.object({}),
    },
    async (_args, extra) => {
      const target = getRoom(manager, extra);
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
            `Join the Joind chat as "${name}". First find your terminal PID ` +
            `by running echo $PPID. Then call chat_join with name="${name}" and your PID.`,
        },
      }],
    })
  );
}
