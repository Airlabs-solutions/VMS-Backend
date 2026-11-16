import { Schema, model } from "mongoose";
import { tenantPlugin } from "../../lib/tenantPlugin";

const roleSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: "Company" },
    key: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    permissions: [{ type: String, required: true }],
    isSystem: { type: Boolean, default: false },
  },
  { timestamps: true },
);

roleSchema.plugin(tenantPlugin);
roleSchema.index({ companyId: 1, key: 1 }, { unique: true });

export const RoleModel = model("Role", roleSchema);
