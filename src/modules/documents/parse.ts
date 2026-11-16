const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EXTENDED_ARABIC = "۰۱۲۳۴۵۶۷۸۹";

export type IstimaraFields = {
  number: string;
  issueDate: string;
  expiryDate: string;
};

export type InsuranceFields = {
  policyNumber: string;
  insurer: string;
  type: "" | "comprehensive" | "third_party";
  startDate: string;
  endDate: string;
  premium: string;
};

export type DriverLicenseFields = {
  name: string;
  mobile: string;
  iqamaNumber: string;
  iqamaExpiry: string;
  licenseNumber: string;
  licenseType: "" | "private" | "light_transport" | "heavy" | "motorcycle" | "other";
  licenseExpiry: string;
};

const INSURERS: Array<[RegExp, string]> = [
  [/tawuniya|التعاونية/i, "Tawuniya"],
  [/medgulf|ميدغلف/i, "Medgulf"],
  [/walaa|ولاء/i, "Walaa"],
  [/rajhi|الراجحي/i, "Al Rajhi"],
  [/acig/i, "ACIG"],
  [/malath|ملاذ/i, "Malath"],
  [/salama|سلامة/i, "Salama"],
  [/bupa|بوبا/i, "Bupa"],
  [/allianz|أليانز/i, "Allianz"],
  [/\bgig\b/i, "GIG"],
  [/saico/i, "SAICO"],
  [/wataniya/i, "Wataniya"],
  [/\baxa\b/i, "AXA"],
  [/chubb/i, "Chubb"],
];

type Dated = { iso: string; index: number; raw: string };

