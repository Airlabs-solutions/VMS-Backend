import { Schema, model } from "mongoose";
import { auditPlugin } from "../../lib/auditPlugin";
import { tenantPlugin } from "../../lib/tenantPlugin";

const istimaraSchema = new Schema(
  {
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle", required: true },
    number: { type: String, required: true, trim: true },
    issueDate: { type: Date, required: true },
    expiryDate: { type: Date, required: true },
    fileIds: [{ type: Schema.Types.ObjectId, ref: "FileAsset" }],
  },
  { timestamps: true },
);
istimaraSchema.plugin(tenantPlugin);
istimaraSchema.plugin(auditPlugin);
istimaraSchema.index({ companyId: 1, vehicleId: 1, expiryDate: -1 });
istimaraSchema.index({ companyId: 1, expiryDate: 1 });

export const Istimara = model("Istimara", istimaraSchema);
