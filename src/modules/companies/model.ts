import { Schema, model, type InferSchemaType } from "mongoose";

const companySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    status: { type: String, enum: ["active", "suspended"], default: "active" },
    plan: { type: String, default: "standard" },
    maxVehicles: { type: Number, required: true, min: 1, max: 500 },
    smsSenderName: { type: String, default: "VMS" },
    smsCredits: { type: Number, default: 0, min: 0 },
    driverPasswordLogin: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export type CompanyDoc = InferSchemaType<typeof companySchema> & { _id: Schema.Types.ObjectId };
export const Company = model("Company", companySchema);
