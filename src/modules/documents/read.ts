import os from "node:os";
import path from "node:path";
import type { Worker } from "tesseract.js";
import { MAX_UPLOAD_BYTES } from "../../config/constants";
import { AppError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { saveUpload } from "../files/service";
import { fieldsFound, parseDriverLicense, parseInsurance, parseIstimara, type DriverLicenseFields, type InsuranceFields, type IstimaraFields } from "./parse";
import { Vehicle } from "../vehicles/model";

const CACHE = path.join(os.tmpdir(), "vms-tesseract");

let worker: Worker | null = null;
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>) {
  const run = queue.then(job, job);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

async function recognize(image: Buffer) {
  return enqueue(async () => {
    if (!worker) {
      const { createWorker } = await import("tesseract.js");
      worker = await createWorker("eng+ara", 1, { cachePath: CACHE });
    }
    const result = await worker.recognize(image);
    return result.data.text ?? "";
  });
}

function fileKind(buffer: Buffer) {
  if (buffer.subarray(0, 4).equals(Buffer.from("%PDF"))) return "pdf" as const;
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "jpeg" as const;
  if (buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "png" as const;
  return null;
}

async function textFromPdf(buffer: Buffer) {
  const { extractText, getDocumentProxy, renderPageAsImage } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const extracted = await extractText(pdf, { mergePages: true });
  const embedded = extracted.text;
  if (embedded.replace(/\s/g, "").length >= 40) return embedded;
  const pages = Math.min(pdf.numPages, 2);
  const parts = [embedded];
  for (let page = 1; page <= pages; page += 1) {
    const png = await renderPageAsImage(pdf, page, {
      canvasImport: () => import("@napi-rs/canvas"),
      scale: 2,
      format: "png",
    });
    parts.push(await recognize(Buffer.from(png)));
  }
  return parts.join("\n");
}

async function documentText(buffer: Buffer, kind: "pdf" | "jpeg" | "png") {
  if (kind === "pdf") return textFromPdf(buffer);
  return recognize(buffer);
}

export async function attachVehicleDocument(
  vehicleId: string | undefined,
  kind: "istimara" | "insurance" | "driver_license",
  fileId: string,
) {
  if (!vehicleId || !/^[a-f\d]{24}$/i.test(vehicleId) || !/^[a-f\d]{24}$/i.test(fileId)) return;
  await Vehicle.updateOne(
    { _id: vehicleId, "documents.fileId": { $ne: fileId } },
    { $push: { documents: { kind, fileId, uploadedAt: new Date() } } },
  ).catch(() => {});
}

export async function readVehicleDocument(
  file: Express.Multer.File | undefined,
  kind: "istimara" | "insurance" | "driver_license",
  vehicleId?: string,
) {
  if (!file) throw new AppError(400, "INVALID_FILE", "Choose a JPG, PNG, or PDF");
  if (file.size > MAX_UPLOAD_BYTES) throw new AppError(400, "INVALID_FILE", "This file is larger than 10 MB");
  const detected = fileKind(file.buffer);
  if (!detected) throw new AppError(400, "INVALID_FILE", "Use a JPG, PNG, or PDF, up to 10 MB");
  const saved = await saveUpload(file, kind === "driver_license" ? "drivers" : kind);
  await attachVehicleDocument(vehicleId, kind, saved.id);
  let text = "";
  try {
    text = await documentText(file.buffer, detected);
  } catch (error) {
    logger.error({ message: error instanceof Error ? error.message : "document read failed" }, "Document scan failed");
    text = "";
  }
  const fields: IstimaraFields | InsuranceFields | DriverLicenseFields =
    kind === "istimara"
      ? parseIstimara(text)
      : kind === "driver_license"
        ? parseDriverLicense(text)
        : parseInsurance(text);
  const found = fieldsFound(fields);
  return {
    file: saved,
    kind,
    fields,
    found,
    notice: found
      ? "Scan complete: Check the extracted fields below. You can edit or correct any field manually before saving."
      : "Could not extract all fields automatically. Please enter or complete the details manually below.",
  };
}
