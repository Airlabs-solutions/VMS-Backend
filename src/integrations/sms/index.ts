import { randomUUID } from "node:crypto";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { maskMobile } from "../../lib/phone";
import type { SmsProvider } from "./types";

function digits(mobile: string): string {
  return mobile.replace(/\D/g, "");
}

function readReport(payload: unknown) {
  const body = (payload ?? {}) as { messageId?: string; id?: string; status?: string; error?: string };
  const ok = body.status === "delivered" || body.status === "success";
  return {
    providerMessageId: body.messageId ?? body.id ?? "",
    status: ok ? ("delivered" as const) : ("failed" as const),
    error: body.error,
  };
}

class LogSmsProvider implements SmsProvider {
  async send(input: { to: string; body: string; sender: string }) {
    logger.info({ to: maskMobile(input.to), sender: input.sender }, "SMS queued with the log provider");
    if (!env.isProduction) logger.info({ body: input.body }, "SMS body");
    return { providerMessageId: `log-${randomUUID()}` };
  }
  parseDeliveryReport(payload: unknown) {
    return readReport(payload);
  }
}

class UnifonicProvider implements SmsProvider {
  async send(input: { to: string; body: string; sender: string }) {
    const url = env.SMS_API_URL || "https://el.cloud.unifonic.com/rest/SMS/messages";
    const body = new URLSearchParams({
      AppSid: env.SMS_API_KEY || "",
      SenderID: input.sender,
      Body: input.body,
      Recipient: digits(input.to),
    });
    const response = await fetch(url, { method: "POST", body });
    if (!response.ok) throw new Error("Unifonic rejected the message");
    const json = (await response.json()) as { data?: { MessageID?: string } };
    return { providerMessageId: json.data?.MessageID ?? randomUUID() };
  }
  parseDeliveryReport(payload: unknown) {
    return readReport(payload);
  }
}

class TaqnyatProvider implements SmsProvider {
  async send(input: { to: string; body: string; sender: string }) {
    const url = env.SMS_API_URL || "https://api.taqnyat.sa/v1/messages";
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SMS_API_KEY || ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ recipients: [digits(input.to)], body: input.body, sender: input.sender }),
    });
    if (!response.ok) throw new Error("Taqnyat rejected the message");
    const json = (await response.json()) as { messageId?: string };
    return { providerMessageId: json.messageId ?? randomUUID() };
  }
  parseDeliveryReport(payload: unknown) {
    return readReport(payload);
  }
}

class MsegatProvider implements SmsProvider {
  async send(input: { to: string; body: string; sender: string }) {
    const url = env.SMS_API_URL || "https://www.msegat.com/gw/sendsms.php";
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userName: env.SMS_SENDER,
        apiKey: env.SMS_API_KEY || "",
        numbers: digits(input.to),
        userSender: input.sender,
        msg: input.body,
      }),
    });
    if (!response.ok) throw new Error("Msegat rejected the message");
    const json = (await response.json()) as { id?: string };
    return { providerMessageId: json.id ?? randomUUID() };
  }
  parseDeliveryReport(payload: unknown) {
    return readReport(payload);
  }
}

export function getSmsProvider(): SmsProvider {
  switch (env.SMS_PROVIDER) {
    case "unifonic":
      return new UnifonicProvider();
    case "taqnyat":
      return new TaqnyatProvider();
    case "msegat":
      return new MsegatProvider();
    default:
      return new LogSmsProvider();
  }
}
