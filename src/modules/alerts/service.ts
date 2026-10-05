import { Types } from "mongoose";
import { env } from "../../config/env";
import { requireCompanyId } from "../../lib/context";
import { decryptField, encryptField } from "../../lib/crypto";
import { AppError, notFound } from "../../lib/errors";
import { isDuplicateKey } from "../../lib/tenantPlugin";
import { logger } from "../../lib/logger";
import { maskMobile } from "../../lib/phone";
import { listArgs, listResult } from "../../lib/pagination";
import { dateDto, statusDto } from "../../lib/present";
import { getSmsProvider } from "../../integrations/sms";
import { Company } from "../companies/model";
import { Driver } from "../drivers/model";
import { User } from "../users/model";
import { Alert, AlertRule, SmsLog } from "./model";
import { violationMessage } from "./templates";

export async function raiseAlert(input: {
  type: string;
  entityRef: string;
  vehicleId?: string;
  driverId?: string;
  dueDate?: Date;
  offset: number;
  dedupeKey: string;
  message: string;
}) {
  try {
    return await Alert.create({
      type: input.type,
      entityRef: input.entityRef,
      vehicleId: input.vehicleId ? new Types.ObjectId(input.vehicleId) : undefined,
      driverId: input.driverId ? new Types.ObjectId(input.driverId) : undefined,
      dueDate: input.dueDate,
      offset: input.offset,
      dedupeKey: input.dedupeKey,
      message: input.message,
      status: "open",
    });
  } catch (error) {
    if (isDuplicateKey(error)) return null;
    throw error;
  }
}

async function adminMobiles(): Promise<string[]> {
  const companyId = requireCompanyId();
  const admins = await User.find({ companyId, role: "company_admin", status: "active", mobileEnc: { $exists: true, $ne: "" } }).lean();
  return admins.filter((admin) => admin.mobileEnc).map((admin) => decryptField(admin.mobileEnc as string));
}

async function driverMobile(driverId?: string): Promise<string | null> {
  if (!driverId) return null;
  const driver = await Driver.findById(driverId).lean();
  if (!driver) return null;
  return decryptField(driver.mobileEnc);
}

export async function sendAlertSms(alertId: string, message: string, recipients: Array<"admin" | "driver">, driverId?: string) {
  const numbers = new Set<string>();
  if (recipients.includes("admin")) {
    for (const mobile of await adminMobiles()) numbers.add(mobile);
  }
  if (recipients.includes("driver")) {
    const mobile = await driverMobile(driverId);
    if (mobile) numbers.add(mobile);
  }
  for (const mobile of numbers) {
    await deliverSms(alertId, mobile, message);
  }
}

async function deliverSms(alertId: string, mobile: string, body: string) {
  const companyId = requireCompanyId();
  const company = await Company.findById(companyId);
  const log = await SmsLog.create({
    alertId: new Types.ObjectId(alertId),
    recipientEnc: encryptField(mobile),
    recipientMasked: maskMobile(mobile),
    body,
    provider: env.SMS_PROVIDER,
    status: "queued",
    attempts: 0,
  });
  if (!company || company.smsCredits <= 0) {
    log.status = "failed";
    log.error = "NO_CREDITS";
    await log.save();
    return;
  }
  try {
    const result = await getSmsProvider().send({
      to: mobile,
      body,
      sender: company.smsSenderName || env.SMS_SENDER,
    });
    const taken = await Company.updateOne({ _id: company._id, smsCredits: { $gt: 0 } }, { $inc: { smsCredits: -1 } });
    if (taken.modifiedCount === 0) {
      log.status = "failed";
      log.error = "NO_CREDITS";
      await log.save();
      return;
    }
    log.status = "sent";
    log.providerMessageId = result.providerMessageId;
    log.sentAt = new Date();
    log.attempts += 1;
    await log.save();
  } catch (error) {
    log.attempts += 1;
    log.status = "failed";
    log.error = "SEND_FAILED";
    await log.save();
    logger.error({ message: error instanceof Error ? error.message : "sms failed" }, "SMS send failed");
  }
}

export async function raiseViolationAlert(input: {
  violationId: string;
  vehicleId: string;
  plateNumber: string;
  driverId?: string;
  amountHalalas: number;
}) {
  const rule = await AlertRule.findOne({ type: "violation_created" }).lean();
  if (rule && !rule.enabled) return;
  const message = violationMessage(input.plateNumber, input.amountHalalas);
  const alert = await raiseAlert({
    type: "violation_created",
    entityRef: input.violationId,
    vehicleId: input.vehicleId,
    driverId: input.driverId,
    offset: 0,
    dedupeKey: `violation_created:${input.violationId}:0`,
    message,
  });
  if (!alert) return;
  const recipients = (rule?.recipients ?? ["admin", "driver"]) as Array<"admin" | "driver">;
  await sendAlertSms(String(alert._id), message, recipients, input.driverId);
}