export function normalizeDocumentText(value: string) {
  return value
    .replace(/[٠-٩]/g, (digit) => String(ARABIC_INDIC.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String(EXTENDED_ARABIC.indexOf(digit)))
    .replace(/[\u200e\u200f]/g, " ");
}

function isoDate(year: number, month: number, day: number) {
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return "";
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function findDates(text: string): Dated[] {
  const found: Dated[] = [];
  const pattern = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b|\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/g;
  for (const match of text.matchAll(pattern)) {
    const iso = match[1]
      ? isoDate(Number(match[1]), Number(match[2]), Number(match[3]))
      : isoDate(Number(match[6]), Number(match[5]), Number(match[4]));
    if (!iso) continue;
    found.push({ iso, index: match.index ?? 0, raw: match[0] });
  }
  return found;
}

function labeledDate(text: string, dates: Dated[], labels: RegExp) {
  const hit = dates.find((date) => labels.test(text.slice(Math.max(0, date.index - 48), date.index)));
  return hit?.iso ?? "";
}

function pairDates(text: string, dates: Dated[], startLabels: RegExp, endLabels: RegExp) {
  const unique = [...new Map(dates.map((date) => [date.iso, date])).values()].sort((left, right) => left.iso.localeCompare(right.iso));
  let start = labeledDate(text, dates, startLabels);
  let end = labeledDate(text, dates, endLabels);
  if (start && end && start > end) {
    const swap = start;
    start = end;
    end = swap;
  }
  if (!start && !end && unique.length >= 2) {
    start = unique[0].iso;
    end = unique[unique.length - 1].iso;
  } else if (!end && unique.length === 1) {
    end = unique[0].iso;
  } else if (!start && unique.length >= 2) {
    start = unique.find((date) => date.iso !== end)?.iso ?? "";
  } else if (!end && unique.length >= 2) {
    end = [...unique].reverse().find((date) => date.iso !== start)?.iso ?? "";
  }
  return { start, end };
}

function cleanToken(value: string) {
  return value.replace(/^[#:.\-\s]+|[#:.\-\s]+$/g, "").slice(0, 40);
}

export function parseIstimara(raw: string): IstimaraFields {
  const text = normalizeDocumentText(raw);
  const dates = findDates(text);
  const { start, end } = pairDates(
    text,
    dates,
    /issue|issued|start|اصدار|إصدار|الإصدار/i,
    /expir|expire|valid until|end|انتهاء|الانتهاء|نهاية/i,
  );
  const labeled = text.match(/(?:serial(?:\s+number)?|sequence|istimara|registration|رقم\s*التسلسل|التسلسل|الاستمارة)\s*[:#-]?\s*([A-Z0-9-]*\d[A-Z0-9-]{4,19})/i);
  let number = labeled ? cleanToken(labeled[1]) : "";
  if (!number) {
    const used = new Set(dates.map((date) => date.raw.replace(/\D/g, "")));
    const runs = [...text.matchAll(/\d{6,12}/g)].map((match) => match[0]);
    number = runs.find((run) => !used.has(run) && run.length >= 8) ?? runs.find((run) => !used.has(run)) ?? "";
  }
  return { number, issueDate: start, expiryDate: end };
}

export function parseInsurance(raw: string): InsuranceFields {
  const text = normalizeDocumentText(raw);
  const dates = findDates(text);
  const { start, end } = pairDates(
    text,
    dates,
    /start|from|effective|issue|بداية|اصدار|إصدار/i,
    /end|expir|until|valid to|انتهاء|الانتهاء|نهاية/i,
  );
  const policy = text.match(/(?:policy(?:\s*(?:no\.?|number))?|رقم\s*الوثيقة|الوثيقة)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/-]{4,29})/i);
  const premiumMatch = text.match(/(?:premium|قسط|amount)\s*[:#-]?\s*(?:SAR|sar|ر\.?\s*س\.?)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i)
    ?? text.match(/(?:SAR|sar|ر\.?\s*س\.?)\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i);
  const premium = premiumMatch ? premiumMatch[1].replace(/,/g, "") : "";
  const insurer = INSURERS.find(([pattern]) => pattern.test(text))?.[1] ?? "";
  let type: InsuranceFields["type"] = "";
  if (/third\s*party|ضد الغير|tpl/i.test(text)) type = "third_party";
  else if (/comprehensive|شامل/i.test(text)) type = "comprehensive";
  return {
    policyNumber: policy ? cleanToken(policy[1]) : "",
    insurer,
    type,
    startDate: start,
    endDate: end,
    premium: /^\d+(\.\d{1,2})?$/.test(premium) ? premium : "",
  };
}

export function parseDriverLicense(raw: string): DriverLicenseFields {
  const text = normalizeDocumentText(raw);
  const dates = findDates(text);
  const { start, end } = pairDates(
    text,
    dates,
    /issue|issued|start|اصدار|إصدار|الإصدار/i,
    /expir|expire|valid|end|انتهاء|الانتهاء|نهاية/i,
  );

  // Extract 10-digit Saudi ID / Iqama numbers (starting with 1 or 2)
  const tenDigitMatches = [...text.matchAll(/\b([12]\d{9})\b/g)].map((m) => m[1]);
  const iqamaNumber = tenDigitMatches[0] ?? "";

  // Extract license number: either explicitly labeled or fallback to second 10-digit / 8-12 digit number or iqamaNumber
  const labeledLic = text.match(
    /(?:licen[cs]e(?:\s*(?:no\.?|number|id))?|رقم\s*الرخصة|الرخصة)\s*[:#-]?\s*([A-Z0-9-]{5,20})/i,
  );
  let licenseNumber = labeledLic ? cleanToken(labeledLic[1]) : "";
  if (!licenseNumber) {
    const otherRuns = [...text.matchAll(/\b(\d{8,12})\b/g)].map((m) => m[1]);
    licenseNumber = otherRuns.find((r) => r !== iqamaNumber) ?? iqamaNumber;
  }

  // Extract name from English or Arabic label (single line)
  const nameMatch =
    text.match(/(?:driver\s*name|full\s*name|holder\s*name|name)\s*[:#-]?\s*([A-Za-z][A-Za-z \t.'-]{2,50})/i) ??
    text.match(/(?:الاسم|اسم\s*السائق)\s*[:#-]?\s*([^\n\r:0-9]{3,50})/i);
  const name = nameMatch ? nameMatch[1].trim().replace(/\s+/g, " ") : "";

  // Extract mobile if present
  const mobileMatch = text.match(/(?:^|[\s:])((?:\+966|00966|966|0)?5\d{8})\b/);
  const mobile = mobileMatch ? mobileMatch[1] : "";

  // Extract license type
  let licenseType: DriverLicenseFields["licenseType"] = "";
  if (/heavy|نقل\s*ثقيل|عمومي\s*ثقيل/i.test(text)) licenseType = "heavy";
  else if (/light\s*transport|public|نقل\s*خفيف|عمومي/i.test(text)) licenseType = "light_transport";
  else if (/motor\s*cycle|دراجة/i.test(text)) licenseType = "motorcycle";
  else if (/private|خاصة|خصوصي/i.test(text)) licenseType = "private";

  const expiry = end || start || "";

  return {
    name,
    mobile,
    iqamaNumber,
    iqamaExpiry: expiry,
    licenseNumber,
    licenseType,
    licenseExpiry: expiry,
  };
}

export function fieldsFound(fields: IstimaraFields | InsuranceFields | DriverLicenseFields) {
  return Object.values(fields).some((value) => value !== "");
}
