import { hmacField } from "./crypto";
import { AppError } from "./errors";
import { normalizeSaudiMobile } from "./phone";
import { Driver } from "../modules/drivers/model";
import { User } from "../modules/users/model";

export async function assertMobileAvailable(mobileRaw: string, except?: { driverId?: string; userId?: string }) {
  const mobile = normalizeSaudiMobile(mobileRaw);
  const mobileHash = hmacField(mobile);
  const driverQuery: Record<string, unknown> = { mobileHash };
  if (except?.driverId) driverQuery._id = { $ne: except.driverId };
  const driver = await Driver.findOne(driverQuery).setOptions({ skipTenant: true }).select("_id");
  if (driver) throw new AppError(409, "DUPLICATE", "This phone number is already used by a driver");

  const admin = await User.findOne({
    mobileHash,
    role: { $in: ["company_admin", "super_admin"] },
    ...(except?.userId ? { _id: { $ne: except.userId } } : {}),
  }).select("_id");
  if (admin) throw new AppError(409, "DUPLICATE", "This phone number is already used by an admin");

  const otherLogin = await User.findOne({
    mobileHash,
    role: "driver",
    ...(except?.driverId ? { driverId: { $ne: except.driverId } } : {}),
  }).select("_id");
  if (otherLogin) throw new AppError(409, "DUPLICATE", "This phone number is already used by a driver");
}
