import { prisma } from "./client.js";

export async function ensureVectorExtension(): Promise<void> {
  await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector');
}

export async function ensureVectorIndex(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'CREATE INDEX IF NOT EXISTS card_embeddings_hnsw_idx ON "Card" USING hnsw (embeddings vector_cosine_ops)'
  );
}
