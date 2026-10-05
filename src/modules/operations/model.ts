import { Schema, model } from "mongoose";
import { EXPENSE_CATEGORIES, FUEL_APPROVAL, VIOLATION_STATUSES } from "../../config/constants";
import { auditPlugin } from "../../lib/auditPlugin";
import { tenantPlugin } from "../../lib/tenantPlugin";

const fuelSchema = new Schema(
  {
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle", required: true },
    driverId: { type: Schema.Types.ObjectId, ref: "Driver" },
    date: { type: Date, required: true },
    liters: { type: Number, required: true, min: 0 },
    costHalalas: { type: Number, required: true, min: 0 },
    odometerKm: { type: Number, required: true, min: 0 },
    station: { type: String, trim: true },
    fileIds: [{ type: Schema.Types.ObjectId, ref: "FileAsset" }],
    approvalStatus: { type: String, enum: FUEL_APPROVAL, default: "approved" },
  },
  { timestamps: true },
);
fuelSchema.plugin(tenantPlugin);
fuelSchema.plugin(auditPlugin);
fuelSchema.index({ companyId: 1, vehicleId: 1, date: -1 });

const violationSchema = new Schema(
  {
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle", required: true },
    driverId: { type: Schema.Types.ObjectId, ref: "Driver" },
    number: { type: String, required: true, trim: true },
    date: { type: Date, required: true },
    type: { type: String, required: true, trim: true },
    amountHalalas: { type: Number, required: true, min: 0 },
    status: { type: String, enum: VIOLATION_STATUSES, default: "unpaid" },
    deductFromDriver: { type: Boolean, default: false },
  },
  { timestamps: true },
);
violationSchema.plugin(tenantPlugin);
violationSchema.plugin(auditPlugin);
violationSchema.index({ companyId: 1, number: 1 }, { unique: true });
violationSchema.index({ companyId: 1, vehicleId: 1, date: -1 });
violationSchema.index({ companyId: 1, status: 1 });

const tripSchema = new Schema(
  {
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle", required: true },
    driverId: { type: Schema.Types.ObjectId, ref: "Driver" },
    date: { type: Date, required: true },
    startLocation: { type: String, required: true, trim: true },
    endLocation: { type: String, required: true, trim: true },
    startKm: { type: Number, required: true, min: 0 },
    endKm: { type: Number, required: true, min: 0 },
    distanceKm: { type: Number, required: true, min: 0 },
    purpose: { type: String, trim: true },
  },
  { timestamps: true },
);
tripSchema.plugin(tenantPlugin);
tripSchema.plugin(auditPlugin);
tripSchema.index({ companyId: 1, vehicleId: 1, date: -1 });

const expenseSchema = new Schema(
  {
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle", required: true },
    category: { type: String, enum: EXPENSE_CATEGORIES, required: true },
    amountHalalas: { type: Number, required: true, min: 0 },
    date: { type: Date, required: true },
    notes: { type: String, maxlength: 2000 },
    fileIds: [{ type: Schema.Types.ObjectId, ref: "FileAsset" }],
  },
  { timestamps: true },
);
expenseSchema.plugin(tenantPlugin);
expenseSchema.plugin(auditPlugin);
expenseSchema.index({ companyId: 1, vehicleId: 1, date: -1 });
expenseSchema.index({ companyId: 1, category: 1, date: -1 });

export const FuelLog = model("FuelLog", fuelSchema);
export const Violation = model("Violation", violationSchema);
export const Trip = model("Trip", tripSchema);
export const Expense = model("Expense", expenseSchema);
