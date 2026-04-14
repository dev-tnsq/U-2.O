import { JSDOM } from "jsdom";
import OpenAI from "openai";
import { z } from "zod";
import { getEnv } from "@u/core";
import { prisma } from "@u/db";

const env = getEnv();
const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const summarySchema = z.object({
  concise_summary: z.string(),
  detailed_summary: z.string(),
  key_points: z.array(z.object({ timestamp: z.string().optional(), text: z.string() })),
  tags: z.array(z.string())
});

export async function fetchArticleContent(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.status}`);
  }

  const html = await response.text();
  const dom = new JSDOM(html);
  const text = dom.window.document.body?.textContent?.replace(/\s+/g, " ").trim();
  if (!text || text.length < 50) {
    throw new Error("Fetched content is too short to process");
  }
  return text.slice(0, 120000);
}

export async function summarizeContent(raw: string) {
  const prompt = `You are U summarizer. Given raw content, output strict JSON with keys: concise_summary, detailed_summary, key_points, tags. key_points is array of objects with optional timestamp and text. tags must be 5-8 lowercase tags.`;

  const response = await openai.responses.create({
    model: env.OPENAI_SUMMARY_MODEL,
    input: [
      { role: "system", content: prompt },
      { role: "user", content: raw.slice(0, 30000) }
    ]
  });

  const text = response.output_text;
  const parsed = JSON.parse(text);
  return summarySchema.parse(parsed);
}

export async function createEmbedding(content: string): Promise<number[]> {
  const result = await openai.embeddings.create({
    model: env.OPENAI_EMBEDDING_MODEL,
    input: content.slice(0, 20000)
  });
  return result.data[0]?.embedding ?? [];
}

function vectorSqlLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

export async function upsertCardFromUrl(userId: string, url: string, sourceType: string = "article") {
  const raw = await fetchArticleContent(url);
  const summary = await summarizeContent(raw);
  const embedding = await createEmbedding(`${summary.concise_summary}\n${summary.detailed_summary}`);

  const card = await prisma.card.create({
    data: {
      userId,
      title: new URL(url).hostname,
      sourceType,
      originalUrl: url,
      originalContent: raw,
      summary: summary.concise_summary,
      keyPoints: summary.key_points,
      tags: summary.tags,
      notebook: { type: "doc", content: [] }
    }
  });

  await prisma.$executeRawUnsafe(
    `UPDATE "Card" SET "embeddings" = $1::vector WHERE "id" = $2`,
    vectorSqlLiteral(embedding),
    card.id
  );

  return {
    cardId: card.id,
    title: card.title,
    summary: card.summary,
    tags: card.tags
  };
}

export async function createManualNote(userId: string, title: string, content: string) {
  const summary = await summarizeContent(content);
  const embedding = await createEmbedding(`${title}\n${content}`);

  const card = await prisma.card.create({
    data: {
      userId,
      title,
      sourceType: "note",
      originalContent: content,
      summary: summary.concise_summary,
      keyPoints: summary.key_points,
      tags: summary.tags,
      notebook: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: content }] }] }
    }
  });

  await prisma.$executeRawUnsafe(
    `UPDATE "Card" SET "embeddings" = $1::vector WHERE "id" = $2`,
    vectorSqlLiteral(embedding),
    card.id
  );

  return {
    cardId: card.id,
    title: card.title,
    summary: card.summary,
    tags: card.tags
  };
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
        OR: [
          { fromId: { in: frontier } },
          { toId: { in: frontier } }
        ]
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
  const graph = edgeSets.flat();

  return {
    query,
    cards,
    graph
  };
}
