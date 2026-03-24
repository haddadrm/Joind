/**
 * Joind MCP Tools — chat_join, chat_send, chat_read, chat_who, chat_leave.
 *
 * chat_join registers the agent (with PID) and returns immediately.
 * The TUI stays interactive. When @mentioned, the server's injection
 * daemon types a prompt into the agent's terminal via AttachConsole
 * (Windows) or tmux send-keys (Unix).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ChatRoom } from "./room.js";

export function registerTools(server: McpServer, room: ChatRoom): void {
  // -----------------------------------------------------------------
  // chat_join — Register and return (agent stays interactive)
  // -----------------------------------------------------------------
  server.registerTool(
    "chat_join",
    {
      title: "Join the Joind chat room",
      description:
        "Register with the Joind chat room. Returns immediately — your " +
        "terminal stays interactive. When someone @mentions you, a prompt " +
        "will appear in your terminal. Use chat_read and chat_send to " +
        "participate.",
      inputSchema: z.object({
        name: z.string().describe("Your display name in the chat"),
        pid: z
          .number()
          .describe(
            "Your terminal process ID (use the PID of your CLI process). " +
            "On most systems, check $PPID or the process tree."
          ),
      }),
    },
    async ({ name, pid }) => {
      const agent = room.join(name, pid);
      const online = room.who();

      console.log(`  ✓ ${name} joined (PID ${pid})`);

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Joined Joind chat as "${name}" (PID ${pid}).\n` +
              `Online: ${online.join(", ") || "just you"}\n\n` +
              `You will receive prompts in your terminal when @mentioned.\n` +
              `Use chat_send to send messages, chat_read to catch up, ` +
              `chat_leave to disconnect.`,
          },
        ],
      };
    }
  );

  // -----------------------------------------------------------------
  // chat_send — Post a message
  // -----------------------------------------------------------------
  server.registerTool(
    "chat_send",
    {
      title: "Send a chat message",
      description:
        "Send a message to the Joind chat room. Use @name to mention other agents.",
      inputSchema: z.object({
        sender: z.string().describe("Your name"),
        text: z.string().describe("Message text. Use @name to mention agents."),
      }),
    },
    async ({ sender, text }) => {
      const msg = room.send(sender, text);
      return {
        content: [{ type: "text" as const, text: `Message #${msg.id} sent` }],
      };
    }
  );

  // -----------------------------------------------------------------
  // chat_read — Read recent messages
  // -----------------------------------------------------------------
  server.registerTool(
    "chat_read",
    {
      title: "Read chat messages",
      description: "Read recent messages from the Joind chat room.",
      inputSchema: z.object({
        since: z
          .number()
          .optional()
          .describe("Message ID to read from (exclusive). Omit for latest."),
        limit: z
          .number()
          .optional()
          .describe("Max messages to return (default 50)"),
      }),
    },
    async ({ since, limit }) => {
      const msgs = room.read(since, limit);
      const formatted = msgs
        .map((m) => `[#${m.id} ${m.sender}] ${m.text}`)
        .join("\n");
      return {
        content: [{ type: "text" as const, text: formatted || "(no messages)" }],
      };
    }
  );

  // -----------------------------------------------------------------
  // chat_who — See who's online
  // -----------------------------------------------------------------
  server.registerTool(
    "chat_who",
    {
      title: "See who is in the chat",
      description: "List all agents currently connected to the Joind chat room.",
      inputSchema: z.object({}),
    },
    async () => {
      const names = room.whoNames();
      return {
        content: [
          {
            type: "text" as const,
            text: names.length ? names.join(", ") : "(nobody online)",
          },
        ],
      };
    }
  );

  // -----------------------------------------------------------------
  // chat_leave — Disconnect
  // -----------------------------------------------------------------
  server.registerTool(
    "chat_leave",
    {
      title: "Leave the chat",
      description: "Disconnect from the Joind chat room.",
      inputSchema: z.object({
        name: z.string().describe("Your name"),
      }),
    },
    async ({ name }) => {
      room.leave(name);
      return {
        content: [{ type: "text" as const, text: `${name} disconnected` }],
      };
    }
  );

  // -----------------------------------------------------------------
  // /join prompt — Surfaces as a slash command in Claude Code
  // -----------------------------------------------------------------
  server.registerPrompt(
    "join",
    {
      title: "Join Joind chat room",
      description: "Connect to the shared agent chat room",
      argsSchema: {
        name: z.string().describe("Your display name"),
      },
    },
    ({ name }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              `Join the Joind chat room as "${name}". First, determine your ` +
              `terminal's process ID by running: echo $PPID (bash) or ` +
              `(Get-Process -Id $PID).Id (PowerShell). Then call chat_join ` +
              `with name="${name}" and the PID you found.`,
          },
        },
      ],
    })
  );
}
