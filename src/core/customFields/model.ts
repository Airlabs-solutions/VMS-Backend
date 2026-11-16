import { Schema, model } from "mongoose";
import { auditPlugin } from "../../lib/auditPlugin";
import { tenantPlugin } from "../../lib/tenantPlugin";

const customFieldDefinitionSchema = new Schema(
  {
    target: { type: String, enum: ["vehicle", "equipment", "employee"], required: true },
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    type: { type: String, enum: ["text", "number", "date", "dropdown"], required: true },
    options: [{ type: String, trim: true }],
    required: { type: Boolean, default: false },
  },
  { timestamps: true },
);

customFieldDefinitionSchema.plugin(tenantPlugin);
customFieldDefinitionSchema.plugin(auditPlugin);

customFieldDefinitionSchema.index({ companyId: 1, target: 1, key: 1 }, { unique: true });

export const CustomFieldDefinition = model("CustomFieldDefinition", customFieldDefinitionSchema);
