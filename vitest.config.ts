import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    hookTimeout: 180000,
    testTimeout: 30000,
    env: {
      NODE_ENV: "test",
      PORT: "5000",
      MONGODB_URI: "mongodb://127.0.0.1:27017/vms-test",
      JWT_ACCESS_SECRET: "test-access-secret-must-be-long-enough",
      JWT_REFRESH_SECRET: "test-refresh-secret-must-be-long-enough",
      FIELD_ENCRYPTION_KEY: "test-field-encryption-key-32b-min",
      FIELD_HMAC_KEY: "test-field-hmac-key-32bytes-minimum",
      CORS_ORIGINS: "http://localhost:5173,http://localhost:3000",
      COOKIE_SECURE: "false",
      SMS_PROVIDER: "log",
      SMS_SENDER: "VMS",
      STORAGE_DRIVER: "local",
      STORAGE_LOCAL_DIR: "./uploads-test",
      RATE_LIMIT_DISABLED: "true",
    },
  },
});