export async function listAlerts(raw: { page?: number; limit?: number; status?: string }) {
  const query = listArgs(raw, ["createdAt"], "-createdAt");
  const filter: Record<string, unknown> = {};
  if (raw.status) filter.status = raw.status;
  const [rows, total] = await Promise.all([
    Alert.find(filter).sort(query.sort).skip(query.skip).limit(query.limit).lean(),
    Alert.countDocuments(filter),
  ]);
  return listResult(
    rows.map((row) => ({
      id: String(row._id),
      type: row.type,
      message: row.message,
      status: statusDto(row.status),
      dueDate: dateDto(row.dueDate),
      vehicleId: row.vehicleId ? String(row.vehicleId) : null,
      createdAt: dateDto(row.createdAt),
    })),
    total,
    query,
  );
}

export async function dismissAlert(id: string) {
  const row = await Alert.findByIdAndUpdate(id, { status: "dismissed" }, { new: true });
  if (!row) throw notFound("Alert");
  return { id: String(row._id), status: row.status };
}

export async function listRules() {
  const rows = await AlertRule.find().sort({ type: 1 }).lean();
  return rows.map((row) => ({
    type: row.type,
    offsets: row.offsets,
    enabled: row.enabled,
    recipients: row.recipients,
  }));
}

export async function updateRule(type: string, input: { offsets?: number[]; enabled?: boolean; recipients?: string[] }) {
  const row = await AlertRule.findOne({ type });
  if (!row) throw notFound("Alert rule");
  if (input.offsets) row.offsets = input.offsets;
  if (input.enabled != null) row.enabled = input.enabled;
  if (input.recipients) row.recipients = input.recipients;
  await row.save();
  return { type: row.type, offsets: row.offsets, enabled: row.enabled, recipients: row.recipients };
}

export async function listSms(raw: { page?: number; limit?: number }) {
  const query = listArgs(raw, ["createdAt"], "-createdAt");
  const [rows, total] = await Promise.all([
    SmsLog.find().sort(query.sort).skip(query.skip).limit(query.limit).lean(),
    SmsLog.countDocuments(),
  ]);
  return listResult(
    rows.map((row) => ({
      id: String(row._id),
      recipientMasked: row.recipientMasked,
      body: row.body,
      provider: row.provider,
      status: statusDto(row.status),
      sentAt: dateDto(row.sentAt),
      error: row.error ?? null,
      attempts: row.attempts,
    })),
    total,
    query,
  );
}

export async function applyDeliveryReport(payload: unknown) {
  const report = getSmsProvider().parseDeliveryReport(payload);
  if (!report.providerMessageId) throw new AppError(400, "VALIDATION_ERROR", "Missing provider message id");
  const parentCompany = requireCompanyId();
  const log = await SmsLog.findOne({ providerMessageId: report.providerMessageId, companyId: parentCompany });
  if (!log) throw notFound("SMS log");
  log.status = report.status;
  if (report.status === "delivered") log.deliveredAt = new Date();
  if (report.error) log.error = report.error.slice(0, 200);
  await log.save();
  return { id: String(log._id), status: log.status };
}

export async function retryFailedSms() {
  const failed = await SmsLog.find({ status: "failed", error: "SEND_FAILED", attempts: { $lt: 3 } }).limit(20);
  for (const log of failed) {
    const company = await Company.findById(requireCompanyId());
    if (!company || company.smsCredits <= 0) continue;
    try {
      const result = await getSmsProvider().send({
        to: decryptField(log.recipientEnc),
        body: log.body,
        sender: company.smsSenderName || env.SMS_SENDER,
      });
      const taken = await Company.updateOne({ _id: company._id, smsCredits: { $gt: 0 } }, { $inc: { smsCredits: -1 } });
      log.attempts += 1;
      if (taken.modifiedCount === 0) {
        log.status = "failed";
        log.error = "NO_CREDITS";
      } else {
        log.status = "sent";
        log.providerMessageId = result.providerMessageId;
        log.sentAt = new Date();
        log.error = undefined;
      }
      await log.save();
    } catch (error) {
      log.attempts += 1;
      log.status = "failed";
      log.error = "SEND_FAILED";
      await log.save();
      logger.error({ message: error instanceof Error ? error.message : "sms failed" }, "SMS retry failed");
    }
  }
}
