import { createReadStream } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { Types } from "mongoose";
import { MAX_UPLOAD_BYTES } from "../../config/constants";
import { env } from "../../config/env";
import { requireCompanyId } from "../../lib/context";
import { safeEqual, signValue } from "../../lib/crypto";
import { AppError, notFound } from "../../lib/errors";
import { FileAsset } from "./model";

const BLOCKED_EXT = new Set(["exe", "dll", "bat", "cmd", "com", "msi", "js", "mjs", "html", "htm", "svg", "php", "sh", "ps1", "jar", "vbs", "scr"]);

function detect(buffer: Buffer, originalName: string) {
  if (buffer.subarray(0, 4).equals(Buffer.from("%PDF"))) return { mime: "application/pdf", ext: "pdf" };
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { mime: "image/jpeg", ext: "jpg" };
  if (buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return { mime: "image/png", ext: "png" };
  if (buffer.subarray(0, 6).equals(Buffer.from("GIF87a")) || buffer.subarray(0, 6).equals(Buffer.from("GIF89a"))) return { mime: "image/gif", ext: "gif" };
  if (buffer.subarray(0, 4).equals(Buffer.from("RIFF")) && buffer.subarray(8, 12).equals(Buffer.from("WEBP"))) return { mime: "image/webp", ext: "webp" };
  if (buffer.subarray(0, 2).equals(Buffer.from("BM"))) return { mime: "image/bmp", ext: "bmp" };
  const brand = buffer.subarray(4, 12).toString("ascii");
  if (brand.startsWith("ftyp") && /heic|heif|mif1|msf1/.test(buffer.subarray(8, 16).toString("ascii"))) return { mime: "image/heic", ext: "heic" };

  const ext = path.extname(originalName).replace(/^\./, "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  if (!ext || BLOCKED_EXT.has(ext)) {
    throw new AppError(400, "INVALID_FILE", "This file type is not allowed. Maximum size is 10 MB.");
  }
  return { mime: "application/octet-stream", ext };
}

export async function saveUpload(file: Express.Multer.File | undefined, moduleName: string) {
  if (!file) throw new AppError(400, "INVALID_FILE", "Choose a file to upload");
  if (file.size > MAX_UPLOAD_BYTES) throw new AppError(400, "INVALID_FILE", "This file is larger than 10 MB");
  const detected = detect(file.buffer, file.originalname || "");
  const companyId = requireCompanyId();
  const year = new Date().getFullYear();
  const key = path.join("companies", companyId, moduleName, String(year), `${randomUUID()}.${detected.ext}`);
  const absolute = path.join(env.STORAGE_LOCAL_DIR, key);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, file.buffer);
  const record = await FileAsset.create({
    key,
    name: path.basename(file.originalname).slice(0, 180) || `file.${detected.ext}`,
    mime: detected.mime,
    size: file.size,
    module: moduleName,
  });
  return { id: String(record._id), name: record.name, mime: record.mime, size: record.size };
}

export async function signedUrl(id: string) {
  const file = await FileAsset.findById(id).lean();
  if (!file) throw notFound("File");
  const exp = Date.now() + 5 * 60 * 1000;
  const token = `${exp}.${signValue(`${id}.${exp}`)}`;
  return { url: `/api/v1/files/${id}/download?token=${token}`, expiresAt: new Date(exp).toISOString() };
}

export function tokenIsValid(id: string, token: string | undefined): boolean {
  if (!token) return false;
  const [exp, signature] = token.split(".");
  if (!exp || !signature) return false;
  if (Number(exp) < Date.now()) return false;
  return safeEqual(signature, signValue(`${id}.${exp}`));
}

export async function streamFile(id: string, res: Response) {
  if (!Types.ObjectId.isValid(id)) throw notFound("File");
  const file = await FileAsset.findById(id).setOptions({ skipTenant: true }).lean();
  if (!file) throw notFound("File");
  const absolute = path.join(env.STORAGE_LOCAL_DIR, file.key);
  try {
    await access(absolute);
  } catch {
    throw notFound("File");
  }
  const showInline = file.mime.startsWith("image/") || file.mime === "application/pdf";
  res.setHeader("Content-Type", file.mime);
  res.setHeader("Content-Disposition", `${showInline ? "inline" : "attachment"}; filename="${file.name.replace(/"/g, "")}"`);
  const stream = createReadStream(absolute);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "File was not found" } });
      return;
    }
    res.destroy();
  });
  stream.pipe(res);
}
