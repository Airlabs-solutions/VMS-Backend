import pino from "pino";
import { env } from "../config/env";

export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : env.NODE_ENV === "development" ? "debug" : "info",
  redact: {
    paths: [
      "req.headers.cookie",
      "req.headers.authorization",
      "password",
      "passwordHash",
      "mobile",
      "iqamaNumber",
      "licenseNumber",
      "code",
    ],
    remove: true,
  },
});

export function redactMessage(message: string): string {
  return message.replace(/\+?\d{8,}/g, "[redacted]");
}
