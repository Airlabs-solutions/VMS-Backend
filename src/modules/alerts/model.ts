import { Schema, model } from "mongoose";
import { ALERT_TYPES } from "../../config/constants";
import { auditPlugin } from "../../lib/auditPlugin";
import { tenantPlugin } from "../../lib/tenantPlugin";

const ruleSchema = new Schema(
  {
    type: { type: String, enum: ALERT_TYPES, required: true },
    offsets: { type: [Number], required: true },
    enabled: { type: Boolean, default: true },
    recipients: { type: [String], default: ["admin"] },
  },
  { timestamps: true },
);
ruleSchema.plugin(tenantPlugin);
ruleSchema.plugin(auditPlugin);
ruleSchema.index({ companyId: 1, type: 1 }, { unique: true });

const alertSchema = new Schema(
  {
    type: { type: String, enum: ALERT_TYPES, required: true },
    entityRef: { type: String, required: true },
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle" },
    driverId: { type: Schema.Types.ObjectId, ref: "Driver" },
    dueDate: { type: Date },
    offset: { type: Number, required: true },
    status: { type: String, enum: ["open", "dismissed"], default: "open" },
    dedupeKey: { type: String, required: true },
    message: { type: String, required: true },
  },
  { timestamps: true },
);
alertSchema.plugin(tenantPlugin);
alertSchema.plugin(auditPlugin);
alertSchema.index({ companyId: 1, dedupeKey: 1 }, { unique: true });
alertSchema.index({ companyId: 1, status: 1, createdAt: -1 });

const smsSchema = new Schema(
  {
    alertId: { type: Schema.Types.ObjectId, ref: "Alert" },
    recipientEnc: { type: String, required: true },
    recipientMasked: { type: String, required: true },
    body: { type: String, required: true },
    provider: { type: String, required: true },
    providerMessageId: { type: String },
    status: { type: String, enum: ["queued", "sent", "delivered", "failed"], default: "queued" },
    sentAt: { type: Date },
    deliveredAt: { type: Date },
    error: { type: String },
    attempts: { type: Number, default: 0 },
  },
  { timestamps: true },
);
smsSchema.plugin(tenantPlugin);
smsSchema.index({ companyId: 1, createdAt: -1 });
smsSchema.index({ status: 1, attempts: 1 });

const lockSchema = new Schema({
  name: { type: String, required: true, unique: true },
  lockedUntil: { type: Date, required: true },
  owner: { type: String, required: true },
});

export const AlertRule = model("AlertRule", ruleSchema);
export const Alert = model("Alert", alertSchema);
export const SmsLog = model("SmsLog", smsSchema);
export const JobLock = model("JobLock", lockSchema);
