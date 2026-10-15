import mongoose from "mongoose";
import { env } from "../config/env";
import { logger } from "./logger";

let connecting: Promise<void> | null = null;

export function connectDb(uri = env.MONGODB_URI): Promise<void> {
  if (mongoose.connection.readyState === 1) return Promise.resolve();
  if (!connecting) {
    mongoose.set("strictQuery", true);
    connecting = mongoose.connect(uri).then(() => {
      logger.info("Connected to MongoDB");
    }).catch((error: unknown) => {
      connecting = null;
      throw error;
    });
  }
  return connecting;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
