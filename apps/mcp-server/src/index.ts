import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getEnv } from "@u/core";
import { ensureVectorExtension, ensureVectorIndex, prisma } from "@u/db";
import { contextBundle, createManualNote, graphNeighbors, semanticSearch, upsertCardFromUrl } from "./lib.js";

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

const ingestSchema = z.object({
  userId: z.string().default(env.U_DEFAULT_USER_ID),
  url: z.string().url(),
  sourceType: z.string().default("article")
});

const noteSchema = z.object({
  userId: z.string().default(env.U_DEFAULT_USER_ID),
  title: z.string().min(3),
  content: z.string().min(20)
});

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

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().optional()
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "u_create_user",
        description: "Create or fetch a U user identity.",
        inputSchema: {
          type: "object",
          properties: {
            email: { type: "string", format: "email" },
            name: { type: "string" }
          },
          required: ["email"]
        }
      },
      {
        name: "u_ingest_url",
        description: "Ingest a URL, summarize it, embed it, and store as a card.",
        inputSchema: {
          type: "object",
          properties: {
            userId: { type: "string" },
            url: { type: "string", format: "uri" },
            sourceType: { type: "string" }
          },
          required: ["url"]
        }
      },
      {
        name: "u_create_note",
        description: "Create a note card from raw text and add it to the U knowledge graph.",
        inputSchema: {
          type: "object",
          properties: {
            userId: { type: "string" },
            title: { type: "string" },
            content: { type: "string" }
          },
          required: ["title", "content"]
        }
      },
      {
        name: "u_search_cards",
        description: "Semantic search across U cards for a user.",
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
        description: "Return graph edges around a card with configurable depth.",
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
        description: "Get semantically relevant cards and graph edges for a query.",
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

  if (tool === "u_create_user") {
    const input = createUserSchema.parse(args);
    const user = await prisma.user.upsert({
      where: { email: input.email },
      create: {
        email: input.email,
        name: input.name
      },
      update: {
        name: input.name ?? undefined
      }
    });

    return {
      content: [{ type: "text", text: JSON.stringify({ userId: user.id, email: user.email, name: user.name }, null, 2) }]
    };
  }

  if (tool === "u_ingest_url") {
    const input = ingestSchema.parse(args);
    const result = await upsertCardFromUrl(input.userId, input.url, input.sourceType);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  if (tool === "u_create_note") {
    const input = noteSchema.parse(args);
    const result = await createManualNote(input.userId, input.title, input.content);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

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
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("U MCP server failed:", err);
  process.exit(1);
});
