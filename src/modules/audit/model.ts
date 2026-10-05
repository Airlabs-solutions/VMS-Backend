import { Schema, model } from "mongoose";
import { getCtx } from "../../lib/context";

const auditSchema = new Schema({
  companyId: { type: Schema.Types.ObjectId, ref: "Company", index: true },
  actorId: { type: Schema.Types.ObjectId, ref: "User" },
  action: { type: String, enum: ["create", "update", "delete"], required: true },
  collectionName: { type: String, required: true },
  docId: { type: String },
  before: { type: Schema.Types.Mixed },
  after: { type: Schema.Types.Mixed },
  at: { type: Date, default: Date.now },
  ip: { type: String },
  supportGrantId: { type: String },
});

auditSchema.index({ companyId: 1, at: -1 });

auditSchema.pre("find", function scopeAudit() {
  const ctx = getCtx();
  if (ctx.companyId && !ctx.skipTenant && !ctx.internal) {
    this.where({ companyId: ctx.companyId });
  }
});

export const AuditLog = model("AuditLog", auditSchema);
