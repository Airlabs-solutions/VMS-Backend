import { Schema, model } from "mongoose";
import { FUEL_TYPES, OWNERSHIP_TYPES, VEHICLE_STATUSES, VEHICLE_TYPES } from "../../config/constants";
import { auditPlugin } from "../../lib/auditPlugin";
import { tenantPlugin } from "../../lib/tenantPlugin";

const vehicleSchema = new Schema(
  {
    name: { type: String, trim: true, default: "" },
    plateNumber: { type: String, required: true, uppercase: true, trim: true },
    make: { type: String, required: true, trim: true },
    modelName: { type: String, required: true, trim: true },
    year: { type: Number, required: true },
    color: { type: String, required: true, trim: true },
    fuelType: { type: String, enum: FUEL_TYPES, default: "petrol" },
    platePhotoId: { type: Schema.Types.ObjectId, ref: "FileAsset" },
    vehiclePhotoId: { type: Schema.Types.ObjectId, ref: "FileAsset" },
    photoIds: [{ type: Schema.Types.ObjectId, ref: "FileAsset" }],
    note: { type: String, trim: true, maxlength: 2000, default: "" },
    vin: { type: String, required: true, uppercase: true, trim: true },
    type: { type: String, enum: VEHICLE_TYPES, required: true },
    ownership: { type: String, enum: OWNERSHIP_TYPES, required: true },
    odometerKm: { type: Number, required: true, min: 0 },
    pucExpiry: { type: Date },
    fitnessExpiry: { type: Date },
    status: { type: String, enum: VEHICLE_STATUSES, default: "active" },
    currentDriverId: { type: Schema.Types.ObjectId, ref: "Driver" },
  },
  { timestamps: true },
);

vehicleSchema.plugin(tenantPlugin);
vehicleSchema.plugin(auditPlugin);
vehicleSchema.index({ companyId: 1, plateNumber: 1 }, { unique: true });
vehicleSchema.index({ companyId: 1, vin: 1 }, { unique: true });
vehicleSchema.index({ companyId: 1, status: 1 });

const importBatchSchema = new Schema(
  {
    rows: { type: [Schema.Types.Mixed], required: true },
    status: { type: String, enum: ["preview", "committed"], default: "preview" },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
importBatchSchema.plugin(tenantPlugin);
importBatchSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Vehicle = model("Vehicle", vehicleSchema);
export const ImportBatch = model("ImportBatch", importBatchSchema);
