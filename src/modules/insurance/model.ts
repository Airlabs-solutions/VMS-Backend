import { Schema, model } from "mongoose";
import { CLAIM_STATUSES, INSURANCE_TYPES } from "../../config/constants";
import { auditPlugin } from "../../lib/auditPlugin";
import { tenantPlugin } from "../../lib/tenantPlugin";

const policySchema = new Schema(
  {
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle", required: true },
    policyNumber: { type: String, required: true, trim: true },
    insurer: { type: String, required: true, trim: true },
    type: { type: String, enum: INSURANCE_TYPES, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    premiumHalalas: { type: Number, required: true, min: 0 },
    fileIds: [{ type: Schema.Types.ObjectId, ref: "FileAsset" }],
  },
  { timestamps: true },
);
policySchema.plugin(tenantPlugin);
policySchema.plugin(auditPlugin);
policySchema.index({ companyId: 1, vehicleId: 1, endDate: -1 });
policySchema.index({ companyId: 1, endDate: 1 });

const claimSchema = new Schema(
  {
    policyId: { type: Schema.Types.ObjectId, ref: "InsurancePolicy", required: true },
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle", required: true },
    claimDate: { type: Date, required: true },
    description: { type: String, required: true, maxlength: 2000 },
    amountHalalas: { type: Number, required: true, min: 0 },
    status: { type: String, enum: CLAIM_STATUSES, default: "submitted" },
    fileIds: [{ type: Schema.Types.ObjectId, ref: "FileAsset" }],
  },
  { timestamps: true },
);
claimSchema.plugin(tenantPlugin);
claimSchema.plugin(auditPlugin);
claimSchema.index({ companyId: 1, vehicleId: 1, claimDate: -1 });

export const InsurancePolicy = model("InsurancePolicy", policySchema);
export const InsuranceClaim = model("InsuranceClaim", claimSchema);
