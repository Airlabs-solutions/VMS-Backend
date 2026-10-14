import { Types } from "mongoose";
import { z } from "zod";
import { env } from "../../config/env";
import { decryptField } from "../../lib/crypto";
import { AppError, notFound } from "../../lib/errors";
import { dateDto } from "../../lib/present";
import { getSmsProvider } from "../../integrations/sms";
import { Company } from "../companies/model";
import { FileAsset } from "../files/model";
import { signedUrl } from "../files/service";
import { getCtx, requireCompanyId } from "../../lib/context";
import { AuditLog } from "../audit/model";
import { Driver } from "../drivers/model";
import { DirectMessage } from "./model";

const fileId = z.string().regex(/^[a-f\d]{24}$/i);

export const messageBody = z
  .object({
    driverId: z.string().trim().min(1),
    body: z.string().trim().max(500),
    fileIds: z.array(fileId).max(12).optional(),
  })
  .refine((value) => value.body.length > 0 || (value.fileIds?.length ?? 0) > 0, {
    message: "Write a message or add a document",
    path: ["body"],
  });

export const broadcastBody = z
  .object({
    body: z.string().trim().max(500),
    fileIds: z.array(fileId).max(12).optional(),
    driverIds: z.array(z.string().regex(/^[a-f\d]{24}$/i)).max(500).optional(),
  })
  .refine((value) => value.body.length > 0 || (value.fileIds?.length ?? 0) > 0, {
    message: "Write a message or add a document",
    path: ["body"],
  });

export async function sendBroadcast(input: z.infer<typeof broadcastBody>) {
  const requested = input.driverIds ?? [];
  const drivers = requested.length
    ? await Driver.find({ _id: { $in: requested }, status: "active" })
    : await Driver.find({ status: "active" });
  if (!drivers.length) throw notFound("Driver");
  const broadcastId = new Types.ObjectId();
  const fileIds = (input.fileIds ?? []).map((id) => new Types.ObjectId(id));
  const ctx = getCtx();
  const companyId = new Types.ObjectId(requireCompanyId());
  const actorId = ctx.userId ? new Types.ObjectId(ctx.userId) : undefined;
  await DirectMessage.insertMany(
    drivers.map((driver) => ({
      companyId,
      driverId: driver._id,
      senderRole: "admin",
      body: input.body,
      fileIds,
      broadcastId,
      createdBy: actorId,
      updatedBy: actorId,
    })),
  );
  await AuditLog.create({
    companyId,
    actorId,
    action: "create",
    collectionName: "directmessages",
    docId: String(broadcastId),
    after: { broadcast: true, sent: drivers.length, fileCount: fileIds.length },
    at: new Date(),
    ip: ctx.ip,
    supportGrantId: ctx.supportGrantId,
  });
  const company = await Company.findById(requireCompanyId()).lean();
  const smsBody = input.body || "A document was sent from the fleet office.";
  let delivered = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(8, drivers.length) }, async () => {
    while (cursor < drivers.length) {
      const driver = drivers[cursor];
      cursor += 1;
      try {
        await getSmsProvider().send({
          to: decryptField(driver.mobileEnc),
          body: smsBody,
          sender: company?.smsSenderName || env.SMS_SENDER,
        });
        delivered += 1;
      } catch {
        /* One failed SMS does not undo the messages already saved. */
      }
    }
  });
  await Promise.all(workers);
  return {
    id: String(broadcastId),
    broadcastId: String(broadcastId),
    driverId: "",
    driverName: "All drivers",
    senderRole: "admin" as const,
    body: input.body,
    fileIds: (input.fileIds ?? []).map(String),
    sent: drivers.length,
    delivered,
    createdAt: dateDto(new Date()),
  };
}

export async function sendDirectMessage(input: z.infer<typeof messageBody>) {
  const driver = await Driver.findById(input.driverId);
  if (!driver || driver.status !== "active") throw notFound("Driver");
  const message = await DirectMessage.create({
    driverId: driver._id,
    senderRole: "admin",
    body: input.body,
    fileIds: (input.fileIds ?? []).map((id) => new Types.ObjectId(id)),
  });
  const company = await Company.findById(requireCompanyId()).lean();
  const smsBody = input.body || "A document was sent from the fleet office.";
  let delivered = false;
  try {
    await getSmsProvider().send({
      to: decryptField(driver.mobileEnc),
      body: smsBody,
      sender: company?.smsSenderName || env.SMS_SENDER,
    });
    delivered = true;
  } catch {
    delivered = false;
  }
  return {
    id: String(message._id),
    driverId: String(driver._id),
    driverName: driver.name,
    body: message.body,
    fileIds: (message.fileIds ?? []).map(String),
    delivered,
    createdAt: dateDto(message.createdAt),
  };
}

