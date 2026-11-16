import type { Readable } from "node:stream";

export interface StorageReadResult {
  stream: Readable;
  size: number;
  mime?: string;
  range?: {
    start: number;
    end: number;
    total: number;
  };
}

export interface FileStorageProvider {
  save(key: string, buffer: Buffer, mime: string): Promise<{ storageKey: string; size: number }>;
  read(key: string, rangeHeader?: string): Promise<StorageReadResult>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  getSignedUrl?(key: string, expiresInSeconds?: number): Promise<string>;
}
