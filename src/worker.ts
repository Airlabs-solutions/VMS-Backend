import cron from "node-cron";
import { connectDb } from "./lib/db";
import { logger } from "./lib/logger";
import { runDailyAlerts, runSmsRetry } from "./jobs/dailyAlerts";

async function main() {
  await connectDb();
  cron.schedule("0 6 * * *", () => {
    runDailyAlerts().catch((error: unknown) => {
      logger.error({ message: error instanceof Error ? error.message : "job failed" }, "Daily alerts failed");
    });
  }, { timezone: "Asia/Riyadh" });
  cron.schedule("*/10 * * * *", () => {
    runSmsRetry().catch((error: unknown) => {
      logger.error({ message: error instanceof Error ? error.message : "job failed" }, "SMS retry failed");
    });
  });
  logger.info("Worker started");
}

main().catch((error: unknown) => {
  logger.error({ message: error instanceof Error ? error.message : "startup failed" }, "Worker failed to start");
  process.exit(1);
});
