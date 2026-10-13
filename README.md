# Battery Intelligence Center

A premium EV battery telemetry dashboard built with React, TypeScript, Tailwind CSS, Recharts, and Ethers.js. It is designed for a smart contract that stores vehicle battery telemetry, monitors safety thresholds, and exposes health records for fleet dashboards.

## Features

- Wallet connection and network detection
- Vehicle selection and fleet summary cards
- Battery SoH gauge and telemetry charting
- Safety alert feed and alert reconstruction from logs
- Owner and oracle management forms
- Demo mode for presentations and local development
- Responsive dark automotive dashboard

## Prerequisites

- Node.js 22+
- npm 9+
- A compatible EVM wallet such as MetaMask

No wallet is needed for the demo deployment. Use the demo-only environment settings below.

## Installation

1. Install dependencies:

   npm install

2. Copy the environment example:

   cp .env.example .env

3. For the no-sign-in demo, keep these settings:

   VITE_DEMO_MODE=true
   VITE_DEMO_ONLY=true
   VITE_API_URL=http://localhost:4000

   Demo-only mode hides wallet/live controls and stores demo vehicle and telemetry actions through the backend. This unauthenticated demo backend is not suitable for private or production vehicle data.

## Smart contract requirements

The frontend expects a contract exposing the following interface:

- owner()
- authorizedOracle()
- registeredVehicles(bytes32)
- registerVehicle(bytes32)
- setOracle(address)
- logVehicleHealth(bytes32,uint256,uint256,uint256,uint256)
- getLatestHealth(bytes32)
- vehicleHistory(bytes32,uint256)
- HealthLogged event
- AlertTriggered event

A minimal Solidity reference contract is included in `contracts/EVHealthMonitor.sol`.

## Vehicle ID encoding

Vehicle identifiers are mapped to Solidity bytes32 values with:

```ts
ethers.encodeBytes32String(vehicleId)
```

This means a human-readable value such as `VEH-001` is encoded consistently for registration, telemetry writes, and reads. The app documents the exact on-chain value in the vehicle registration panel.

## Historical records strategy

The app avoids scanning the full blockchain on each render. Instead, it reads only a bounded window of recent logs from the `HealthLogged` and `AlertTriggered` events with a `queryFilter` call using a recent `fromBlock` value. This is efficient, bounded, and avoids expensive full-chain scans. The app also caches the selected vehicle data within React state so vehicle changes do not trigger repeated full-history pulls.

## Production use

To use real contract data, deploy the contract and set:

- `VITE_CONTRACT_ADDRESS`
- `VITE_CHAIN_ID`
- `VITE_DEMO_MODE=false`

The contract owner must register vehicles and set the oracle. The authorized oracle wallet alone may submit telemetry updates. Manual browser-based telemetry entry is restricted and labeled as a low-trust manual fallback for demos or testing.

## Run locally

Frontend only:

```bash
npm run dev -- --host 0.0.0.0
```

Full stack with backend:

```bash
npm run dev:full
```

The backend runs on `http://localhost:4000` and persists EV telemetry, vehicle summaries, and alerts to `backend/data/store.json`.

## Backend API

The project includes a lightweight Express backend for a full end-to-end flow:

- `GET /api/health` — backend health check
- `GET /api/public/weather?latitude=...&longitude=...` — current weather from Open-Meteo (no API key)
- `GET /api/public/charging-stations?latitude=...&longitude=...&radius=5000` — nearby mapped chargers from OpenStreetMap Overpass (no API key)
- `GET /api/public/vehicle-specs/:vin` — VIN decode via NHTSA vPIC (no API key)
- `GET /api/vehicles` — list registered vehicles
- `GET /api/alerts` — list alert records
- `GET /api/vehicles/:vehicleId/telemetry` — fetch telemetry for a vehicle
- `GET /api/overview` — aggregate summary including alerts and latest telemetry
- `POST /api/vehicles` — register a new vehicle
- `POST /api/telemetry` — submit a new telemetry record

Weather and charging-station information are live public data; vehicle specifications are returned only when a VIN is explicitly submitted. Battery health/telemetry remains clearly labeled demo data because free public APIs cannot provide private vehicle BMS readings. Public API availability, rate limits, and map coverage are not guaranteed; the UI reports provider errors and identifies the data sources.

### Public data sources and privacy

- Open-Meteo supplies current weather for the default San Francisco sample coordinates and for coordinates the user requests.
- OpenStreetMap data is queried through Overpass for mapped charging stations and attributed as `© OpenStreetMap contributors, ODbL`. Results may be incomplete or temporarily unavailable due to public-service limits.
- NHTSA vPIC decodes a VIN only after the user submits it. The VIN/decoded response may be briefly cached in server memory; VINs are not written to the demo JSON store.
- Coordinates are sent to the backend and the applicable public data providers to fulfill requests; they are not written to the demo JSON store. Browser geolocation is requested only after the user chooses “Use my location”.

Review each provider's current usage terms before using this demo beyond evaluation. Do not submit personal or sensitive vehicle data to this unauthenticated sample service.

## Production build

```bash
npm run build
```

## Deploy the no-wallet demo

The included Docker setup builds the frontend and runs it from the same Express service as the API. The public demo therefore uses a single origin, requires no wallet or sign-in, and persists demo writes in a Docker volume.

```bash
docker compose up --build
```

Open `http://localhost:4000`. To deploy, configure a container host to build this repository's `Dockerfile` and expose its host-provided `PORT`. Mount persistent storage at `/app/backend/data` if demo records should survive container replacement. The backend is intentionally unauthenticated and uses a JSON file store: keep it for public sample data only, not real vehicle or customer information. `docker compose config` validates the local Compose configuration; running the container requires an available Docker daemon.

## Free-tier Vercel deployment

Vercel serves the Vite frontend and runs the Express API as a serverless function. Neon Postgres provides durable demo storage; Vercel function filesystems are temporary and must not be used for persistent records.

1. Import this GitHub repository into a Vercel Hobby project, using the repository root as the project root. The included `vercel.json` configures the Vite build and API function.
2. Create a Neon project on its free plan and connect it to the Vercel project, or add its pooled connection string as the Vercel environment variable `DATABASE_URL` for Production and Preview. Do not commit or paste the connection string into source files.
3. Keep `VITE_DEMO_MODE=true` and `VITE_DEMO_ONLY=true`; leave `VITE_API_URL` unset in Vercel so the browser calls the same-origin `/api` routes.
4. Redeploy after setting environment variables. Confirm `/api/health` reports `ok: true`, then test vehicle registration and telemetry submission.

The API creates and seeds its Postgres state table on first use and serializes demo writes in a database transaction. Locally, it continues using `backend/data/store.json`; in Vercel, it requires `DATABASE_URL` and will not silently fall back to ephemeral disk. Vercel Hobby and Neon Free have usage quotas and service limits that may change. This unauthenticated demo is for public sample data only, not private or production vehicle data.

## Notes

- This frontend is designed for a real on-chain deployment, but demo mode is enabled by default so the UI is useful without a contract.
- The app will not claim a transaction succeeded without waiting for the receipt.
- Missing wallet or missing contract configuration is handled with clear UI errors instead of crashing.
