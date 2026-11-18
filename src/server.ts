import type { Server } from "node:http";
import { env } from "./config/env";
import { createApp } from "./app";
import { queueService } from "./core/queue";
import { connectDb, disconnectDb } from "./lib/db";
import { logger } from "./lib/logger";
import { seedDatabase } from "./seed";

let server: Server | null = null;
let isShuttingDown = false;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, "Graceful shutdown initiated...");

  // 1. Stop accepting new HTTP requests
  if (server) {
    await new Promise<void>((resolve) => {
      server!.close((err) => {
        if (err) logger.error({ err }, "Error closing HTTP server");
        else logger.info("HTTP server stopped accepting connections");
        resolve();
      });
    });
  }

  // 2. Drain any active in-flight queue jobs
  try {
    await queueService.drain(10000);
    logger.info("Queues drained successfully");
  } catch (err) {
    logger.error({ err }, "Error draining queue jobs");
  }

  // 3. Disconnect from MongoDB
  try {
    await disconnectDb();
    logger.info("Database connection closed");
  } catch (err) {
    logger.error({ err }, "Error closing database connection");
  }

  logger.info("Graceful shutdown complete. Exiting.");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

async function main() {
  await connectDb();
  await seedDatabase();
  const app = createApp();
  server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.APP_ENV }, "AxetPro API listening");
  });
}

main().catch((error: unknown) => {
  logger.error({ message: error instanceof Error ? error.message : "startup failed" }, "API failed to start");
  process.exit(1);
});
