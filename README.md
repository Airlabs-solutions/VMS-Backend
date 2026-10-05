# VMS API

Express API and daily alert worker for the Vehicle Management System.

## Run locally

MongoDB must be a replica set so EMI generation, imports and assignments can use transactions.

```bash
docker compose up -d
cp .env.example .env
npm install
npm run seed
npm run dev
npm run worker
```

Without Docker, `npm run dev:memory` starts an in-memory replica set, seeds demo data, and serves the API on port 5000.

Demo accounts after seeding:

- Super admin: `super@vms.local` / `ChangeMe123`
- Company admin: `admin@northwind.example` / `ChangeMe123`
- Driver OTP: `+966511111111` (the code is returned only when `NODE_ENV` is not production)

## Scripts

- `npm run dev` API
- `npm run worker` daily alerts at 06:00 Asia/Riyadh, SMS retry every 10 minutes
- `npm test` unit tests and tenant isolation
- `npm run build` compile TypeScript
