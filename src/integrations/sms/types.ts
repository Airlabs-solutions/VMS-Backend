export interface SmsSendInput {
  to: string;
  body: string;
  sender: string;
}

export interface DeliveryReport {
  providerMessageId: string;
  status: "delivered" | "failed";
  error?: string;
}

export interface SmsProvider {
  send(input: SmsSendInput): Promise<{ providerMessageId: string }>;
  parseDeliveryReport(payload: unknown): DeliveryReport;
}
