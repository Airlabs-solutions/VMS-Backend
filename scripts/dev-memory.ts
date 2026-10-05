import { MongoMemoryReplSet } from "mongodb-memory-server";

async function main() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = replSet.getUri();
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "dev-access-secret-change-me-please";
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? "dev-refresh-secret-change-me-please";
  process.env.FIELD_ENCRYPTION_KEY = process.env.FIELD_ENCRYPTION_KEY ?? "dev-field-encryption-key-change";
  process.env.FIELD_HMAC_KEY = process.env.FIELD_HMAC_KEY ?? "dev-field-hmac-key-change-me";
  process.env.SEED_DEMO = process.env.SEED_DEMO ?? "true";
  const seed = await import("../src/seed.ts");
  await seed.runSeed();
  await import("../src/server.ts");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Failed to start");
  process.exit(1);
});
