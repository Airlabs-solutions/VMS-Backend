import mongoose from "mongoose";
import { env } from "../config/env";
import { logger } from "./logger";

export async function connectDb(uri = env.MONGODB_URI): Promise<void> {
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri);
  logger.info("Connected to MongoDB");
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
