import { Schema, model } from "mongoose";
import { LICENSE_TYPES } from "../../config/constants";
import { auditPlugin } from "../../lib/auditPlugin";
import { tenantPlugin } from "../../lib/tenantPlugin";

const driverSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    mobileEnc: { type: String, required: true },
    mobileHash: { type: String, required: true },
    mobileLast4: { type: String, required: true },
    employeeId: { type: String, trim: true },
    iqamaEnc: { type: String, required: true },
    iqamaHash: { type: String, required: true },
    iqamaExpiry: { type: Date, required: true },
    licenseNumberEnc: { type: String, required: true },
    licenseType: { type: String, enum: LICENSE_TYPES, required: true },
    licenseExpiry: { type: Date, required: true },
    fileIds: [{ type: Schema.Types.ObjectId, ref: "FileAsset" }],
    photoId: { type: Schema.Types.ObjectId, ref: "FileAsset" },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
  },
  { timestamps: true },
);
driverSchema.plugin(tenantPlugin);
driverSchema.plugin(auditPlugin);
driverSchema.index({ companyId: 1, mobileHash: 1 }, { unique: true });
driverSchema.index({ companyId: 1, iqamaHash: 1 }, { unique: true });
driverSchema.index({ companyId: 1, name: 1 });

const assignmentSchema = new Schema(
  {
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle", required: true },
    driverId: { type: Schema.Types.ObjectId, ref: "Driver", required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, default: null },
  },
  { timestamps: true },
);
assignmentSchema.plugin(tenantPlugin);
assignmentSchema.plugin(auditPlugin);
assignmentSchema.index(
  { companyId: 1, vehicleId: 1 },
  { unique: true, partialFilterExpression: { endDate: null } },
);
assignmentSchema.index(
  { companyId: 1, driverId: 1 },
  { unique: true, partialFilterExpression: { endDate: null } },
);
assignmentSchema.index({ companyId: 1, vehicleId: 1, startDate: 1, endDate: 1 });

const handoverSchema = new Schema(
  {
    assignmentId: { type: Schema.Types.ObjectId, ref: "Assignment" },
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle", required: true },
    fromDriverId: { type: Schema.Types.ObjectId, ref: "Driver" },
    toDriverId: { type: Schema.Types.ObjectId, ref: "Driver", required: true },
    date: { type: Date, required: true },
    odometerKm: { type: Number, required: true, min: 0 },
    fuelLevel: { type: String, trim: true },
    notes: { type: String, maxlength: 2000 },
    fileIds: [{ type: Schema.Types.ObjectId, ref: "FileAsset" }],
  },
  { timestamps: true },
);
handoverSchema.plugin(tenantPlugin);
handoverSchema.plugin(auditPlugin);
handoverSchema.index({ companyId: 1, vehicleId: 1, date: -1 });

export const Driver = model("Driver", driverSchema);
export const Assignment = model("Assignment", assignmentSchema);
export const Handover = model("Handover", handoverSchema);
