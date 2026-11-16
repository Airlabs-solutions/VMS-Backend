import { createHash, createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { AppError } from "../../lib/errors";
import type { FileStorageProvider, StorageReadResult } from "./types";

export interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKey?: string;
  secretKey?: string;
  forcePathStyle?: boolean;
}

export class S3StorageDriver implements FileStorageProvider {
  private readonly bucket: string;
  private readonly region: string;
  private readonly endpoint: string;
  private readonly accessKey: string;
  private readonly secretKey: string;
  private readonly forcePathStyle: boolean;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    this.region = config.region || "me-central-1";
    this.endpoint = config.endpoint || `https://s3.${this.region}.amazonaws.com`;
    this.accessKey = config.accessKey || "";
    this.secretKey = config.secretKey || "";
    this.forcePathStyle = config.forcePathStyle ?? true;
  }

  private sha256(content: string | Buffer): string {
    return createHash("sha256").update(content).digest("hex");
  }

  private hmac(key: Buffer | string, data: string): Buffer {
    return createHmac("sha256", key).update(data, "utf8").digest();
  }

  private getSignatureKey(key: string, dateStamp: string, regionName: string, serviceName: string): Buffer {
    const kDate = this.hmac(`AWS4${key}`, dateStamp);
    const kRegion = this.hmac(kDate, regionName);
    const kService = this.hmac(kRegion, serviceName);
    return this.hmac(kService, "aws4_request");
  }

  private buildUrl(key: string): URL {
    const cleanKey = key.replace(/^\/+/, "");
    const base = new URL(this.endpoint);
    if (this.forcePathStyle) {
      base.pathname = `/${this.bucket}/${cleanKey}`;
    } else {
      base.hostname = `${this.bucket}.${base.hostname}`;
      base.pathname = `/${cleanKey}`;
    }
    return base;
  }

  private signRequest(
    method: string,
    url: URL,
    headers: Record<string, string>,
    payloadHash: string,
  ): Record<string, string> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);

    const signedHeadersList = ["host", "x-amz-content-sha256", "x-amz-date"];
    if (headers["range"]) signedHeadersList.push("range");
    if (headers["content-type"]) signedHeadersList.push("content-type");
    signedHeadersList.sort();

    const signedHeaders = signedHeadersList.join(";");

    const outgoing: Record<string, string> = {
      ...headers,
      host: url.host,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
    };

    const canonicalHeaders = signedHeadersList
      .map((h) => `${h}:${outgoing[h].trim()}\n`)
      .join("");

    const canonicalRequest = [
      method,
      url.pathname,
      url.search.slice(1),
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      this.sha256(canonicalRequest),
    ].join("\n");

    const signingKey = this.getSignatureKey(this.secretKey, dateStamp, this.region, "s3");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

    outgoing["authorization"] =
      `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return outgoing;
  }

  async save(key: string, buffer: Buffer, mime: string): Promise<{ storageKey: string; size: number }> {
    const url = this.buildUrl(key);
    const payloadHash = this.sha256(buffer);
    const headers = this.signRequest("PUT", url, { "content-type": mime }, payloadHash);

    const response = await fetch(url.toString(), {
      method: "PUT",
      headers,
      body: new Uint8Array(buffer),
    });

    if (!response.ok) {
      throw new AppError(500, "STORAGE_ERROR", `Failed to save file to S3: ${response.statusText}`);
    }

    return { storageKey: key, size: buffer.length };
  }

  async read(key: string, rangeHeader?: string): Promise<StorageReadResult> {
    const url = this.buildUrl(key);
    const headersInit: Record<string, string> = {};
    if (rangeHeader) {
      headersInit["range"] = rangeHeader;
    }
    const headers = this.signRequest("GET", url, headersInit, "UNSIGNED-PAYLOAD");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers,
    });

    if (response.status === 404) {
      throw new AppError(404, "NOT_FOUND", "File was not found");
    }
    if (!response.ok && response.status !== 206) {
      throw new AppError(500, "STORAGE_ERROR", `Failed to read file from S3: ${response.statusText}`);
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const contentRange = response.headers.get("content-range");

    let rangeResult;
    if (contentRange) {
      const match = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/);
      if (match) {
        rangeResult = {
          start: Number(match[1]),
          end: Number(match[2]),
          total: Number(match[3]),
        };
      }
    }

    if (!response.body) {
      throw new AppError(500, "STORAGE_ERROR", "Empty response from S3 storage");
    }

    const stream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    return {
      stream,
      size: contentLength,
      mime: contentType,
      range: rangeResult,
    };
  }

  async delete(key: string): Promise<void> {
    const url = this.buildUrl(key);
    const headers = this.signRequest("DELETE", url, {}, "UNSIGNED-PAYLOAD");
    await fetch(url.toString(), { method: "DELETE", headers });
  }

  async exists(key: string): Promise<boolean> {
    const url = this.buildUrl(key);
    const headers = this.signRequest("HEAD", url, {}, "UNSIGNED-PAYLOAD");
    const response = await fetch(url.toString(), { method: "HEAD", headers });
    return response.ok;
  }

  async getSignedUrl(key: string, expiresInSeconds = 900): Promise<string> {
    const url = this.buildUrl(key);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;

    const queryParams: Record<string, string> = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.accessKey}/${credentialScope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(expiresInSeconds),
      "X-Amz-SignedHeaders": "host",
    };

    const canonicalQueryString = Object.keys(queryParams)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
      .join("&");

    const canonicalRequest = [
      "GET",
      url.pathname,
      canonicalQueryString,
      `host:${url.host}\n`,
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");

    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      this.sha256(canonicalRequest),
    ].join("\n");

    const signingKey = this.getSignatureKey(this.secretKey, dateStamp, this.region, "s3");
    const signature = this.hmac(signingKey, stringToSign).toString("hex");

    return `${url.origin}${url.pathname}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
  }
}
