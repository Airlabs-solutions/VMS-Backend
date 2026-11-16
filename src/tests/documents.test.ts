import { describe, expect, it } from "vitest";
import { parseDriverLicense, parseInsurance, parseIstimara } from "../modules/documents/parse";

describe("document reading", () => {
  it("reads an istimara number and both dates", () => {
    const fields = parseIstimara(`
      Vehicle registration
      Serial number: 2298113344
      Issue date 05/09/2025
      Expiry date 04/09/2026
    `);
    expect(fields.number).toBe("2298113344");
    expect(fields.issueDate).toBe("2025-09-05");
    expect(fields.expiryDate).toBe("2026-09-04");
  });

  it("reads Arabic-Indic digits on an istimara", () => {
    const fields = parseIstimara("رقم التسلسل: ٢٢٩٨١١٣٣٤٤ تاريخ الإصدار ٠٥/٠٩/٢٠٢٥ تاريخ الانتهاء ٠٤/٠٩/٢٠٢٦");
    expect(fields.number).toBe("2298113344");
    expect(fields.issueDate).toBe("2025-09-05");
    expect(fields.expiryDate).toBe("2026-09-04");
  });

  it("reads an insurance policy", () => {
    const fields = parseInsurance(`
      Tawuniya
      Policy number POL-883421
      Comprehensive
      Start 01/01/2026
      End 31/12/2026
      Premium SAR 2,450.00
    `);
    expect(fields).toMatchObject({
      policyNumber: "POL-883421",
      insurer: "Tawuniya",
      type: "comprehensive",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      premium: "2450.00",
    });
  });

  it("marks third party cover", () => {
    expect(parseInsurance("ضد الغير Policy POL991122").type).toBe("third_party");
  });

  it("returns empty fields when nothing can be read", () => {
    expect(parseIstimara("")).toEqual({ number: "", issueDate: "", expiryDate: "" });
    expect(parseInsurance("   ")).toEqual({
      policyNumber: "",
      insurer: "",
      type: "",
      startDate: "",
      endDate: "",
      premium: "",
    });
  });

  it("reads a Saudi driver license and iqama OCR text", () => {
    const fields = parseDriverLicense(`
      Driver Name: Rasool Khan
      Iqama No: 2346788987
      License No: 5467854367
      Type: Private Driving License
      Mobile: +966543678901
      Expiry Date: 04/11/2032
    `);
    expect(fields).toMatchObject({
      name: "Rasool Khan",
      iqamaNumber: "2346788987",
      licenseNumber: "5467854367",
      licenseType: "private",
      mobile: "+966543678901",
      licenseExpiry: "2032-11-04",
      iqamaExpiry: "2032-11-04",
    });
  });
});
