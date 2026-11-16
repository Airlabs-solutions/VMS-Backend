import { Schema, model } from "mongoose";
import { auditPlugin } from "../../lib/auditPlugin";
import { tenantPlugin } from "../../lib/tenantPlugin";

const assetRefSchema = new Schema(
  {
    kind: { type: String, enum: ["vehicle", "equipment"], default: "vehicle" },
    id: { type: Schema.Types.ObjectId, required: true },
  },
  { _id: false },
);

const scheduleSchema = new Schema(
  {
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle", index: true },
    assetRef: { type: assetRefSchema },
    serviceType: { type: String, required: true, trim: true },
    intervalMonths: { type: Number, required: true, min: 1 },
    intervalKm: { type: Number, default: 10000, min: 0 },
    intervalHours: { type: Number, min: 0 },
    lastServiceDate: { type: Date },
    lastServiceKm: { type: Number },
    lastServiceHours: { type: Number },
    nextDueDate: { type: Date, required: true },
    nextDueKm: { type: Number, default: 10000 },
    nextDueHours: { type: Number },
  },
  { timestamps: true },
);
scheduleSchema.plugin(tenantPlugin);
scheduleSchema.plugin(auditPlugin);
scheduleSchema.index({ companyId: 1, vehicleId: 1 });
scheduleSchema.index({ companyId: 1, "assetRef.kind": 1, "assetRef.id": 1 });
scheduleSchema.index({ companyId: 1, nextDueDate: 1 });

const logSchema = new Schema(
  {
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle" },
    assetRef: { type: assetRefSchema },
    scheduleId: { type: Schema.Types.ObjectId, ref: "MaintenanceSchedule" },
    date: { type: Date, required: true },
    odometerKm: { type: Number, default: 0, min: 0 },
    meterHours: { type: Number, default: 0, min: 0 },
    serviceType: { type: String, required: true, trim: true },
    workshop: { type: String, trim: true },
    costHalalas: { type: Number, required: true, min: 0 },
    notes: { type: String, maxlength: 2000 },
    fileIds: [{ type: Schema.Types.ObjectId, ref: "FileAsset" }],
  },
  { timestamps: true },
);
logSchema.plugin(tenantPlugin);
logSchema.plugin(auditPlugin);
logSchema.index({ companyId: 1, vehicleId: 1, date: -1 });
logSchema.index({ companyId: 1, "assetRef.kind": 1, "assetRef.id": 1, date: -1 });

export const MaintenanceSchedule = model("MaintenanceSchedule", scheduleSchema);
export const MaintenanceLog = model("MaintenanceLog", logSchema);
