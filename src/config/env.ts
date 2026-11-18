import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

function emptyToUndefined(value: unknown) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: z.enum(["local", "staging", "production"]).default("local"),
  PORT: z.coerce.number().default(5000),
  MONGODB_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  FIELD_ENCRYPTION_KEY: z.string().min(16),
  FIELD_HMAC_KEY: z.string().min(16),
  CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:3000"),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // Redis configuration (for BullMQ queues, caching and rate-limiting)
  REDIS_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  REDIS_HOST: z.string().default("localhost"),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.preprocess(emptyToUndefined, z.string().optional()),

  // Queue settings
  QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  RUN_WORKER: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // SMS configuration
  SMS_PROVIDER: z.enum(["log", "unifonic", "taqnyat", "msegat"]).default("log"),
  SMS_SENDER: z.string().default("AxetPro"),
  SMS_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  SMS_API_URL: z.preprocess(emptyToUndefined, z.string().optional()),
  SMS_WEBHOOK_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),

  // Object Storage configuration (Local or S3-compatible like MinIO)
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default(process.env.VERCEL ? "/tmp/uploads" : "./uploads"),
  S3_BUCKET: z.string().default("vms-documents"),
  S3_REGION: z.string().default("me-central-1"),
  S3_ENDPOINT: z.preprocess(emptyToUndefined, z.string().optional()),
  S3_ACCESS_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  S3_SECRET_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),

  RATE_LIMIT_DISABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  GOOGLE_CLIENT_ID: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  GMAIL_USER: z.preprocess(emptyToUndefined, z.string().email().optional()),
  GMAIL_APP_PASSWORD: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  SEED_DEMO: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
  throw new Error(`Invalid environment configuration: ${fields}`);
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  isProduction: parsed.data.NODE_ENV === "production" || parsed.data.APP_ENV === "production",
  isStaging: parsed.data.APP_ENV === "staging",
  isLocal: parsed.data.APP_ENV === "local",
};
