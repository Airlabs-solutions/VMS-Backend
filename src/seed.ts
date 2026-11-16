import { ALERT_DEFAULTS, ALERT_TYPES, ROLE_DEFAULT_PERMISSIONS, ROLES, SUPER_ADMIN_EMAIL } from "./config/constants";
import { RoleModel } from "./core/auth/roleModel";
import { requestContext } from "./lib/context";
import { connectDb, disconnectDb } from "./lib/db";
import { AlertRule } from "./modules/alerts/model";
import { Company } from "./modules/companies/model";
import { User } from "./modules/users/model";
import { HrLookup } from "./modules/hr/model";
import { EquipmentCategory } from "./modules/equipment/model";

export async function seedDatabase() {
  const allowedSuperEmails = Array.from(new Set([SUPER_ADMIN_EMAIL, "info@airlabss.com", "ismailthalithanooji@gmail.com"]));
  await User.updateMany(
    { role: "super_admin", email: { $nin: allowedSuperEmails } },
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
      modules: ["fleet", "hr", "equipment"],
      limits: {
        vehicles: 500,
        equipment: 200,
        employees: 500,
        adminSeats: 5,
        smsCredits: 0,
        storageMb: 5120,
      },
      subscription: {
        plan: "enterprise",
        status: "active",
        startsAt: new Date(),
        notes: "Default seed company",
      },
      plan: "standard",
      maxVehicles: 500,
      smsSenderName: "VMS",
      smsCredits: 0,
      driverPasswordLogin: false,
    });
  } else {
    let changed = false;
    if (!company.modules || company.modules.length === 0 || (company.name === "Fleet" && company.modules.length === 1)) {
      company.modules = ["fleet", "hr", "equipment"] as any;
      changed = true;
    }
    if (!company.limits) {
      company.limits = {
        vehicles: company.maxVehicles || 500,
        equipment: 200,
        employees: 500,
        adminSeats: 5,
        smsCredits: company.smsCredits || 0,
        storageMb: 5120,
      };
      changed = true;
    } else if (company.name === "Fleet" && (company.limits.employees === 0 || company.limits.equipment === 0)) {
      if (company.limits.employees === 0) company.limits.employees = 500;
      if (company.limits.equipment === 0) company.limits.equipment = 200;
      changed = true;
    }
    if (changed) await company.save();
  }

  await requestContext.run({ companyId: String(company._id), userId: String(admin._id), skipTenant: false }, async () => {
    // Seed Alert Rules
    for (const type of ALERT_TYPES) {
      const defaults = ALERT_DEFAULTS[type];
      const exists = await AlertRule.findOne({ type });
      if (!exists) {
        await AlertRule.create({ type, offsets: defaults.offsets, enabled: true, recipients: defaults.recipients });
      }
    }

    // Seed System Roles
    for (const roleKey of ROLES) {
      if (roleKey === "super_admin") continue;
      const permissions = ROLE_DEFAULT_PERMISSIONS[roleKey];
      const exists = await RoleModel.findOne({ key: roleKey });
      if (!exists) {
        await RoleModel.create({
          key: roleKey,
          name: roleKey.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
          description: `System role for ${roleKey}`,
          permissions,
          isSystem: true,
        });
      }
    }

    // Seed Default HR Lookups
    const defaultLookups: Array<{ kind: "department" | "branch" | "job_title"; name: string; code: string }> = [
      { kind: "department", name: "Operations", code: "OPS" },
      { kind: "department", name: "Logistics & Fleet", code: "LOG" },
      { kind: "department", name: "Heavy Equipment", code: "EQP" },
      { kind: "department", name: "Human Resources", code: "HR" },
      { kind: "branch", name: "Riyadh HQ", code: "RUH" },
      { kind: "branch", name: "Dammam Yard", code: "DMM" },
      { kind: "branch", name: "Jeddah Branch", code: "JED" },
      { kind: "job_title", name: "Heavy Truck Driver", code: "DRV-HVY" },
      { kind: "job_title", name: "Crane Operator", code: "OPR-CRN" },
      { kind: "job_title", name: "Fleet Supervisor", code: "SUP-FLT" },
      { kind: "job_title", name: "HR Specialist", code: "HRS-01" },
    ];
    for (const item of defaultLookups) {
      const exists = await HrLookup.findOne({ kind: item.kind, name: item.name });
      if (!exists) {
        await HrLookup.create(item);
      }
    }

    // Seed Default Equipment Categories
    const defaultCategories: Array<{
      name: string;
      meterType: "hours" | "km" | "both";
      requiredDocTypes: string[];
      defaultChecklist: Array<{ label: string; critical: boolean }>;
    }> = [
      {
        name: "Mobile Crane",
        meterType: "both",
        requiredDocTypes: ["tuv_card", "inspection_certificate", "equipment_insurance"],
        defaultChecklist: [
          { label: "Hydraulic boom & cylinders free of leaks", critical: true },
          { label: "Load moment indicator (LMI) calibrated & functional", critical: true },
          { label: "Wire rope & hook block condition", critical: true },
          { label: "Outriggers & stabilizers functional", critical: true },
          { label: "Fire extinguisher & cabin safety", critical: false },
        ],
      },
      {
        name: "Excavator",
        meterType: "hours",
        requiredDocTypes: ["inspection_certificate", "equipment_insurance"],
        defaultChecklist: [
          { label: "Track tension & undercarriage condition", critical: false },
          { label: "Hydraulic hoses & bucket pins secure", critical: true },
          { label: "Engine oil & coolant levels", critical: false },
          { label: "Emergency stop & travel alarm", critical: true },
        ],
      },
      {
        name: "Forklift",
        meterType: "hours",
        requiredDocTypes: ["tuv_card", "inspection_certificate"],
        defaultChecklist: [
          { label: "Forks & mast chain integrity", critical: true },
          { label: "Service & parking brake test", critical: true },
          { label: "Horn, beacon & reverse alarm", critical: false },
        ],
      },
      {
        name: "Diesel Generator",
        meterType: "hours",
        requiredDocTypes: ["calibration_certificate", "inspection_certificate"],
        defaultChecklist: [
          { label: "Fuel & oil leak check", critical: true },
          { label: "Output voltage & frequency stability", critical: true },
          { label: "Battery & automatic transfer switch", critical: false },
        ],
      },
    ];
    for (const cat of defaultCategories) {
      const exists = await EquipmentCategory.findOne({ name: cat.name });
      if (!exists) {
        await EquipmentCategory.create(cat);
      }
    }
  });

  console.log("Super admin account and system roles are ready");
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
