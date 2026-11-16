import { describe, expect, it } from "vitest";
import { decryptField, encryptField, hmacField } from "../lib/crypto";
import { hasPermission, resolveUserPermissions } from "../core/auth/permissions";
import {
  DOCUMENT_TYPE_REGISTRY,
  getDocumentTypeDefinition,
  listDocumentTypesForModule,
} from "../core/documents/registry";
import { invalidateEntitlementCache } from "../middleware/requireModule";
import { LocalStorageDriver } from "../core/storage/local";
import { S3StorageDriver } from "../core/storage/s3";
import { queueService } from "../core/queue";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

describe("Phase 0 - PII Encryption & Blind Indexing", () => {
  it("encrypts and decrypts sensitive PII accurately with AES-256-GCM", () => {
    const rawIqama = "2489110293";
    const encrypted = encryptField(rawIqama);

    expect(encrypted).not.toBe(rawIqama);
    expect(typeof encrypted).toBe("string");
    // Ensure ciphertext contains IV + auth tag + ciphertext in base64
    expect(Buffer.from(encrypted, "base64").length).toBeGreaterThan(28);

    const decrypted = decryptField(encrypted);
    expect(decrypted).toBe(rawIqama);
  });

  it("produces non-deterministic ciphertexts for the same plain value (unique IVs)", () => {
    const phone = "+966512345678";
    const enc1 = encryptField(phone);
    const enc2 = encryptField(phone);

    expect(enc1).not.toBe(enc2);
    expect(decryptField(enc1)).toBe(phone);
    expect(decryptField(enc2)).toBe(phone);
  });

  it("computes deterministic HMAC-SHA256 for blind indexing and search", () => {
    const rawIban = "SA0380000000608010167519";
    const hash1 = hmacField(rawIban);
    const hash2 = hmacField(rawIban);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA256 hex string
    expect(hash1).not.toBe(rawIban);
  });
});

describe("Phase 0 - RBAC & Permissions Engine", () => {
  it("grants super_admin unrestricted access across all permissions", async () => {
    const perms = await resolveUserPermissions("super_admin");
    expect(perms.length).toBeGreaterThan(20);
    expect(hasPermission(perms, "hr.salary.read")).toBe(true);
    expect(hasPermission(perms, "fleet.vehicle.write")).toBe(true);
    expect(hasPermission(perms, "equipment.asset.write")).toBe(true);
  });

  it("denies fleet_manager access to sensitive HR salaries and equipment", async () => {
    const perms = await resolveUserPermissions("fleet_manager");
    expect(hasPermission(perms, "fleet.vehicle.read")).toBe(true);
    expect(hasPermission(perms, "fleet.vehicle.write")).toBe(true);
    expect(hasPermission(perms, "compliance.document.read")).toBe(true);

    // Fleet manager must never see salaries or write equipment
    expect(hasPermission(perms, "hr.salary.read")).toBe(false);
    expect(hasPermission(perms, "hr.salary.write")).toBe(false);
    expect(hasPermission(perms, "equipment.asset.write")).toBe(false);
  });

  it("denies hr_manager access to fleet modifications", async () => {
    const perms = await resolveUserPermissions("hr_manager");
    expect(hasPermission(perms, "hr.employee.read")).toBe(true);
    expect(hasPermission(perms, "hr.employee.write")).toBe(true);
    expect(hasPermission(perms, "fleet.vehicle.write")).toBe(false);
    // HR manager does not have salary access unless payroll / salary is granted
    expect(hasPermission(perms, "hr.salary.read")).toBe(false);
  });

  it("restricts driver to vehicle read and fuel/trip submissions only", async () => {
    const perms = await resolveUserPermissions("driver");
    expect(hasPermission(perms, "fleet.vehicle.read")).toBe(true);
    expect(hasPermission(perms, "fleet.fuel.write")).toBe(true);
    expect(hasPermission(perms, "fleet.trip.write")).toBe(true);

    expect(hasPermission(perms, "fleet.vehicle.write")).toBe(false);
    expect(hasPermission(perms, "fleet.maintenance.write")).toBe(false);
    expect(hasPermission(perms, "hr.employee.read")).toBe(false);
  });

  it("supports domain wildcard matching", () => {
    expect(hasPermission(["fleet.*"], "fleet.vehicle.read")).toBe(true);
    expect(hasPermission(["fleet.*"], "fleet.maintenance.write")).toBe(true);
    expect(hasPermission(["fleet.*"], "hr.employee.read")).toBe(false);
  });
});

