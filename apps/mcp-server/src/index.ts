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
import { getEnv, sha256Hex } from "@u/core";
import { ensureVectorExtension, ensureVectorIndex, prisma } from "@u/db";
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

type SessionContext = {
  authUserId?: string;
  isAdmin: boolean;
};

function getAdminKey(): string {
  return env.U_MCP_ADMIN_KEY ?? env.U_COLLECTOR_API_KEY;
}

async function authenticateMcpRequest(req: express.Request, res: express.Response): Promise<SessionContext | null> {
  const adminKey = req.header("x-u-api-key");
  if (adminKey && adminKey === getAdminKey()) {
    return { isAdmin: true };
  }

  const deviceKey = req.header("x-u-device-key");
  if (!deviceKey) {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized MCP request" }, id: null });
    return null;
  }

  const keyHash = sha256Hex(deviceKey);
  const key = await prisma.apiKey.findUnique({ where: { keyHash } });
  if (!key || !key.isActive) {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Invalid MCP device key" }, id: null });
    return null;
  }

  await prisma.apiKey.update({
    where: { id: key.id },
    data: { lastUsedAt: new Date() }
  });

  return { authUserId: key.userId, isAdmin: false };
}

function getToolCallInfo(body: unknown): { toolName: string; args: Record<string, unknown> } | null {
  if (!body || typeof body !== "object") {
    return null;
  }

  const request = body as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  if (request.method !== "tools/call") {
    return null;
  }

  if (!request.params?.name) {
    return null;
  }

  return {
    toolName: request.params.name,
    args: request.params.arguments ?? {}
  };
}

function injectBoundUserIfNeeded(body: unknown, auth: SessionContext): string | undefined {
  const info = getToolCallInfo(body);
  if (!info) {
    return undefined;
  }

  if (!auth.authUserId) {
    return typeof info.args.userId === "string" ? info.args.userId : undefined;
  }

  info.args.userId = auth.authUserId;
  const request = body as { params?: { arguments?: Record<string, unknown> } };
  if (!request.params) {
    request.params = {};
  }
  request.params.arguments = info.args;

  return auth.authUserId;
}

async function writeMcpAuditLog(params: {
  toolName: string;
  userId?: string;
  sessionId?: string;
  success: boolean;
  durationMs: number;
  errorMessage?: string;
}) {
  await prisma.mcpAuditLog.create({
    data: {
      toolName: params.toolName,
      userId: params.userId,
      sessionId: params.sessionId,
      success: params.success,
      durationMs: params.durationMs,
      errorMessage: params.errorMessage
    }
  });
}

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
  const sessionContexts: Record<string, SessionContext> = {};

  app.post("/mcp", async (req, res) => {
    const auth = await authenticateMcpRequest(req, res);
    if (!auth) {
      return;
    }

    const sessionId = req.header("mcp-session-id");
    const toolCall = getToolCallInfo(req.body);
    const startedAt = Date.now();
    const boundUserId = injectBoundUserIfNeeded(req.body, auth);

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        const existingContext = sessionContexts[sessionId];
        if (!existingContext) {
          res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Session context not found" }, id: null });
          return;
        }

        if (existingContext.isAdmin !== auth.isAdmin || existingContext.authUserId !== auth.authUserId) {
          res.status(403).json({ jsonrpc: "2.0", error: { code: -32003, message: "Session auth mismatch" }, id: null });
          return;
        }

        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports[id] = transport;
            sessionContexts[id] = auth;
          }
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            delete transports[transport.sessionId];
            delete sessionContexts[transport.sessionId];
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

      if (toolCall) {
        await writeMcpAuditLog({
          toolName: toolCall.toolName,
          userId: boundUserId,
          sessionId: sessionId ?? undefined,
          success: true,
          durationMs: Date.now() - startedAt
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal error";
      if (toolCall) {
        await writeMcpAuditLog({
          toolName: toolCall.toolName,
          userId: boundUserId,
          sessionId: sessionId ?? undefined,
          success: false,
          durationMs: Date.now() - startedAt,
          errorMessage: message
        });
      }

      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message }, id: null });
      }
    }
  });

  app.get("/mcp", async (req, res) => {
    const auth = await authenticateMcpRequest(req, res);
    if (!auth) {
      return;
    }

    const sessionId = req.header("mcp-session-id");
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    const existingContext = sessionContexts[sessionId];
    if (!existingContext || existingContext.isAdmin !== auth.isAdmin || existingContext.authUserId !== auth.authUserId) {
      res.status(403).send("Session auth mismatch");
      return;
    }

    await transports[sessionId].handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const auth = await authenticateMcpRequest(req, res);
    if (!auth) {
      return;
    }

    const sessionId = req.header("mcp-session-id");
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    const existingContext = sessionContexts[sessionId];
    if (!existingContext || existingContext.isAdmin !== auth.isAdmin || existingContext.authUserId !== auth.authUserId) {
      res.status(403).send("Session auth mismatch");
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
