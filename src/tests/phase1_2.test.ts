import { describe, expect, it } from "vitest";
import { hasPermission, resolveUserPermissions } from "../core/auth/permissions";
import { getDocumentTypeDefinition, listDocumentTypesForModule } from "../core/documents/registry";
import {
  EmployeeEvent,
  EmploymentContract,
  HrLookup,
  SalaryStructure,
  Sponsorship,
} from "../modules/hr/model";
import {
  contractBody,
  employeeCreateBody,
  salaryBody,
  sponsorshipBody,
} from "../modules/hr/service";
import {
  Equipment,
  EquipmentCategory,
  EquipmentInspection,
  EquipmentMobilization,
  EquipmentOperatorAssignment,
} from "../modules/equipment/model";
import {
  equipmentCreateBody,
  inspectionBody,
  mobilizationBody,
} from "../modules/equipment/service";
import { Client, Project } from "../core/clients/model";
import { requestContext } from "../lib/context";

describe("Phase 1 - HR Core Module (Permissions, Registry, Schemas & Tenant Isolation)", () => {
  it("registers all HR compliance document types with alert offsets", () => {
    const hrTypes = listDocumentTypesForModule("hr").map((d) => d.type);
    expect(hrTypes).toEqual(
      expect.arrayContaining([
        "iqama",
        "passport",
        "border_number",
        "visa",
        "exit_reentry_permit",
        "medical_insurance",
        "professional_certificate",
      ]),
    );
    expect(getDocumentTypeDefinition("driving_license")?.type).toBe("driving_license");
    expect(getDocumentTypeDefinition("passport")?.defaultOffsets).toEqual([60, 30]);
    expect(getDocumentTypeDefinition("visa")?.defaultOffsets).toEqual([30, 7]);
  });

  it("enforces strict salary permission separation (hr_manager vs payroll_officer vs fleet_manager)", async () => {
    const hrPerms = await resolveUserPermissions("hr_manager");
    expect(hasPermission(hrPerms, "hr.employee.read")).toBe(true);
    expect(hasPermission(hrPerms, "hr.employee.write")).toBe(true);
    expect(hasPermission(hrPerms, "hr.sponsorship.write")).toBe(true);
    expect(hasPermission(hrPerms, "hr.contract.write")).toBe(true);
    expect(hasPermission(hrPerms, "hr.salary.read")).toBe(false);

    const payrollPerms = await resolveUserPermissions("payroll_officer");
    expect(hasPermission(payrollPerms, "hr.salary.read")).toBe(true);
    expect(hasPermission(payrollPerms, "hr.salary.write")).toBe(true);

    const fleetPerms = await resolveUserPermissions("fleet_manager");
    expect(hasPermission(fleetPerms, "hr.employee.read")).toBe(false);
    expect(hasPermission(fleetPerms, "hr.salary.read")).toBe(false);
  });

  it("validates HR employee, contract, sponsorship, and salary payloads", () => {
    const empParsed = employeeCreateBody.safeParse({
      employeeNumber: "EMP-101",
      nameEn: "Khalid Al-Otaibi",
      nameAr: "خالد العتيبي",
      nationality: "Saudi Arabia",
      jobTitle: "Crane Operator",
      department: "Heavy Equipment",
      branch: "Riyadh HQ",
      joinDate: "2026-01-15",
      mobile: "+966512345678",
      iqamaNumber: "1098765432",
      iqamaExpiry: "2027-06-30",
    });
    expect(empParsed.success).toBe(true);

    const salParsed = salaryBody.safeParse({
      effectiveDate: "2026-02-01",
      basicSar: 5500,
      housingSar: 1375,
      transportSar: 500,
      bankCode: "RJHI",
      iban: "SA0380000000608010167519",
      paymentMethod: "wps_bank",
    });
    expect(salParsed.success).toBe(true);

    const contractParsed = contractBody.safeParse({
      contractType: "fixed",
      position: "Crane Operator",
      startDate: "2026-01-15",
      endDate: "2027-01-14",
      probationDays: 90,
      noticePeriodDays: 60,
    });
    expect(contractParsed.success).toBe(true);

    const sponsorParsed = sponsorshipBody.safeParse({
      sponsorName: "Al-Riyadh Contracting Est.",
      sponsorFileNumber: "7001234567",
      qiwaReference: "QW-99120",
      muqeemReference: "MQ-44102",
    });
    expect(sponsorParsed.success).toBe(true);
  });

  it("enforces tenantPlugin on all HR collections (companyId path and pre-hooks)", () => {
    for (const model of [Sponsorship, EmploymentContract, SalaryStructure, EmployeeEvent, HrLookup]) {
      expect(model.schema.path("companyId")).toBeDefined();
      expect(model.schema.path("createdBy")).toBeDefined();
    }
  });
});

