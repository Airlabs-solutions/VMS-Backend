import { Schema, model } from "mongoose";

const userSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, ref: "Company", index: true },
    role: { type: String, enum: ["super_admin", "company_admin", "driver"], required: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, lowercase: true, trim: true, sparse: true, unique: true },
    mobileEnc: { type: String },
    mobileHash: { type: String },
    mobileLast4: { type: String },
    passwordHash: { type: String },
    driverId: { type: Schema.Types.ObjectId, ref: "Driver" },
    status: { type: String, enum: ["active", "inactive"], default: "active" },
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: { type: Date },
  },
  { timestamps: true },
);

userSchema.index({ companyId: 1, role: 1 });
userSchema.index({ mobileHash: 1 }, { unique: true, sparse: true });

export const User = model("User", userSchema);
