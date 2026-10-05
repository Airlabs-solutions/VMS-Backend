import { env } from "./config/env";
import { createApp } from "./app";
import { connectDb } from "./lib/db";
import { logger } from "./lib/logger";
import { seedDatabase } from "./seed";

async function main() {
  await connectDb();
  await seedDatabase();
  const app = createApp();
  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, "API listening");
  });
}

main().catch((error: unknown) => {
  logger.error({ message: error instanceof Error ? error.message : "startup failed" }, "API failed to start");
  process.exit(1);
});
