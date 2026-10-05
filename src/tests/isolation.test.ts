import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri());
    const companyA = await Company.create({ name: "Company A", maxVehicles: 50, status: "active", smsCredits: 10 });
    const companyB = await Company.create({ name: "Company B", maxVehicles: 50, status: "active", smsCredits: 10 });
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
  });
});

void requestContext;
void csrfOf;
