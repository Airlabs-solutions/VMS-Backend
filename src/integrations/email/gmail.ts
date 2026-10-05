import nodemailer from "nodemailer";
import { SUPER_ADMIN_EMAIL } from "../../config/constants";
import { env } from "../../config/env";
import { AppError } from "../../lib/errors";
import { logger } from "../../lib/logger";

/** Sends the sign-in code through Gmail. Returns false when mail is not configured outside production. */
export async function sendSuperAdminCode(code: string, to = SUPER_ADMIN_EMAIL) {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) {
    if (!env.isProduction) return false;
    throw new AppError(503, "EMAIL_NOT_CONFIGURED", "Sign-in email is not configured");
  }
  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD },
  });
  try {
    await transport.sendMail({
      from: env.GMAIL_USER,
      to,
      subject: "VMS super admin sign-in code",
      text: `Your VMS super admin sign-in code is ${code}. It expires in 5 minutes. If you did not request this, you can ignore this email.`,
    });
    return true;
  } catch (error) {
    logger.error({ message: error instanceof Error ? error.message : "email failed" }, "Super admin email failed");
    throw new AppError(503, "EMAIL_FAILED", "The sign-in code could not be sent");
  }
}
