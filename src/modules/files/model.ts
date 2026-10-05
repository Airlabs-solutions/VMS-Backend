import { Schema, model } from "mongoose";
import { auditPlugin } from "../../lib/auditPlugin";
import { tenantPlugin } from "../../lib/tenantPlugin";

const fileSchema = new Schema(
  {
    key: { type: String, required: true },
    name: { type: String, required: true },
    mime: { type: String, required: true },
    size: { type: Number, required: true },
    module: { type: String, required: true },
  },
  { timestamps: true },
);
fileSchema.plugin(tenantPlugin);
fileSchema.plugin(auditPlugin);
fileSchema.index({ companyId: 1, createdAt: -1 });

export const FileAsset = model("FileAsset", fileSchema);
