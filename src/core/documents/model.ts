import { Schema, model } from "mongoose";
import { auditPlugin } from "../../lib/auditPlugin";
import { tenantPlugin } from "../../lib/tenantPlugin";

const complianceDocumentSchema = new Schema(
  {
    ownerRef: {
      kind: { type: String, enum: ["vehicle", "equipment", "employee"], required: true },
      id: { type: Schema.Types.ObjectId, required: true },
    },
    module: { type: String, enum: ["fleet", "equipment", "hr"], required: true },
    docType: { type: String, required: true, trim: true },
    number: { type: String, required: true, trim: true },
    issueDate: { type: Date },
    expiryDate: { type: Date, required: true },
    fileIds: [{ type: Schema.Types.ObjectId, ref: "FileAsset" }],
    isCurrent: { type: Boolean, default: true },
    metadata: { type: Map, of: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

complianceDocumentSchema.plugin(tenantPlugin);
complianceDocumentSchema.plugin(auditPlugin);

complianceDocumentSchema.index({ companyId: 1, "ownerRef.kind": 1, "ownerRef.id": 1, isCurrent: 1 });
complianceDocumentSchema.index({ companyId: 1, docType: 1, expiryDate: 1 });
complianceDocumentSchema.index({ companyId: 1, expiryDate: 1 });

export const ComplianceDocument = model("ComplianceDocument", complianceDocumentSchema);
