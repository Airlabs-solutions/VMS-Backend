import { ALERT_DEFAULTS, ALERT_TYPES, SUPER_ADMIN_EMAIL } from "./config/constants";
import { requestContext } from "./lib/context";
import { connectDb, disconnectDb } from "./lib/db";
import { AlertRule } from "./modules/alerts/model";
import { Company } from "./modules/companies/model";
import { User } from "./modules/users/model";

export async function seedDatabase() {
  await User.updateMany(
    { role: "super_admin", email: { $ne: SUPER_ADMIN_EMAIL } },
    { $set: { status: "inactive" }, $unset: { passwordHash: "" } },
  );
  let admin = await User.findOne({ email: SUPER_ADMIN_EMAIL });
  if (!admin) {
    admin = await User.create({
      role: "super_admin",
      name: "Platform Admin",
      email: SUPER_ADMIN_EMAIL,
      status: "active",
    });
  } else {
    await User.updateOne(
      { _id: admin._id },
      { $set: { role: "super_admin", status: "active" }, $unset: { passwordHash: "", companyId: "", driverId: "" } },
    );
  }

  let company = await Company.findOne({ status: "active" }).sort({ createdAt: 1 });
  if (!company) {
    company = await Company.create({
      name: "Fleet",
      status: "active",
      plan: "standard",
      maxVehicles: 500,
      smsSenderName: "VMS",
      smsCredits: 0,
      driverPasswordLogin: false,
    });
  }

  await requestContext.run({ companyId: String(company._id), userId: String(admin._id), skipTenant: false }, async () => {
    for (const type of ALERT_TYPES) {
      const defaults = ALERT_DEFAULTS[type];
      const exists = await AlertRule.findOne({ type });
      if (!exists) {
        await AlertRule.create({ type, offsets: defaults.offsets, enabled: true, recipients: defaults.recipients });
      }
    }
  });

  console.log("Super admin account is ready");
}

export async function runSeed() {
  await connectDb();
  try {
    await seedDatabase();
  } finally {
    await disconnectDb();
  }
}

if (require.main === module) {
  runSeed().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Seed failed");
    process.exit(1);
  });
}
