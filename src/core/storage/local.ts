import { createReadStream } from "node:fs";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../../lib/errors";
import type { FileStorageProvider, StorageReadResult } from "./types";

export class LocalStorageDriver implements FileStorageProvider {
  constructor(private readonly baseDir: string) {}

  private resolvePath(key: string): string {
    const safeKey = key.replace(/^[/\\]+/, "");
    const resolved = path.resolve(this.baseDir, safeKey);
    const root = path.resolve(this.baseDir);
    if (!resolved.startsWith(root)) {
      throw new AppError(400, "INVALID_PATH", "Path traversal blocked");
    }
    return resolved;
  }

  async save(key: string, buffer: Buffer): Promise<{ storageKey: string; size: number }> {
    const absolute = this.resolvePath(key);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, buffer);
    return { storageKey: key, size: buffer.length };
  }

  async read(key: string, rangeHeader?: string): Promise<StorageReadResult> {
    const absolute = this.resolvePath(key);
    let stats;
    try {
      stats = await stat(absolute);
    } catch {
      throw new AppError(404, "NOT_FOUND", "File was not found");
    }

    const total = stats.size;
    if (rangeHeader && rangeHeader.startsWith("bytes=")) {
      const parts = rangeHeader.replace(/bytes=/, "").split("-");
      const start = Number(parts[0]);
      const end = parts[1] ? Number(parts[1]) : total - 1;
      if (!Number.isNaN(start) && !Number.isNaN(end) && start <= end && start < total) {
        const boundedEnd = Math.min(end, total - 1);
        const stream = createReadStream(absolute, { start, end: boundedEnd });
        return {
          stream,
          size: boundedEnd - start + 1,
          range: { start, end: boundedEnd, total },
        };
      }
    }

    const stream = createReadStream(absolute);
    return { stream, size: total };
  }

  async delete(key: string): Promise<void> {
    try {
      const absolute = this.resolvePath(key);
      await unlink(absolute);
    } catch {
      // Ignore if file already removed
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      const absolute = this.resolvePath(key);
      await stat(absolute);
      return true;
    } catch {
      return false;
    }
  }

  async getSignedUrl(key: string): Promise<string> {
    return `/api/v1/files/${encodeURIComponent(key)}`;
  }
}
