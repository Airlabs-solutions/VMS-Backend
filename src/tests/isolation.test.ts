import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createApp } from "../app";
import { requestContext } from "../lib/context";
import { hashPassword } from "../modules/auth/service";
import { Company } from "../modules/companies/model";
import { User } from "../modules/users/model";

let replSet: MongoMemoryReplSet;
const app = createApp();

async function csrfOf(agent: request.SuperAgentTest) {
  const response = await agent.post("/api/v1/auth/login").send({ email: "unused@example.com", password: "nope" });
  void response;
  const raw = agent.jar.getCookie("vms_admin_csrf", { domain: "127.0.0.1", path: "/", script: false, secure: false });
  return raw?.value;
}

describe("tenant isolation", () => {
  beforeAll(async () => {
    const cachedBin = path.resolve(process.cwd(), "node_modules/.cache/mongodb-memory-server/mongod-x64-darwin-7.0.24");
    const systemBinary = fs.existsSync(cachedBin) ? cachedBin : undefined;
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1 },
      ...(systemBinary ? { binary: { systemBinary } } : {}),
    });
    await mongoose.connect(replSet.getUri());
    const companyA = await Company.create({
      name: "Company A",
      maxVehicles: 50,
      modules: ["fleet", "hr", "equipment"],
      limits: { vehicles: 50, equipment: 50, employees: 50, adminSeats: 5, smsCredits: 10, storageMb: 1024 },
      status: "active",
      smsCredits: 10,
    });
    const companyB = await Company.create({
      name: "Company B",
      maxVehicles: 50,
      modules: ["fleet"],
      limits: { vehicles: 50, equipment: 50, employees: 50, adminSeats: 5, smsCredits: 10, storageMb: 1024 },
      status: "active",
      smsCredits: 10,
    });
    await User.create({
      companyId: companyA._id,
      role: "company_admin",
      name: "Admin A",
      email: "admin-a@example.com",
      passwordHash: await hashPassword("ChangeMe123"),
      status: "active",
    });
    await User.create({
      companyId: companyB._id,
      role: "company_admin",
      name: "Admin B",
      email: "admin-b@example.com",
      passwordHash: await hashPassword("ChangeMe123"),
      status: "active",
    });
  }, 180000);

  afterAll(async () => {
    await mongoose.disconnect();
    if (replSet) await replSet.stop();
  });

  it("hides vehicles from another company", async () => {
    const adminA = request.agent(app);
    const loginA = await adminA.post("/api/v1/auth/login").send({ email: "admin-a@example.com", password: "ChangeMe123" });
    expect(loginA.status).toBe(200);
    const csrf = loginA.body.data.csrfToken as string;
    const created = await adminA.post("/api/v1/vehicles").set("x-csrf-token", csrf).send({
      plateNumber: "AAA1111",
      make: "Toyota",
      model: "Yaris",
      year: 2024,
      color: "White",
      vin: "VINISOLATION0001",
      type: "sedan",
      ownership: "owned",
      odometerKm: 1000,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const vehicleId = created.body.data.id as string;

    const adminB = request.agent(app);
    const loginB = await adminB.post("/api/v1/auth/login").send({ email: "admin-b@example.com", password: "ChangeMe123" });
    expect(loginB.status).toBe(200);
    const csrfB = loginB.body.data.csrfToken as string;
    const list = await adminB.get("/api/v1/vehicles");
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);
    const getOne = await adminB.get(`/api/v1/vehicles/${vehicleId}`);
    expect(getOne.status).toBe(404);
    const update = await adminB.patch(`/api/v1/vehicles/${vehicleId}`).set("x-csrf-token", csrfB).send({ color: "Black" });
    expect(update.status).toBe(404);

    // Company B does NOT have HR or Equipment enabled -> must get 403 MODULE_NOT_ENABLED
    const hrDenied = await adminB.get("/api/v1/hr/employees");
    expect(hrDenied.status).toBe(403);
    const eqDenied = await adminB.get("/api/v1/equipment/assets");
    expect(eqDenied.status).toBe(403);

    // Company A has HR and Equipment enabled -> can create employee and equipment asset
    const empCreated = await adminA.post("/api/v1/hr/employees").set("x-csrf-token", csrf).send({
      employeeNumber: "EMP-001",
      nameEn: "Saad Al-Harbi",
      nationality: "Saudi Arabia",
      jobTitle: "Crane Operator",
      department: "Heavy Equipment",
      branch: "Riyadh HQ",
      joinDate: "2026-01-10",
      mobile: "+966511223344",
      iqamaNumber: "1029384756",
      iqamaExpiry: "2027-05-01",
    });
    expect(empCreated.status, JSON.stringify(empCreated.body)).toBe(201);

    const eqCreated = await adminA.post("/api/v1/equipment/assets").set("x-csrf-token", csrf).send({
      assetCode: "EQ-CRN-100",
      name: "Liebherr 60T Mobile Crane",
      categoryName: "Mobile Crane",
      make: "Liebherr",
      model: "LTM-1060",
      serialNumber: "SN-LTM1060",
      year: 2024,
      ownership: "owned",
      meterHours: 120,
    });
    expect(eqCreated.status, JSON.stringify(eqCreated.body)).toBe(201);
  });
});

void requestContext;
void csrfOf;
