import { randomUUID } from "node:crypto";
import express from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getEnv } from "@u/core";
import { ensureVectorExtension, ensureVectorIndex } from "@u/db";
import { contextBundle, graphNeighbors, semanticSearch } from "./lib.js";

const env = getEnv();

const server = new Server(
  {
    name: "u-mcp-server",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

const searchSchema = z.object({
  userId: z.string().default(env.U_DEFAULT_USER_ID),
  query: z.string().min(2),
  limit: z.number().int().min(1).max(20).default(8)
});

const neighborSchema = z.object({
  cardId: z.string(),
  depth: z.number().int().min(1).max(3).default(2)
});

const contextSchema = z.object({
  userId: z.string().default(env.U_DEFAULT_USER_ID),
  query: z.string().min(2),
  maxCards: z.number().int().min(1).max(20).default(8),
  maxHops: z.number().int().min(1).max(3).default(2)
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "u_search_cards",
        description: "Semantic search over a user's memory cards in U.",
        inputSchema: {
          type: "object",
          properties: {
            userId: { type: "string" },
            query: { type: "string" },
            limit: { type: "number" }
          },
          required: ["query"]
        }
      },
      {
        name: "u_graph_neighbors",
        description: "Fetch graph edges around a card with configurable hop depth.",
        inputSchema: {
          type: "object",
          properties: {
            cardId: { type: "string" },
            depth: { type: "number" }
          },
          required: ["cardId"]
        }
      },
      {
        name: "u_get_context_bundle",
        description: "Get semantically relevant cards plus graph context for a query.",
        inputSchema: {
          type: "object",
          properties: {
            userId: { type: "string" },
            query: { type: "string" },
            maxCards: { type: "number" },
            maxHops: { type: "number" }
          },
          required: ["query"]
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  const tool = request.params.name;
  const args = request.params.arguments ?? {};

  if (tool === "u_search_cards") {
    const input = searchSchema.parse(args);
    const rows = await semanticSearch(input.userId, input.query, input.limit);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }

  if (tool === "u_graph_neighbors") {
    const input = neighborSchema.parse(args);
    const edges = await graphNeighbors(input.cardId, input.depth);
    return { content: [{ type: "text", text: JSON.stringify(edges, null, 2) }] };
  }

  if (tool === "u_get_context_bundle") {
    const input = contextSchema.parse(args);
    const bundle = await contextBundle(input.userId, input.query, input.maxCards, input.maxHops);
    return { content: [{ type: "text", text: JSON.stringify(bundle, null, 2) }] };
  }

  throw new Error(`Unknown tool: ${tool}`);
});

async function main() {
  await ensureVectorExtension();
  await ensureVectorIndex();

  const app = createMcpExpressApp();
  app.use(express.json({ limit: "2mb" }));

  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id");

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports[id] = transport;
          }
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId];
          }
        };

        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal error";
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message }, id: null });
      }
    }
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    await transports[sessionId].handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    await transports[sessionId].handleRequest(req, res);
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "mcp-server" });
  });

  app.listen(env.U_MCP_PORT, () => {
    console.log(`U MCP server listening on ${env.U_MCP_PORT}`);
  });
}

main().catch((err) => {
  console.error("U MCP server failed:", err);
  process.exit(1);
});
