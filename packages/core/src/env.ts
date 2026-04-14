import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-large"),
  OPENAI_SUMMARY_MODEL: z.string().min(1).default("gpt-4.1-mini"),
  U_DEFAULT_USER_ID: z.string().min(1).default("local-user"),
  U_COLLECTOR_API_KEY: z.string().min(16),
  U_MCP_ADMIN_KEY: z.string().min(16).optional(),
  U_COLLECTOR_PORT: z.coerce.number().int().min(1).max(65535).default(4040),
  U_MCP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  U_INGESTION_WORKER_POLL_MS: z.coerce.number().int().min(100).default(1000),
  U_INGESTION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  U_REQUIRE_IDEMPOTENCY_KEY: z.coerce.boolean().default(true)
});

export type AppEnv = z.infer<typeof envSchema>;

export function getEnv(rawEnv: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(rawEnv);
}
