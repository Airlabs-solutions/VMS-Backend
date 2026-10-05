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
  SMS_PROVIDER: z.enum(["log", "unifonic", "taqnyat", "msegat"]).default("log"),
  SMS_SENDER: z.string().default("VMS"),
  SMS_API_KEY: z.string().optional(),
  SMS_API_URL: z.string().optional(),
  SMS_WEBHOOK_SECRET: z.string().optional(),
  STORAGE_DRIVER: z.enum(["local"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./uploads"),
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
  isProduction: parsed.data.NODE_ENV === "production",
};
