import { Schema, model } from "mongoose";
import { auditPlugin } from "../../lib/auditPlugin";
import { tenantPlugin } from "../../lib/tenantPlugin";

const transferItemSchema = new Schema(
  {
    fromSponsor: { type: String, required: true, trim: true },
    toSponsor: { type: String, required: true, trim: true },
    transferDate: { type: Date, required: true },
    referenceNumber: { type: String, trim: true, default: "" },
    notes: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const sponsorshipSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    sponsorName: { type: String, required: true, trim: true },
    sponsorFileNumber: { type: String, trim: true, default: "" },
    qiwaReference: { type: String, trim: true, default: "" },
    muqeemReference: { type: String, trim: true, default: "" },
    currentStatus: {
      type: String,
      enum: ["under_company", "transfer_pending", "transferred_out", "citizen"],
      default: "under_company",
    },
    transferHistory: { type: [transferItemSchema], default: [] },
  },
  { timestamps: true },
);
sponsorshipSchema.plugin(tenantPlugin);
sponsorshipSchema.plugin(auditPlugin);
sponsorshipSchema.index({ companyId: 1, employeeId: 1 }, { unique: true });

const contractSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    version: { type: Number, required: true, min: 1, default: 1 },
    isCurrent: { type: Boolean, default: true },
    contractType: { type: String, enum: ["fixed", "unlimited"], default: "fixed" },
    startDate: { type: Date, required: true },
    endDate: { type: Date },
    probationDays: { type: Number, default: 90, min: 0 },
    noticePeriodDays: { type: Number, default: 60, min: 0 },
    workingHoursPerWeek: { type: Number, default: 48, min: 1 },
    position: { type: String, required: true, trim: true },
    fileIds: [{ type: Schema.Types.ObjectId, ref: "FileAsset" }],
    notes: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);
contractSchema.plugin(tenantPlugin);
contractSchema.plugin(auditPlugin);
contractSchema.index({ companyId: 1, employeeId: 1, version: -1 });
contractSchema.index({ companyId: 1, isCurrent: 1, endDate: 1 });

const salaryStructureSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    effectiveDate: { type: Date, required: true },
    isCurrent: { type: Boolean, default: true },
    basicHalalas: { type: Number, required: true, min: 0 },
    housingHalalas: { type: Number, default: 0, min: 0 },
    transportHalalas: { type: Number, default: 0, min: 0 },
    otherAllowancesHalalas: { type: Number, default: 0, min: 0 },
    totalHalalas: { type: Number, required: true, min: 0 },
    commissionRule: { type: String, trim: true, default: "" },
    bankCode: { type: String, trim: true, default: "RJHI" },
    ibanEnc: { type: String, default: "" },
    ibanMasked: { type: String, default: "" },
    paymentMethod: {
      type: String,
      enum: ["wps_bank", "bank_transfer", "cash", "cheque"],
      default: "wps_bank",
    },
    notes: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);
salaryStructureSchema.plugin(tenantPlugin);
salaryStructureSchema.plugin(auditPlugin);
salaryStructureSchema.index({ companyId: 1, employeeId: 1, effectiveDate: -1 });

const employeeEventSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: "Employee", required: true },
    type: {
      type: String,
      enum: ["joined", "promoted", "transferred", "warning", "leave", "terminated"],
      required: true,
    },
    eventDate: { type: Date, required: true },
    title: { type: String, required: true, trim: true },
    notes: { type: String, trim: true, default: "" },
    fileIds: [{ type: Schema.Types.ObjectId, ref: "FileAsset" }],
  },
  { timestamps: true },
);
employeeEventSchema.plugin(tenantPlugin);
employeeEventSchema.plugin(auditPlugin);
employeeEventSchema.index({ companyId: 1, employeeId: 1, eventDate: -1 });

const hrLookupSchema = new Schema(
  {
    kind: { type: String, enum: ["department", "branch", "job_title"], required: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);
hrLookupSchema.plugin(tenantPlugin);
hrLookupSchema.plugin(auditPlugin);
hrLookupSchema.index({ companyId: 1, kind: 1, name: 1 }, { unique: true });

export const Sponsorship = model("HrSponsorship", sponsorshipSchema, "hr_sponsorships");
export const EmploymentContract = model("HrContract", contractSchema, "hr_contracts");
export const SalaryStructure = model("SalaryStructure", salaryStructureSchema, "hr_salary_structures");
export const EmployeeEvent = model("HrEmployeeEvent", employeeEventSchema, "hr_employee_events");
export const HrLookup = model("HrLookup", hrLookupSchema, "hr_lookups");
