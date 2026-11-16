import { Schema, model } from "mongoose";
import { auditPlugin } from "../../lib/auditPlugin";
import { tenantPlugin } from "../../lib/tenantPlugin";

const checklistTemplateItemSchema = new Schema(
  {
    label: { type: String, required: true, trim: true },
    critical: { type: Boolean, default: false },
  },
  { _id: false },
);

const equipmentCategorySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    meterType: { type: String, enum: ["hours", "km", "both"], default: "hours" },
    requiredDocTypes: { type: [String], default: ["tuv_card", "inspection_certificate", "equipment_insurance"] },
    defaultChecklist: {
      type: [checklistTemplateItemSchema],
      default: [
        { label: "Hydraulic lines and fluid levels free of leaks", critical: true },
        { label: "Emergency stop and safety limit switches operational", critical: true },
        { label: "Brakes, steering, and horn working properly", critical: true },
        { label: "Fire extinguisher charged and inspection tag valid", critical: false },
        { label: "Lights, beacons, and reverse alarm functional", critical: false },
      ],
    },
    defaultMaintenance: {
      serviceType: { type: String, default: "250-Hour Preventive Service" },
      intervalMonths: { type: Number, default: 3 },
      intervalHours: { type: Number, default: 250 },
      intervalKm: { type: Number, default: 5000 },
    },
  },
  { timestamps: true },
);
equipmentCategorySchema.plugin(tenantPlugin);
equipmentCategorySchema.plugin(auditPlugin);
equipmentCategorySchema.index({ companyId: 1, name: 1 }, { unique: true });

const equipmentSchema = new Schema(
  {
    assetCode: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    categoryId: { type: Schema.Types.ObjectId, ref: "EquipmentCategory" },
    categoryName: { type: String, required: true, trim: true },
    make: { type: String, required: true, trim: true },
    model: { type: String, required: true, trim: true },
    serialNumber: { type: String, required: true, trim: true },
    year: { type: Number, required: true, min: 1980, max: 2100 },
    capacity: { type: String, trim: true, default: "" },
    ownership: {
      type: String,
      enum: ["owned", "rented_in", "rented_out"],
      default: "owned",
    },
    supplierOrLessor: { type: String, trim: true, default: "" },
    purchaseOrRentalCostHalalas: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ["available", "mobilized", "in_maintenance", "inactive", "sold"],
      default: "available",
    },
    meterHours: { type: Number, default: 0, min: 0 },
    odometerKm: { type: Number, default: 0, min: 0 },
    currentLocation: { type: String, trim: true, default: "Main Yard" },
    photoIds: [{ type: Schema.Types.ObjectId, ref: "FileAsset" }],
    customFields: { type: Map, of: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);
equipmentSchema.plugin(tenantPlugin);
equipmentSchema.plugin(auditPlugin);
equipmentSchema.index({ companyId: 1, assetCode: 1 }, { unique: true });
equipmentSchema.index({ companyId: 1, status: 1 });
equipmentSchema.index({ companyId: 1, categoryName: 1 });

const inspectionItemResultSchema = new Schema(
  {
    label: { type: String, required: true, trim: true },
    critical: { type: Boolean, default: false },
    result: { type: String, enum: ["pass", "fail", "na"], required: true },
    notes: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const equipmentInspectionSchema = new Schema(
  {
    equipmentId: { type: Schema.Types.ObjectId, ref: "Equipment", required: true },
    inspectorName: { type: String, required: true, trim: true },
    inspectionDate: { type: Date, required: true },
    nextDueDate: { type: Date, required: true },
    meterHours: { type: Number, default: 0, min: 0 },
    odometerKm: { type: Number, default: 0, min: 0 },
    items: { type: [inspectionItemResultSchema], required: true },
    overallResult: { type: String, enum: ["pass", "fail"], required: true },
    autoMaintenanceTriggered: { type: Boolean, default: false },
    signatureText: { type: String, trim: true, default: "" },
    notes: { type: String, trim: true, default: "" },
    fileIds: [{ type: Schema.Types.ObjectId, ref: "FileAsset" }],
  },
  { timestamps: true },
);
equipmentInspectionSchema.plugin(tenantPlugin);
equipmentInspectionSchema.plugin(auditPlugin);
equipmentInspectionSchema.index({ companyId: 1, equipmentId: 1, inspectionDate: -1 });
equipmentInspectionSchema.index({ companyId: 1, nextDueDate: 1 });

const mobilizationSchema = new Schema(
  {
    equipmentId: { type: Schema.Types.ObjectId, ref: "Equipment", required: true },
    clientId: { type: Schema.Types.ObjectId, ref: "Client" },
    projectId: { type: Schema.Types.ObjectId, ref: "Project" },
    clientName: { type: String, required: true, trim: true },
    projectName: { type: String, trim: true, default: "" },
    siteLocation: { type: String, required: true, trim: true },
    mobilizationDate: { type: Date, required: true },
    demobilizationDate: { type: Date },
    rateType: { type: String, enum: ["hourly", "daily", "monthly"], default: "daily" },
    rateHalalas: { type: Number, required: true, min: 0 },
    operatorName: { type: String, trim: true, default: "" },
    operatorEmployeeId: { type: Schema.Types.ObjectId, ref: "Employee" },
    status: { type: String, enum: ["planned", "active", "completed"], default: "active" },
    notes: { type: String, trim: true, default: "" },
    fileIds: [{ type: Schema.Types.ObjectId, ref: "FileAsset" }],
  },
  { timestamps: true },
);
mobilizationSchema.plugin(tenantPlugin);
mobilizationSchema.plugin(auditPlugin);
mobilizationSchema.index({ companyId: 1, equipmentId: 1, mobilizationDate: -1 });
mobilizationSchema.index({ companyId: 1, status: 1, demobilizationDate: 1 });

const operatorAssignmentSchema = new Schema(
  {
    equipmentId: { type: Schema.Types.ObjectId, ref: "Equipment", required: true },
    employeeId: { type: Schema.Types.ObjectId, ref: "Employee" },
    operatorName: { type: String, required: true, trim: true },
    operatorMobile: { type: String, trim: true, default: "" },
    licenseOrCertNumber: { type: String, trim: true, default: "" },
    startDate: { type: Date, required: true },
    endDate: { type: Date },
    status: { type: String, enum: ["active", "completed"], default: "active" },
    complianceVerified: { type: Boolean, default: true },
    notes: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);
operatorAssignmentSchema.plugin(tenantPlugin);
operatorAssignmentSchema.plugin(auditPlugin);
operatorAssignmentSchema.index({ companyId: 1, equipmentId: 1, startDate: -1 });

export const EquipmentCategory = model("EquipmentCategory", equipmentCategorySchema, "equipment_categories");
export const Equipment = model("Equipment", equipmentSchema, "equipment");
export const EquipmentInspection = model("EquipmentInspection", equipmentInspectionSchema, "equipment_inspections");
export const EquipmentMobilization = model("EquipmentMobilization", mobilizationSchema, "equipment_mobilizations");
export const EquipmentOperatorAssignment = model("EquipmentOperatorAssignment", operatorAssignmentSchema, "equipment_operator_assignments");
