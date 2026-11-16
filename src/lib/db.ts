import { existsSync } from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import { env } from "../config/env";
import { logger } from "./logger";

let connecting: Promise<void> | null = null;
let memoryReplSet: { stop: () => Promise<boolean> } | null = null;

async function connectWithLocalFallback(uri: string): Promise<void> {
  const isLocalUri = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\b/i.test(uri);
  const canFallback = !env.isProduction && env.NODE_ENV !== "test" && isLocalUri;

  try {
    await mongoose.connect(uri, canFallback ? { serverSelectionTimeoutMS: 2500 } : undefined);
    logger.info("Connected to MongoDB");
  } catch (error) {
    if (!canFallback) throw error;
    logger.warn("Local MongoDB on 127.0.0.1:27017 is not running; starting embedded in-memory MongoDB replica set...");
    const { MongoMemoryReplSet } = await import("mongodb-memory-server");
    const cachedDir = path.resolve(process.cwd(), "node_modules/.cache/mongodb-memory-server");
    const cachedBin = path.join(cachedDir, "mongod-x64-darwin-7.0.24");
    const replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1 },
      binary: existsSync(cachedBin)
        ? { systemBinary: cachedBin }
        : { downloadDir: cachedDir },
    });
    memoryReplSet = replSet;
    await mongoose.connect(replSet.getUri());
    logger.info("Connected to embedded in-memory MongoDB replica set");
  }
}

export function connectDb(uri = env.MONGODB_URI): Promise<void> {
  if (mongoose.connection.readyState === 1) return Promise.resolve();
  if (!connecting) {
    mongoose.set("strictQuery", true);
    connecting = connectWithLocalFallback(uri).catch((error: unknown) => {
      connecting = null;
      throw error;
    });
  }
  return connecting;
}

export async function disconnectDb(): Promise<void> {
  connecting = null;
  await mongoose.disconnect();
  if (memoryReplSet) {
    await memoryReplSet.stop().catch(() => {});
    memoryReplSet = null;
  }
}
