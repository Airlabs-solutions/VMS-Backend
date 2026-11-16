import type { Module } from "../../config/constants";

export interface DocumentTypeDefinition {
  type: string;
  module: Module;
  target: "vehicle" | "equipment" | "employee";
  label: string;
  defaultOffsets: number[];
  defaultRecipients: Array<"admin" | "driver">;
  requiresNumber?: boolean;
}

export const DOCUMENT_TYPE_REGISTRY: Record<string, DocumentTypeDefinition> = {
  // Fleet Documents
  istimara: {
    type: "istimara",
    module: "fleet",
    target: "vehicle",
    label: "Istimara",
    defaultOffsets: [30, 15, 7, 0],
    defaultRecipients: ["admin"],
    requiresNumber: true,
  },
  insurance: {
    type: "insurance",
    module: "fleet",
    target: "vehicle",
    label: "Insurance",
    defaultOffsets: [30, 15, 7, 0],
    defaultRecipients: ["admin"],
    requiresNumber: true,
  },

  // Equipment Documents
  tuv_card: {
    type: "tuv_card",
    module: "equipment",
    target: "equipment",
    label: "TUV Card",
    defaultOffsets: [30, 15, 7, 0],
    defaultRecipients: ["admin"],
    requiresNumber: true,
  },
  inspection_certificate: {
    type: "inspection_certificate",
    module: "equipment",
    target: "equipment",
    label: "Third-Party Inspection Certificate",
    defaultOffsets: [30, 15, 7, 0],
    defaultRecipients: ["admin"],
  },
  calibration_certificate: {
    type: "calibration_certificate",
    module: "equipment",
    target: "equipment",
    label: "Calibration Certificate",
    defaultOffsets: [30, 15, 7, 0],
    defaultRecipients: ["admin"],
  },
  operating_permit: {
    type: "operating_permit",
    module: "equipment",
    target: "equipment",
    label: "Operating Permit",
    defaultOffsets: [30, 15, 7, 0],
    defaultRecipients: ["admin"],
  },
  equipment_istimara: {
    type: "equipment_istimara",
    module: "equipment",
    target: "equipment",
    label: "Equipment Registration (Istimara)",
    defaultOffsets: [30, 15, 7, 0],
    defaultRecipients: ["admin"],
  },
  equipment_insurance: {
    type: "equipment_insurance",
    module: "equipment",
    target: "equipment",
    label: "Equipment Insurance",
    defaultOffsets: [30, 15, 7, 0],
    defaultRecipients: ["admin"],
  },

  // HR / Employee Documents
  iqama: {
    type: "iqama",
    module: "hr",
    target: "employee",
    label: "Iqama",
    defaultOffsets: [30, 7],
    defaultRecipients: ["admin", "driver"],
    requiresNumber: true,
  },
  passport: {
    type: "passport",
    module: "hr",
    target: "employee",
    label: "Passport",
    defaultOffsets: [60, 30],
    defaultRecipients: ["admin"],
    requiresNumber: true,
  },
  border_number: {
    type: "border_number",
    module: "hr",
    target: "employee",
    label: "Border Number",
    defaultOffsets: [30, 7],
    defaultRecipients: ["admin"],
    requiresNumber: true,
  },
  visa: {
    type: "visa",
    module: "hr",
    target: "employee",
    label: "Visa",
    defaultOffsets: [30, 7],
    defaultRecipients: ["admin"],
  },
  exit_reentry_permit: {
    type: "exit_reentry_permit",
    module: "hr",
    target: "employee",
    label: "Exit & Re-entry Permit",
    defaultOffsets: [15, 7, 3],
    defaultRecipients: ["admin"],
  },
  medical_insurance: {
    type: "medical_insurance",
    module: "hr",
    target: "employee",
    label: "Medical Insurance",
    defaultOffsets: [30, 15, 7],
    defaultRecipients: ["admin"],
  },
  driving_license: {
    type: "driving_license",
    module: "fleet",
    target: "employee",
    label: "Driving License",
    defaultOffsets: [30, 7],
    defaultRecipients: ["admin", "driver"],
  },
  professional_certificate: {
    type: "professional_certificate",
    module: "hr",
    target: "employee",
    label: "Professional / Operator Certificate",
    defaultOffsets: [30, 15, 7],
    defaultRecipients: ["admin"],
  },
};

export function getDocumentTypeDefinition(type: string): DocumentTypeDefinition | undefined {
  return DOCUMENT_TYPE_REGISTRY[type];
}

export function listDocumentTypesForModule(moduleName: Module): DocumentTypeDefinition[] {
  return Object.values(DOCUMENT_TYPE_REGISTRY).filter((d) => d.module === moduleName);
}
