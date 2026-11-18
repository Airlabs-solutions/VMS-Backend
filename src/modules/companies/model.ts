import { Schema, model, type InferSchemaType } from "mongoose";
import { MODULES, SUBSCRIPTION_PLANS, SUBSCRIPTION_STATUSES } from "../../config/constants";

const companySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    status: { type: String, enum: ["active", "suspended"], default: "active" },
    modules: {
      type: [{ type: String, enum: MODULES }],
      default: ["fleet"],
    },
    limits: {
      vehicles: { type: Number, required: true, min: 1, default: 500 },
      equipment: { type: Number, required: true, min: 0, default: 0 },
      employees: { type: Number, required: true, min: 0, default: 0 },
      adminSeats: { type: Number, required: true, min: 1, default: 5 },
      smsCredits: { type: Number, required: true, min: 0, default: 0 },
      storageMb: { type: Number, required: true, min: 100, default: 5120 },
    },
    subscription: {
      plan: { type: String, enum: SUBSCRIPTION_PLANS, default: "starter" },
      status: { type: String, enum: SUBSCRIPTION_STATUSES, default: "active" },
      startsAt: { type: Date, default: Date.now },
      endsAt: { type: Date },
      notes: { type: String, default: "" },
    },
    // Retained for backward compatibility
    plan: { type: String, default: "standard" },
    maxVehicles: { type: Number, default: 500 },
    smsSenderName: { type: String, default: "AxetPro", maxlength: 11 },
    smsCredits: { type: Number, default: 0, min: 0 },
    driverPasswordLogin: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// Pre-save synchronization between legacy maxVehicles / smsCredits and limits
companySchema.pre("save", function syncLegacyFields(next) {
  if (this.limits) {
    if (this.isModified("limits.vehicles")) {
      this.maxVehicles = this.limits.vehicles;
    } else if (this.isModified("maxVehicles") && this.maxVehicles) {
      this.limits.vehicles = this.maxVehicles;
    }

    if (this.isModified("limits.smsCredits")) {
      this.smsCredits = this.limits.smsCredits;
    } else if (this.isModified("smsCredits") && this.smsCredits !== undefined) {
      this.limits.smsCredits = this.smsCredits;
    }
  }
  next();
});

const platformAuditLogSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    actorEmail: { type: String, required: true },
    targetCompanyId: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    action: { type: String, required: true },
    before: { type: Schema.Types.Mixed, required: true },
    after: { type: Schema.Types.Mixed, required: true },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

export type CompanyDoc = InferSchemaType<typeof companySchema> & { _id: Schema.Types.ObjectId };
export const Company = model("Company", companySchema);
export const PlatformAuditLog = model("PlatformAuditLog", platformAuditLogSchema);
