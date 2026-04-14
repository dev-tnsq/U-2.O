import OpenAI from "openai";
import { getEnv } from "@u/core";
import { prisma } from "@u/db";

const env = getEnv();
const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

async function createEmbedding(query: string): Promise<number[]> {
  const result = await openai.embeddings.create({
    model: env.OPENAI_EMBEDDING_MODEL,
    input: query.slice(0, 20000)
  });

  return result.data[0]?.embedding ?? [];
}

function vectorSqlLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

export async function semanticSearch(userId: string, query: string, limit: number = 8) {
  const embedding = await createEmbedding(query);
  const literal = vectorSqlLiteral(embedding);

  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; title: string; summary: string; tags: string[]; sourceType: string; score: number }>>(
    `SELECT id, title, summary, tags, "sourceType", 1 - (embeddings <=> $1::vector) AS score
     FROM "Card"
     WHERE "userId" = $2
     ORDER BY embeddings <=> $1::vector
     LIMIT $3`,
    literal,
    userId,
    limit
  );

  return rows;
}

export async function graphNeighbors(cardId: string, depth: number = 1) {
  const safeDepth = Math.min(Math.max(depth, 1), 3);
  const seen = new Set<string>([cardId]);
  let frontier = [cardId];
  const edges: Array<{ fromId: string; toId: string; reason: string; weight: number }> = [];

  for (let i = 0; i < safeDepth; i += 1) {
    if (frontier.length === 0) {
      break;
    }

    const layer = await prisma.connection.findMany({
      where: {
        OR: [{ fromId: { in: frontier } }, { toId: { in: frontier } }]
      }
    });

    const next: string[] = [];
    for (const edge of layer) {
      edges.push({ fromId: edge.fromId, toId: edge.toId, reason: edge.reason, weight: edge.weight });

      if (!seen.has(edge.fromId)) {
        seen.add(edge.fromId);
        next.push(edge.fromId);
      }
      if (!seen.has(edge.toId)) {
        seen.add(edge.toId);
        next.push(edge.toId);
      }
    }

    frontier = next;
  }

  return edges;
}

export async function contextBundle(userId: string, query: string, maxCards: number = 8, maxHops: number = 2) {
  const cards = await semanticSearch(userId, query, maxCards);
  const edgeSets = await Promise.all(cards.map((card) => graphNeighbors(card.id, maxHops)));

  return {
    query,
    cards,
    graph: edgeSets.flat()
  };
}
