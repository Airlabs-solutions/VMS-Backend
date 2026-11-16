import cron from "node-cron";
import { queueService } from "./core/queue";
import { connectDb, disconnectDb } from "./lib/db";
import { logger } from "./lib/logger";
import { runDailyAlerts, runSmsRetry } from "./jobs/dailyAlerts";

let isShuttingDown = false;
let cronAlertTask: cron.ScheduledTask | null = null;
let cronRetryTask: cron.ScheduledTask | null = null;

async function shutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, "Worker graceful shutdown initiated...");

  if (cronAlertTask) cronAlertTask.stop();
  if (cronRetryTask) cronRetryTask.stop();

  try {
    await queueService.drain(10000);
    logger.info("Worker queues drained");
  } catch (err) {
    logger.error({ err }, "Error draining worker queues");
  }

  try {
    await disconnectDb();
    logger.info("Worker database connection closed");
  } catch (err) {
    logger.error({ err }, "Error disconnecting worker database");
  }

  logger.info("Worker shutdown complete. Exiting.");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Register queue handlers for async worker tasks
queueService.registerHandler("alert-queue", async (job) => {
  logger.info({ jobId: job.id, name: job.name }, "Processing alert-queue job");
  await runDailyAlerts();
});

queueService.registerHandler("sms-queue", async (job) => {
  logger.info({ jobId: job.id, name: job.name }, "Processing sms-queue job");
  await runSmsRetry();
});

async function main() {
  await connectDb();

  // Schedule daily alerts at 06:00 Asia/Riyadh
  cronAlertTask = cron.schedule(
    "0 6 * * *",
    () => {
      queueService
        .add("alert-queue", "daily-alerts", { scheduledAt: new Date().toISOString() })
        .catch((error: unknown) => {
          logger.error({ message: error instanceof Error ? error.message : "job failed" }, "Failed to queue daily alerts");
        });
    },
    { timezone: "Asia/Riyadh" },
  );

  // Retry queued/failed SMS every 10 minutes
  cronRetryTask = cron.schedule("*/10 * * * *", () => {
    queueService
      .add("sms-queue", "sms-retry", { scheduledAt: new Date().toISOString() })
      .catch((error: unknown) => {
        logger.error({ message: error instanceof Error ? error.message : "job failed" }, "Failed to queue SMS retry");
      });
  });

  logger.info("VMS Worker started with queues and schedulers active");
}

main().catch((error: unknown) => {
  logger.error({ message: error instanceof Error ? error.message : "startup failed" }, "Worker failed to start");
  process.exit(1);
});
