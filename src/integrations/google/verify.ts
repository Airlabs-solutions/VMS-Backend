import { OAuth2Client } from "google-auth-library";
import { env } from "../../config/env";
import { AppError } from "../../lib/errors";

const client = new OAuth2Client();

export async function verifySuperAdminGoogle(idToken: string) {
  if (!env.GOOGLE_CLIENT_ID) {
    throw new AppError(503, "GOOGLE_NOT_CONFIGURED", "Google sign-in is not configured");
  }
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const email = payload?.email?.toLowerCase() ?? "";
    if (!payload || payload.email_verified !== true || !email) {
      throw new AppError(403, "GOOGLE_NOT_ALLOWED", "This Google account is not allowed");
    }
    return { email, name: payload.name?.trim() || "Platform Admin" };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(401, "INVALID_GOOGLE", "Google sign-in could not be verified");
  }
}
