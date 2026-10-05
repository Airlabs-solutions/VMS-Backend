import { Schema, model } from "mongoose";
import { auditPlugin } from "../../lib/auditPlugin";
import { tenantPlugin } from "../../lib/tenantPlugin";

const grantSchema = new Schema(
  {
    grantedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    reason: { type: String, required: true, maxlength: 500 },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
  },
  { timestamps: true },
);

grantSchema.plugin(tenantPlugin);
grantSchema.plugin(auditPlugin);
grantSchema.index({ companyId: 1, expiresAt: -1 });

export const SupportGrant = model("SupportGrant", grantSchema);
