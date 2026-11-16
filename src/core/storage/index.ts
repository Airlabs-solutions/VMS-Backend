import { env } from "../../config/env";
import { LocalStorageDriver } from "./local";
import { S3StorageDriver } from "./s3";
import type { FileStorageProvider } from "./types";

export * from "./types";
export * from "./local";
export * from "./s3";

let instance: FileStorageProvider | null = null;

export function getStorageProvider(): FileStorageProvider {
  if (instance) return instance;

  if (env.STORAGE_DRIVER === "s3") {
    instance = new S3StorageDriver({
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      accessKey: env.S3_ACCESS_KEY,
      secretKey: env.S3_SECRET_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    });
  } else {
    instance = new LocalStorageDriver(env.STORAGE_LOCAL_DIR);
  }

  return instance;
}
