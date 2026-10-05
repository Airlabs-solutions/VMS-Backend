import { Schema, model } from "mongoose";
import { INSTALLMENT_STATUSES } from "../../config/constants";
import { auditPlugin } from "../../lib/auditPlugin";
import { tenantPlugin } from "../../lib/tenantPlugin";

const planSchema = new Schema(
  {
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle", required: true },
    bank: { type: String, required: true, trim: true },
    loanAmountHalalas: { type: Number, required: true, min: 0 },
    downPaymentHalalas: { type: Number, required: true, min: 0 },
    monthlyAmountHalalas: { type: Number, required: true, min: 0 },
    tenureMonths: { type: Number, required: true, min: 1, max: 120 },
    startDate: { type: Date, required: true },
    dueDay: { type: Number, required: true, min: 1, max: 28 },
  },
  { timestamps: true },
);
planSchema.plugin(tenantPlugin);
planSchema.plugin(auditPlugin);
planSchema.index({ companyId: 1, vehicleId: 1 });

const installmentSchema = new Schema(
  {
    emiPlanId: { type: Schema.Types.ObjectId, ref: "EmiPlan", required: true },
    vehicleId: { type: Schema.Types.ObjectId, ref: "Vehicle", required: true },
    seq: { type: Number, required: true },
    dueDate: { type: Date, required: true },
    amountHalalas: { type: Number, required: true, min: 0 },
    status: { type: String, enum: INSTALLMENT_STATUSES, default: "unpaid" },
    paidDate: { type: Date },
  },
  { timestamps: true },
);
installmentSchema.plugin(tenantPlugin);
installmentSchema.plugin(auditPlugin);
installmentSchema.index({ companyId: 1, emiPlanId: 1, seq: 1 }, { unique: true });
installmentSchema.index({ companyId: 1, status: 1, dueDate: 1 });
installmentSchema.index({ companyId: 1, vehicleId: 1, dueDate: 1 });

export const EmiPlan = model("EmiPlan", planSchema);
export const EmiInstallment = model("EmiInstallment", installmentSchema);
