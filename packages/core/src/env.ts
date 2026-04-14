import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-large"),
  OPENAI_SUMMARY_MODEL: z.string().min(1).default("gpt-4.1-mini"),
  U_DEFAULT_USER_ID: z.string().min(1).default("local-user")
});

export type AppEnv = z.infer<typeof envSchema>;

export function getEnv(rawEnv: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(rawEnv);
}
