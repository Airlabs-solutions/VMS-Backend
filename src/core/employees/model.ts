import { Schema, model } from "mongoose";
import { auditPlugin } from "../../lib/auditPlugin";
import { tenantPlugin } from "../../lib/tenantPlugin";

const employeeSchema = new Schema(
  {
    employeeNumber: { type: String, required: true, trim: true },
    nameEn: { type: String, required: true, trim: true },
    nameAr: { type: String, trim: true, default: "" },
    mobileEnc: { type: String, required: true },
    mobileHash: { type: String, required: true },
    mobileLast4: { type: String, required: true },
    email: { type: String, lowercase: true, trim: true },
    iqamaEnc: { type: String, required: true },
    iqamaHash: { type: String, required: true },
    iqamaExpiry: { type: Date, required: true },
    passportEnc: { type: String },
    passportHash: { type: String },
    passportExpiry: { type: Date },
    borderNumberEnc: { type: String },
    borderNumberHash: { type: String },
    nationality: { type: String, default: "Saudi" },
    dateOfBirth: { type: Date },
    gender: { type: String, enum: ["male", "female"], default: "male" },
    jobTitle: { type: String, trim: true, default: "" },
    department: { type: String, trim: true, default: "" },
    branch: { type: String, trim: true, default: "" },
    employmentStatus: {
      type: String,
      enum: ["active", "on_leave", "probation", "terminated"],
      default: "active",
    },
    joinDate: { type: Date, default: Date.now },
    probationEndDate: { type: Date },
    photoId: { type: Schema.Types.ObjectId, ref: "FileAsset" },
    emergencyContact: {
      name: { type: String, trim: true, default: "" },
      relation: { type: String, trim: true, default: "" },
      mobile: { type: String, trim: true, default: "" },
    },
    assignedClientId: { type: Schema.Types.ObjectId, ref: "Client" },
    assignedProjectId: { type: Schema.Types.ObjectId, ref: "Project" },
    customFields: { type: Map, of: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

employeeSchema.plugin(tenantPlugin);
employeeSchema.plugin(auditPlugin);

employeeSchema.index({ companyId: 1, employeeNumber: 1 }, { unique: true });
employeeSchema.index({ companyId: 1, mobileHash: 1 }, { unique: true });
employeeSchema.index({ companyId: 1, iqamaHash: 1 }, { unique: true });
employeeSchema.index({ companyId: 1, employmentStatus: 1 });
employeeSchema.index({ companyId: 1, department: 1 });
employeeSchema.index({ companyId: 1, nationality: 1 });
employeeSchema.index({ companyId: 1, iqamaExpiry: 1 });

export const Employee = model("Employee", employeeSchema);
