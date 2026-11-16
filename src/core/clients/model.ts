import { Schema, model } from "mongoose";
import { auditPlugin } from "../../lib/auditPlugin";
import { tenantPlugin } from "../../lib/tenantPlugin";

const clientSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true },
    contactPerson: { type: String, trim: true, default: "" },
    mobile: { type: String, trim: true, default: "" },
    email: { type: String, lowercase: true, trim: true, default: "" },
    city: { type: String, trim: true, default: "Riyadh" },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
  },
  { timestamps: true },
);

clientSchema.plugin(tenantPlugin);
clientSchema.plugin(auditPlugin);
clientSchema.index({ companyId: 1, code: 1 }, { unique: true });
clientSchema.index({ companyId: 1, name: 1 });

const projectSchema = new Schema(
  {
    clientId: { type: Schema.Types.ObjectId, ref: "Client", required: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true },
    siteLocation: { type: String, required: true, trim: true },
    startDate: { type: Date },
    endDate: { type: Date },
    status: { type: String, enum: ["active", "completed", "on_hold"], default: "active" },
  },
  { timestamps: true },
);

projectSchema.plugin(tenantPlugin);
projectSchema.plugin(auditPlugin);
projectSchema.index({ companyId: 1, clientId: 1 });
projectSchema.index({ companyId: 1, code: 1 }, { unique: true });

export const Client = model("Client", clientSchema);
export const Project = model("Project", projectSchema);