describe("Phase 0 - Compliance Document Type Registry", () => {
  it("registers standard document types per module", () => {
    const fleetTypes = listDocumentTypesForModule("fleet");
    expect(fleetTypes.map((d) => d.type)).toContain("istimara");
    expect(fleetTypes.map((d) => d.type)).toContain("insurance");

    const equipTypes = listDocumentTypesForModule("equipment");
    expect(equipTypes.map((d) => d.type)).toContain("tuv_card");
    expect(equipTypes.map((d) => d.type)).toContain("inspection_certificate");

    const hrTypes = listDocumentTypesForModule("hr");
    expect(hrTypes.map((d) => d.type)).toContain("iqama");
    expect(hrTypes.map((d) => d.type)).toContain("passport");
  });

  it("provides correct alert offsets and recipients", () => {
    const istimara = getDocumentTypeDefinition("istimara");
    expect(istimara?.defaultOffsets).toEqual([30, 15, 7, 0]);
    expect(istimara?.defaultRecipients).toEqual(["admin"]);

    const iqama = getDocumentTypeDefinition("iqama");
    expect(iqama?.defaultOffsets).toEqual([30, 7]);
    expect(iqama?.defaultRecipients).toEqual(["admin", "driver"]);
  });
});

describe("Phase 0 - Entitlement Cache Management", () => {
  it("allows safe cache invalidation without throwing", () => {
    expect(() => invalidateEntitlementCache("company-123")).not.toThrow();
    expect(() => invalidateEntitlementCache()).not.toThrow();
  });
});

describe("Phase 0 - Local & S3 Storage Abstractions", () => {
  it("writes, reads, and deletes files via LocalStorageDriver", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vms-storage-test-"));
    const driver = new LocalStorageDriver(tempDir);

    const testBuffer = Buffer.from("VMS Document Storage Test Content");
    const testKey = "comp_1/fleet/documents/test-doc.pdf";

    const saveRes = await driver.save(testKey, testBuffer);
    expect(saveRes.storageKey).toBe(testKey);
    expect(saveRes.size).toBe(testBuffer.length);

    const exists = await driver.exists(testKey);
    expect(exists).toBe(true);

    const readRes = await driver.read(testKey);
    const chunks: Buffer[] = [];
    for await (const chunk of readRes.stream) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString("utf8")).toBe("VMS Document Storage Test Content");

    const url = await driver.getSignedUrl(testKey);
    expect(url).toContain(encodeURIComponent(testKey));

    await driver.delete(testKey);
    expect(await driver.exists(testKey)).toBe(false);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("generates AWS SigV4 presigned URLs with S3StorageDriver", async () => {
    const driver = new S3StorageDriver({
      bucket: "vms-vault",
      region: "me-central-1",
      endpoint: "https://s3.me-central-1.amazonaws.com",
      accessKey: "AKIAIOSFODNN7EXAMPLE",
      secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      forcePathStyle: true,
    });

    const signedUrl = await driver.getSignedUrl("comp_1/fleet/documents/istimara.pdf", 900);
    expect(signedUrl).toContain("https://s3.me-central-1.amazonaws.com/vms-vault/comp_1/fleet/documents/istimara.pdf");
    expect(signedUrl).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(signedUrl).toContain("X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F");
    expect(signedUrl).toContain("X-Amz-Expires=900");
    expect(signedUrl).toContain("X-Amz-Signature=");
  });
});

describe("Phase 0 - Asynchronous Queue Processing", () => {
  it("enqueues and processes background jobs with handlers", async () => {
    const processed: string[] = [];
    queueService.registerHandler<{ title: string; count: number }>("test-queue", async (job) => {
      processed.push(`${job.data.title}:${job.data.count}`);
    });

    await queueService.add("test-queue", "job-1", { title: "Alert", count: 1 });
    await queueService.add("test-queue", "job-2", { title: "SMS", count: 2 });

    // Wait short interval for in-memory worker tick
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(processed).toContain("Alert:1");
    expect(processed).toContain("SMS:2");

    await queueService.drain();
  });
});