export async function updateDirectMessage(id: string, input: z.infer<typeof messageBody>) {
  const message = await DirectMessage.findById(id);
  if (!message) throw notFound("Message");
  const driver = await Driver.findById(input.driverId);
  if (!driver) throw notFound("Driver");
  message.driverId = driver._id;
  message.body = input.body;
  message.fileIds = (input.fileIds ?? []).map((fileId) => new Types.ObjectId(fileId));
  await message.save();
  return {
    id: String(message._id),
    driverId: String(driver._id),
    driverName: driver.name,
    body: message.body,
    fileIds: (message.fileIds ?? []).map(String),
    createdAt: dateDto(message.createdAt),
  };
}

export async function deleteDirectMessage(id: string) {
  const message = await DirectMessage.findById(id);
  if (!message) throw notFound("Message");
  await message.deleteOne();
  return { id };
}

export async function listDirectMessages() {
  const rows = await DirectMessage.find().sort({ createdAt: -1 }).limit(400).lean();
  const drivers = await Driver.find({ _id: { $in: rows.map((row) => row.driverId) } }).select("name").lean();
  const names = new Map(drivers.map((driver) => [String(driver._id), driver.name]));
  return rows.map((row) => ({
    id: String(row._id),
    driverId: String(row.driverId),
    driverName: names.get(String(row.driverId)) ?? "Driver",
    senderRole: row.senderRole === "driver" ? "driver" : "admin",
    body: row.body,
    fileIds: (row.fileIds ?? []).map(String),
    broadcastId: row.broadcastId ? String(row.broadcastId) : null,
    createdAt: dateDto(row.createdAt),
  }));
}

function driverMessageFilter(driverId: string) {
  if (!Types.ObjectId.isValid(driverId)) throw new AppError(403, "FORBIDDEN", "No driver profile is linked to this account");
  return { driverId: new Types.ObjectId(driverId) };
}

export async function unreadForDriver(driverId: string) {
  const unread = await DirectMessage.countDocuments({
    ...driverMessageFilter(driverId),
    readByDriverAt: null,
    senderRole: { $ne: "driver" },
  });
  return { unread };
}

export async function listForDriver(driverId: string) {
  const filter = driverMessageFilter(driverId);
  await DirectMessage.updateMany(
    { ...filter, readByDriverAt: null, senderRole: { $ne: "driver" } },
    { readByDriverAt: new Date() },
  );
  const rows = await DirectMessage.find(filter).sort({ createdAt: 1 }).limit(100).lean();
  return rows.map((row) => ({
    id: String(row._id),
    senderRole: row.senderRole === "driver" ? "driver" : "admin",
    body: row.body,
    fileIds: (row.fileIds ?? []).map(String),
    createdAt: dateDto(row.createdAt),
  }));
}

export async function fileUrlForDriver(driverId: string, fileId: string) {
  if (!Types.ObjectId.isValid(fileId)) throw notFound("File");
  const owns = await DirectMessage.exists({
    ...driverMessageFilter(driverId),
    fileIds: new Types.ObjectId(fileId),
  });
  if (!owns) throw notFound("File");
  return signedUrl(fileId);
}

export async function replyToAdmin(driverId: string, body: string, fileIds: string[] = []) {
  const text = body.trim();
  if (!text && fileIds.length === 0) throw new AppError(400, "VALIDATION_ERROR", "Write a message or add a file");
  if (text.length > 500) throw new AppError(400, "VALIDATION_ERROR", "Message must be 500 characters or less");
  if (fileIds.length > 12) throw new AppError(400, "VALIDATION_ERROR", "You can attach up to 12 files");
  const ids = fileIds.map((id) => {
    if (!Types.ObjectId.isValid(id)) throw new AppError(400, "VALIDATION_ERROR", "Check the highlighted fields");
    return new Types.ObjectId(id);
  });
  if (ids.length) {
    const actorId = getCtx().userId;
    if (!actorId) throw new AppError(403, "FORBIDDEN", "No driver profile is linked to this account");
    const owned = await FileAsset.find({ _id: { $in: ids }, module: "messages", createdBy: actorId }).select("_id");
    if (owned.length !== ids.length) throw new AppError(400, "INVALID_FILE", "One of the files could not be attached");
  }
  const driver = await Driver.findById(driverId);
  if (!driver || driver.status !== "active") throw notFound("Driver");
  const message = await DirectMessage.create({
    driverId: driver._id,
    senderRole: "driver",
    body: text,
    fileIds: ids,
    readByDriverAt: new Date(),
  });
  return {
    id: String(message._id),
    senderRole: "driver" as const,
    body: message.body,
    fileIds: (message.fileIds ?? []).map(String),
    createdAt: dateDto(message.createdAt),
  };
}
