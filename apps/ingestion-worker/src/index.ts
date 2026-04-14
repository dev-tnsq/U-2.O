import { getEnv } from "@u/core";
import { prisma } from "@u/db";
import { claimPendingJob, completeJob, failJob, processJobById } from "@u/ingestion";

const env = getEnv();

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processNextJob(): Promise<boolean> {
  const job = await claimPendingJob();
  if (!job) {
    return false;
  }

  try {
    const result = await processJobById(job.id);
    await completeJob(job.id, result.cardId);
    console.log(`Completed ingestion job ${job.id} -> card ${result.cardId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown ingestion error";
    await failJob(job.id, message, job.attempts, env.U_INGESTION_MAX_ATTEMPTS);
    console.error(`Failed ingestion job ${job.id}: ${message}`);
  }

  return true;
}

async function main() {
  console.log("U ingestion worker started");

  while (true) {
    const processed = await processNextJob();
    if (!processed) {
      await sleep(env.U_INGESTION_WORKER_POLL_MS);
    }
  }
}

main()
  .catch((err) => {
    console.error("Ingestion worker crashed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
