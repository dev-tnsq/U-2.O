import express, { type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { getEnv } from "@u/core";
import { ensureVectorExtension, ensureVectorIndex, prisma } from "@u/db";
import { enqueueNoteIngestion, enqueueUrlIngestion, getIngestionJobById } from "@u/ingestion";

const env = getEnv();
const app = express();

app.use(express.json({ limit: "2mb" }));

function requireCollectorKey(req: Request, res: Response, next: NextFunction) {
  const provided = req.header("x-u-api-key");
  if (!provided || provided !== env.U_COLLECTOR_API_KEY) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().optional()
});

const ingestUrlSchema = z.object({
  userId: z.string(),
  url: z.string().url(),
  sourceType: z.string().default("article")
});

const ingestNoteSchema = z.object({
  userId: z.string(),
  title: z.string().min(3),
  content: z.string().min(20)
});

app.get("/health", async (_req, res) => {
  await prisma.$queryRawUnsafe("SELECT 1");
  res.json({ ok: true, service: "collector-api" });
});

app.post("/v1/users", requireCollectorKey, async (req, res) => {
  const input = createUserSchema.parse(req.body);
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

  res.json({ userId: user.id, email: user.email, name: user.name });
});

app.post("/v1/collect/url", requireCollectorKey, async (req, res) => {
  const input = ingestUrlSchema.parse(req.body);
  const job = await enqueueUrlIngestion(input);
  res.status(202).json({
    jobId: job.id,
    status: job.status,
    acceptedAt: job.createdAt
  });
});

app.post("/v1/collect/note", requireCollectorKey, async (req, res) => {
  const input = ingestNoteSchema.parse(req.body);
  const job = await enqueueNoteIngestion(input);
  res.status(202).json({
    jobId: job.id,
    status: job.status,
    acceptedAt: job.createdAt
  });
});

app.get("/v1/jobs/:jobId", requireCollectorKey, async (req, res) => {
  const jobId = z.string().parse(req.params.jobId);
  const job = await getIngestionJobById(jobId);

  if (!job) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  res.json(job);
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: "invalid_request", issues: err.issues });
    return;
  }

  const message = err instanceof Error ? err.message : "unknown error";
  res.status(500).json({ error: "internal_error", message });
});

async function main() {
  await ensureVectorExtension();
  await ensureVectorIndex();

  app.listen(env.U_COLLECTOR_PORT, () => {
    console.log(`U collector API listening on ${env.U_COLLECTOR_PORT}`);
  });
}

main().catch((err) => {
  console.error("Collector API failed:", err);
  process.exit(1);
});
