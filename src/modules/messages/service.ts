import { Types } from "mongoose";
import { z } from "zod";
import { env } from "../../config/env";
import { decryptField } from "../../lib/crypto";
import { AppError, notFound } from "../../lib/errors";
import { dateDto } from "../../lib/present";
import { getSmsProvider } from "../../integrations/sms";
import { Company } from "../companies/model";
import { requireCompanyId } from "../../lib/context";
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
  const rows = await DirectMessage.find().sort({ createdAt: -1 }).limit(100).lean();
  const drivers = await Driver.find({ _id: { $in: rows.map((row) => row.driverId) } }).select("name").lean();
  const names = new Map(drivers.map((driver) => [String(driver._id), driver.name]));
  return rows.map((row) => ({
    id: String(row._id),
    driverId: String(row.driverId),
    driverName: names.get(String(row.driverId)) ?? "Driver",
    senderRole: row.senderRole === "driver" ? "driver" : "admin",
    body: row.body,
    fileIds: (row.fileIds ?? []).map(String),
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
    createdAt: dateDto(row.createdAt),
  }));
}

export async function replyToAdmin(driverId: string, body: string) {
  const text = body.trim();
  if (!text) throw new AppError(400, "VALIDATION_ERROR", "Write a message");
  if (text.length > 500) throw new AppError(400, "VALIDATION_ERROR", "Message must be 500 characters or less");
  const driver = await Driver.findById(driverId);
  if (!driver || driver.status !== "active") throw notFound("Driver");
  const message = await DirectMessage.create({
    driverId: driver._id,
    senderRole: "driver",
    body: text,
    fileIds: [],
    readByDriverAt: new Date(),
  });
  return {
    id: String(message._id),
    senderRole: "driver" as const,
    body: message.body,
    createdAt: dateDto(message.createdAt),
  };
}