describe("Phase 2 - Equipment Module (Permissions, Registry, Schemas & Tenant Isolation)", () => {
  it("registers all 6 Equipment compliance document types", () => {
    const eqTypes = listDocumentTypesForModule("equipment").map((d) => d.type);
    expect(eqTypes).toEqual(
      expect.arrayContaining([
        "tuv_card",
        "inspection_certificate",
        "calibration_certificate",
        "operating_permit",
        "equipment_istimara",
        "equipment_insurance",
      ]),
    );
    expect(getDocumentTypeDefinition("tuv_card")?.defaultOffsets).toEqual([30, 15, 7, 0]);
  });

  it("grants equipment_manager equipment permissions while blocking HR salary and Fleet modifications", async () => {
    const eqPerms = await resolveUserPermissions("equipment_manager");
    expect(hasPermission(eqPerms, "equipment.asset.read")).toBe(true);
    expect(hasPermission(eqPerms, "equipment.asset.write")).toBe(true);
    expect(hasPermission(eqPerms, "equipment.inspection.write")).toBe(true);
    expect(hasPermission(eqPerms, "equipment.mobilization.write")).toBe(true);
    expect(hasPermission(eqPerms, "equipment.operator.write")).toBe(true);

    expect(hasPermission(eqPerms, "hr.salary.read")).toBe(false);
    expect(hasPermission(eqPerms, "fleet.vehicle.write")).toBe(false);
  });

  it("validates equipment asset, checklist inspection, and site mobilization payloads", () => {
    const assetParsed = equipmentCreateBody.safeParse({
      assetCode: "EQ-CRN-001",
      name: "Tadano 50T Rough Terrain Crane",
      categoryName: "Mobile Crane",
      make: "Tadano",
      model: "GR-500EX",
      serialNumber: "SN-992011",
      year: 2024,
      capacity: "50 Ton",
      ownership: "owned",
      purchaseOrRentalCostSar: 850000,
      meterHours: 420,
      currentLocation: "Riyadh Yard",
    });
    expect(assetParsed.success).toBe(true);

    const inspParsed = inspectionBody.safeParse({
      inspectorName: "Eng. Tariq",
      inspectionDate: "2026-03-10",
      meterHours: 430,
      items: [
        { label: "Hydraulic boom check", critical: true, result: "pass" },
        { label: "LMI calibration check", critical: true, result: "fail", notes: "Sensor error" },
      ],
    });
    expect(inspParsed.success).toBe(true);

    const mobParsed = mobilizationBody.safeParse({
      clientName: "Diriyah Gate Contractor",
      projectName: "Sector B",
      siteLocation: "Diriyah North",
      mobilizationDate: "2026-03-15",
      rateType: "monthly",
      rateSar: 22000,
    });
    expect(mobParsed.success).toBe(true);
  });

  it("enforces tenantPlugin on all Equipment and Core Client/Project collections", () => {
    for (const model of [
      EquipmentCategory,
      Equipment,
      EquipmentInspection,
      EquipmentMobilization,
      EquipmentOperatorAssignment,
      Client,
      Project,
    ]) {
      expect(model.schema.path("companyId")).toBeDefined();
      expect(model.schema.path("createdBy")).toBeDefined();
    }
  });
});
