import { Schema, model } from "mongoose";
import { auditPlugin } from "../../lib/auditPlugin";
import { tenantPlugin } from "../../lib/tenantPlugin";

const messageSchema = new Schema(
  {
    driverId: { type: Schema.Types.ObjectId, ref: "Driver", required: true },
    senderRole: { type: String, enum: ["admin", "driver"], default: "admin" },
    body: { type: String, default: "", maxlength: 500 },
    fileIds: [{ type: Schema.Types.ObjectId, ref: "FileAsset" }],
    readByDriverAt: { type: Date },
  },
  { timestamps: true },
);

messageSchema.plugin(tenantPlugin);
messageSchema.plugin(auditPlugin);
messageSchema.index({ companyId: 1, createdAt: -1 });
messageSchema.index({ companyId: 1, driverId: 1, createdAt: 1 });

export const DirectMessage = model("DirectMessage", messageSchema);
