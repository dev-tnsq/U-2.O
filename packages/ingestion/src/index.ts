import { JSDOM } from "jsdom";
import OpenAI from "openai";
import { z } from "zod";
import { getEnv } from "@u/core";
import { prisma } from "@u/db";
import { IngestionJobStatus, IngestionJobType } from "@prisma/client";

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

async function summarizeContent(raw: string) {
  const prompt = "You are U summarizer. Given raw content, output strict JSON with keys: concise_summary, detailed_summary, key_points, tags. key_points is array of objects with optional timestamp and text. tags must be 5-8 lowercase tags.";

  const response = await openai.responses.create({
    model: env.OPENAI_SUMMARY_MODEL,
    input: [
      { role: "system", content: prompt },
      { role: "user", content: raw.slice(0, 30000) }
    ]
  });

  const parsed = JSON.parse(response.output_text);
  return summarySchema.parse(parsed);
}

async function createEmbedding(content: string): Promise<number[]> {
  const result = await openai.embeddings.create({
    model: env.OPENAI_EMBEDDING_MODEL,
    input: content.slice(0, 20000)
  });

  return result.data[0]?.embedding ?? [];
}

function vectorSqlLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

export async function ingestUrlForUser(userId: string, url: string, sourceType: string = "article") {
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
    'UPDATE "Card" SET "embeddings" = $1::vector WHERE "id" = $2',
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

export async function ingestNoteForUser(userId: string, title: string, content: string) {
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
    'UPDATE "Card" SET "embeddings" = $1::vector WHERE "id" = $2',
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

const enqueueUrlSchema = z.object({
  userId: z.string(),
  url: z.string().url(),
  sourceType: z.string().default("article")
});

const enqueueNoteSchema = z.object({
  userId: z.string(),
  title: z.string().min(3),
  content: z.string().min(20)
});

const notePayloadSchema = z.object({
  title: z.string(),
  content: z.string()
});

const urlPayloadSchema = z.object({
  url: z.string().url(),
  sourceType: z.string()
});

export async function enqueueUrlIngestion(input: z.infer<typeof enqueueUrlSchema>) {
  const valid = enqueueUrlSchema.parse(input);
  const job = await prisma.ingestionJob.create({
    data: {
      userId: valid.userId,
      type: IngestionJobType.URL,
      payload: {
        url: valid.url,
        sourceType: valid.sourceType
      }
    }
  });

  return job;
}

export async function enqueueNoteIngestion(input: z.infer<typeof enqueueNoteSchema>) {
  const valid = enqueueNoteSchema.parse(input);
  const job = await prisma.ingestionJob.create({
    data: {
      userId: valid.userId,
      type: IngestionJobType.NOTE,
      payload: {
        title: valid.title,
        content: valid.content
      }
    }
  });

  return job;
}

export async function claimPendingJob() {
  return prisma.$transaction(async (tx) => {
    const candidate = await tx.ingestionJob.findFirst({
      where: { status: IngestionJobStatus.PENDING },
      orderBy: { createdAt: "asc" }
    });

    if (!candidate) {
      return null;
    }

    const updated = await tx.ingestionJob.updateMany({
      where: { id: candidate.id, status: IngestionJobStatus.PENDING },
      data: {
        status: IngestionJobStatus.PROCESSING,
        startedAt: new Date(),
        attempts: { increment: 1 }
      }
    });

    if (updated.count === 0) {
      return null;
    }

    return tx.ingestionJob.findUnique({ where: { id: candidate.id } });
  });
}

export async function completeJob(jobId: string, cardId: string) {
  await prisma.ingestionJob.update({
    where: { id: jobId },
    data: {
      status: IngestionJobStatus.COMPLETED,
      resultCardId: cardId,
      finishedAt: new Date(),
      errorMessage: null
    }
  });
}

export async function failJob(jobId: string, errorMessage: string, attempts: number, maxAttempts: number) {
  await prisma.ingestionJob.update({
    where: { id: jobId },
    data: {
      status: attempts >= maxAttempts ? IngestionJobStatus.FAILED : IngestionJobStatus.PENDING,
      errorMessage,
      finishedAt: attempts >= maxAttempts ? new Date() : null
    }
  });
}

export async function processJobById(jobId: string) {
  const job = await prisma.ingestionJob.findUnique({ where: { id: jobId } });
  if (!job) {
    throw new Error("job not found");
  }

  if (job.type === IngestionJobType.URL) {
    const payload = urlPayloadSchema.parse(job.payload);
    return ingestUrlForUser(job.userId, payload.url, payload.sourceType);
  }

  const payload = notePayloadSchema.parse(job.payload);
  return ingestNoteForUser(job.userId, payload.title, payload.content);
}

export async function getIngestionJobById(jobId: string) {
  return prisma.ingestionJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      status: true,
      type: true,
      userId: true,
      attempts: true,
      errorMessage: true,
      resultCardId: true,
      createdAt: true,
      updatedAt: true,
      startedAt: true,
      finishedAt: true
    }
  });
}
