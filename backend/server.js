import express from 'express';
import cors from 'cors';
import { Pool } from '@neondatabase/serverless';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STORE_PATH = path.join(__dirname, 'data', 'store.json');
const DIST_PATH = path.resolve(__dirname, '..', 'dist');
const PORT = Number(process.env.PORT || 4000);
const PUBLIC_API_CACHE_MS = 5 * 60 * 1000;
const publicApiCache = new Map();
let databasePool;
let databaseInitialization;

const defaultState = {
  vehicles: [
    { vehicleId: 'VEH-001', registered: true, status: 'Normal', latestSoH: 92, latestTemp: 31, latestVoltage: 389.8, timestamp: Date.now() - 1000 * 60 * 35 },
    { vehicleId: 'VEH-002', registered: true, status: 'Warning', latestSoH: 78, latestTemp: 44, latestVoltage: 378.9, timestamp: Date.now() - 1000 * 60 * 25 },
    { vehicleId: 'VEH-003', registered: true, status: 'Degraded', latestSoH: 68, latestTemp: 47, latestVoltage: 366.3, timestamp: Date.now() - 1000 * 60 * 48 },
  ],
  telemetry: [
    { vehicleId: 'VEH-001', timestamp: Date.now() - 1000 * 60 * 35, soH: 92, temperature: 31, voltage: 389.8, errorCode: 0, status: 'Normal' },
    { vehicleId: 'VEH-001', timestamp: Date.now() - 1000 * 60 * 90, soH: 91, temperature: 33, voltage: 388.5, errorCode: 0, status: 'Normal' },
    { vehicleId: 'VEH-001', timestamp: Date.now() - 1000 * 60 * 170, soH: 89, temperature: 35, voltage: 381.2, errorCode: 0, status: 'Normal' },
    { vehicleId: 'VEH-002', timestamp: Date.now() - 1000 * 60 * 25, soH: 78, temperature: 44, voltage: 378.9, errorCode: 0, status: 'Warning' },
    { vehicleId: 'VEH-002', timestamp: Date.now() - 1000 * 60 * 120, soH: 76, temperature: 43, voltage: 377.8, errorCode: 0, status: 'Warning' },
    { vehicleId: 'VEH-002', timestamp: Date.now() - 1000 * 60 * 220, soH: 73, temperature: 46, voltage: 374.1, errorCode: 0, status: 'Warning' },
    { vehicleId: 'VEH-003', timestamp: Date.now() - 1000 * 60 * 48, soH: 68, temperature: 47, voltage: 366.3, errorCode: 7, status: 'Critical' },
    { vehicleId: 'VEH-003', timestamp: Date.now() - 1000 * 60 * 150, soH: 70, temperature: 45, voltage: 369.7, errorCode: 0, status: 'Warning' },
    { vehicleId: 'VEH-003', timestamp: Date.now() - 1000 * 60 * 260, soH: 71, temperature: 42, voltage: 372.5, errorCode: 0, status: 'Warning' },
  ],
  alerts: [
    { id: 'alert-1', severity: 'Warning', vehicleId: 'VEH-002', message: 'Battery temperature above operating threshold.', triggerValue: '46°C', timestamp: Date.now() - 1000 * 60 * 20 },
    { id: 'alert-2', severity: 'Degraded', vehicleId: 'VEH-003', message: 'State of health below degradation threshold.', triggerValue: '68%', timestamp: Date.now() - 1000 * 60 * 35 },
    { id: 'alert-3', severity: 'Critical', vehicleId: 'VEH-003', message: 'Critical fault: thermal runaway risk flagged.', triggerValue: 'Error 7', timestamp: Date.now() - 1000 * 60 * 45 },
  ],
};

function getDatabasePool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for the Vercel persistent database.');
  }
  databasePool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  return databasePool;
}

async function ensureDatabase(pool) {
  databaseInitialization ??= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ev_demo_store (
        id integer PRIMARY KEY CHECK (id = 1),
        state jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await pool.query(
      'INSERT INTO ev_demo_store (id, state) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING',
      [JSON.stringify(defaultState)],
    );
  })();

  try {
    await databaseInitialization;
  } catch (error) {
    databaseInitialization = undefined;
    throw error;
  }
}

async function ensureStore() {
  if (process.env.DATABASE_URL) {
    const pool = getDatabasePool();
    await ensureDatabase(pool);
    const { rows } = await pool.query('SELECT state FROM ev_demo_store WHERE id = 1');
    return rows[0].state;
  }
  if (process.env.VERCEL) {
    throw new Error('Set DATABASE_URL to a persistent Neon Postgres database before deploying the API.');
  }

  try {
    await fs.access(STORE_PATH);
    const raw = await fs.readFile(STORE_PATH, 'utf8');
    if (!raw.trim()) {
      await writeStore(defaultState);
      return structuredClone(defaultState);
    }
    return JSON.parse(raw);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    await writeStore(defaultState);
    return structuredClone(defaultState);
  }
}

async function writeStore(state) {
  if (process.env.DATABASE_URL || process.env.VERCEL) {
    throw new Error('Persistent production writes must use updateStore().');
  }
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(state, null, 2));
}

async function updateStore(update) {
  if (!process.env.DATABASE_URL) {
    if (process.env.VERCEL) {
      throw new Error('Set DATABASE_URL to a persistent Neon Postgres database before deploying the API.');
    }
    const state = await ensureStore();
    const result = await update(state);
    await writeStore(state);
    return result;
  }

  const pool = getDatabasePool();
  await ensureDatabase(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [73918421]);
    const { rows } = await client.query('SELECT state FROM ev_demo_store WHERE id = 1 FOR UPDATE');
    const state = rows[0].state;
    const result = await update(state);
    await client.query(
      'UPDATE ev_demo_store SET state = $1::jsonb, updated_at = now() WHERE id = 1',
      [JSON.stringify(state)],
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function normalizeStatus(soH, temperature, errorCode) {
  if (errorCode !== 0) {
    return 'Critical';
  }
  if (soH < 75) {
    return 'Degraded';
  }
  if (temperature > 45) {
    return 'Warning';
  }
  return 'Normal';
}

function updateVehicleSummary(vehicles, telemetry) {
  for (const vehicle of vehicles) {
    const vehicleTelemetry = telemetry.filter((entry) => entry.vehicleId === vehicle.vehicleId);
    const latest = vehicleTelemetry.reduce((best, current) => (current.timestamp > best.timestamp ? current : best), vehicleTelemetry[0] ?? {
      vehicleId: vehicle.vehicleId,
      timestamp: vehicle.timestamp ?? Date.now(),
      soH: vehicle.latestSoH ?? 0,
      temperature: vehicle.latestTemp ?? 0,
      voltage: vehicle.latestVoltage ?? 0,
      errorCode: 0,
      status: 'Normal',
    });

    vehicle.status = normalizeStatus(latest.soH, latest.temperature, latest.errorCode);
    vehicle.latestSoH = latest.soH;
    vehicle.latestTemp = latest.temperature;
    vehicle.latestVoltage = latest.voltage;
    vehicle.timestamp = latest.timestamp;
  }

  return vehicles;
}

const app = express();
app.use(cors());
app.use(express.json());

function getCoordinates(query) {
  const latitude = Number(query.latitude);
  const longitude = Number(query.longitude);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
      !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return null;
  }
  return { latitude, longitude };
}

async function cachedPublicFetch(cacheKey, url, options = {}) {
  const cached = publicApiCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < PUBLIC_API_CACHE_MS) {
    return cached.value;
  }

  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(15000),
    headers: {
      'User-Agent': 'EV-Battery-Health-Monitor-Demo/1.0',
      'Accept': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`Public data provider responded with HTTP ${response.status}.`);
  }

  const value = await response.json();
  publicApiCache.set(cacheKey, { timestamp: Date.now(), value });
  return value;
}

app.get('/api/health', async (req, res) => {
  try {
    if (process.env.VERCEL || process.env.DATABASE_URL) {
      await ensureStore();
    }
    res.json({ ok: true, service: 'ev-battery-health-monitor-api', timestamp: Date.now() });
  } catch (error) {
    res.status(503).json({ ok: false, service: 'ev-battery-health-monitor-api', message: error.message });
  }
});

app.get('/api/public/weather', async (req, res) => {
  const coordinates = getCoordinates(req.query);
  if (!coordinates) {
    return res.status(400).json({ message: 'Valid latitude and longitude are required.' });
  }

  const { latitude, longitude } = coordinates;
  const cacheKey = `weather:${latitude.toFixed(3)}:${longitude.toFixed(3)}`;
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code',
    timezone: 'auto',
  }).toString();

  try {
    const data = await cachedPublicFetch(cacheKey, url);
    if (!data.current || !data.current_units) {
      return res.status(502).json({ message: 'Weather provider returned an incomplete response.' });
    }
    res.json({
      latitude: data.latitude,
      longitude: data.longitude,
      timezone: data.timezone,
      observedAt: data.current.time,
      temperatureC: data.current.temperature_2m,
      apparentTemperatureC: data.current.apparent_temperature,
      relativeHumidity: data.current.relative_humidity_2m,
      weatherCode: data.current.weather_code,
      source: 'Open-Meteo',
      attribution: 'Weather data by Open-Meteo',
    });
  } catch (error) {
    res.status(502).json({ message: `Weather data is temporarily unavailable: ${error.message}` });
  }
});

app.get('/api/public/charging-stations', async (req, res) => {
  const coordinates = getCoordinates(req.query);
  const radius = Number(req.query.radius ?? 5000);
  if (!coordinates || !Number.isFinite(radius) || radius < 100 || radius > 50000) {
    return res.status(400).json({ message: 'Valid coordinates and a radius between 100 and 50000 metres are required.' });
  }

  const { latitude, longitude } = coordinates;
  const cacheKey = `chargers:${latitude.toFixed(3)}:${longitude.toFixed(3)}:${radius}`;
  const query = `[out:json][timeout:12];(node[amenity=charging_station](around:${radius},${latitude},${longitude});way[amenity=charging_station](around:${radius},${latitude},${longitude});relation[amenity=charging_station](around:${radius},${latitude},${longitude}););out center tags 30;`;
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ];

  try {
    let data;
    let lastError;
    for (const endpoint of endpoints) {
      try {
        const url = new URL(endpoint);
        url.searchParams.set('data', query);
        data = await cachedPublicFetch(cacheKey, url);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!data) {
      throw lastError ?? new Error('No OpenStreetMap data endpoint responded.');
    }

    const toRadians = (degrees) => degrees * Math.PI / 180;
    const distanceKm = (lat, lon) => {
      const dLat = toRadians(lat - latitude);
      const dLon = toRadians(lon - longitude);
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRadians(latitude)) * Math.cos(toRadians(lat)) * Math.sin(dLon / 2) ** 2;
      return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };
    const stations = (data.elements ?? []).flatMap((element) => {
      const tags = element.tags ?? {};
      const lat = element.lat ?? element.center?.lat;
      const lon = element.lon ?? element.center?.lon;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return [];
      }
      return [{
        id: `${element.type}/${element.id}`,
        name: tags.name || tags.operator || tags.brand || 'EV charging station',
        operator: tags.operator || tags.brand || '',
        latitude: lat,
        longitude: lon,
        distanceKm: Number(distanceKm(lat, lon).toFixed(2)),
        powerKw: tags['充電出力'] || tags['socket:output'] || tags.maxpower || '',
        connectors: Object.entries(tags)
          .filter(([key, value]) => key.startsWith('socket:') && value && value !== 'no')
          .map(([key, value]) => `${key.slice(7)}: ${value}`)
          .slice(0, 4),
        access: tags.access || '',
      }];
    }).sort((left, right) => left.distanceKm - right.distanceKm);

    res.json({
      center: coordinates,
      radiusMetres: radius,
      stations,
      count: stations.length,
      source: 'OpenStreetMap',
      attribution: '© OpenStreetMap contributors, ODbL',
    });
  } catch (error) {
    res.status(502).json({ message: `Charging station data is temporarily unavailable: ${error.message}` });
  }
});

app.get('/api/public/vehicle-specs/:vin', async (req, res) => {
  const vin = String(req.params.vin ?? '').trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
    return res.status(400).json({ message: 'Enter a valid 17-character VIN (letters I, O, and Q are not used).' });
  }

  try {
    const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json`;
    const data = await cachedPublicFetch(`vehicle:${vin}`, url);
    const vehicle = data.Results?.[0];
    if (!vehicle || vehicle.ErrorCode === '1' || !vehicle.Make) {
      return res.status(422).json({ message: vehicle?.ErrorText || 'The VIN could not be decoded by NHTSA.' });
    }
    res.json({
      vin: vehicle.VIN,
      make: vehicle.Make,
      model: vehicle.Model,
      modelYear: vehicle.ModelYear,
      fuelType: vehicle.FuelTypePrimary,
      electrificationLevel: vehicle.ElectrificationLevel,
      batteryType: vehicle.BatteryType,
      batteryCapacityKwh: vehicle.BatteryKWh,
      chargerPowerKw: vehicle.ChargerPowerKW,
      driveUnit: vehicle.EVDriveUnit,
      bodyClass: vehicle.BodyClass,
      source: 'NHTSA vPIC',
      attribution: 'Vehicle attributes decoded by NHTSA vPIC; unavailable fields are not supplied by the source.',
    });
  } catch (error) {
    res.status(502).json({ message: `Vehicle data is temporarily unavailable: ${error.message}` });
  }
});

app.get('/api/vehicles', async (req, res) => {
  try {
    const state = await ensureStore();
    res.json(state.vehicles);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch vehicles', error: error.message });
  }
});

app.get('/api/alerts', async (req, res) => {
  try {
    const state = await ensureStore();
    res.json(state.alerts);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch alerts', error: error.message });
  }
});

app.get('/api/vehicles/:vehicleId/telemetry', async (req, res) => {
  try {
    const state = await ensureStore();
    const vehicleTelemetry = state.telemetry.filter((entry) => entry.vehicleId === req.params.vehicleId);
    res.json(vehicleTelemetry.sort((left, right) => right.timestamp - left.timestamp));
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch telemetry', error: error.message });
  }
});

app.get('/api/overview', async (req, res) => {
  try {
    const state = await ensureStore();
    const vehicles = updateVehicleSummary(structuredClone(state.vehicles), state.telemetry);
    const telemetry = [...state.telemetry].sort((left, right) => right.timestamp - left.timestamp);
    res.json({ vehicles, alerts: state.alerts, telemetry });
  } catch (error) {
    res.status(500).json({ message: 'Failed to compile overview', error: error.message });
  }
});

app.post('/api/vehicles', async (req, res) => {
  try {
    const { vehicleId } = req.body ?? {};
    const normalizedVehicleId = String(vehicleId ?? '').trim().toUpperCase();

    if (!/^[A-Z0-9-]{1,31}$/.test(normalizedVehicleId)) {
      return res.status(400).json({ message: 'Vehicle ID must contain 1-31 letters, numbers, or hyphens.' });
    }

    const result = await updateStore((state) => {
      if (state.vehicles.some((vehicle) => vehicle.vehicleId === normalizedVehicleId)) {
        return { status: 409, body: { message: 'Vehicle already exists.' } };
      }

      const vehicle = {
        vehicleId: normalizedVehicleId,
        registered: true,
        status: 'Monitoring',
        latestSoH: 88,
        latestTemp: 30,
        latestVoltage: 390,
        timestamp: Date.now(),
      };

      state.vehicles.push(vehicle);
      state.telemetry.push({
        vehicleId: normalizedVehicleId,
        timestamp: vehicle.timestamp,
        soH: vehicle.latestSoH,
        temperature: vehicle.latestTemp,
        voltage: vehicle.latestVoltage,
        errorCode: 0,
        status: 'Normal',
      });
      return { status: 201, body: vehicle };
    });
    res.status(result.status).json(result.body);
  } catch (error) {
    res.status(500).json({ message: 'Failed to register vehicle', error: error.message });
  }
});

app.post('/api/telemetry', async (req, res) => {
  try {
    const { vehicleId, soH, temperature, voltage, errorCode } = req.body ?? {};
    const normalizedVehicleId = String(vehicleId ?? '').trim().toUpperCase();

    if (!/^[A-Z0-9-]{1,31}$/.test(normalizedVehicleId)) {
      return res.status(400).json({ message: 'Vehicle ID must contain 1-31 letters, numbers, or hyphens.' });
    }

    const numericSoH = Number(soH ?? 0);
    const numericTemperature = Number(temperature ?? 0);
    const numericVoltage = Number(voltage ?? 0);
    const numericErrorCode = Number(errorCode ?? 0);

    if (
      !Number.isFinite(numericSoH) || numericSoH < 0 || numericSoH > 100 ||
      !Number.isFinite(numericTemperature) || numericTemperature < -100 || numericTemperature > 200 ||
      !Number.isFinite(numericVoltage) || numericVoltage <= 0 || numericVoltage > 2000 ||
      !Number.isInteger(numericErrorCode) || numericErrorCode < 0 || numericErrorCode > 65535
    ) {
      return res.status(400).json({ message: 'Telemetry values are outside supported ranges.' });
    }

    const nextRecord = await updateStore((state) => {
      const record = {
        vehicleId: normalizedVehicleId,
        timestamp: Date.now(),
        soH: numericSoH,
        temperature: numericTemperature,
        voltage: numericVoltage,
        errorCode: numericErrorCode,
        status: normalizeStatus(numericSoH, numericTemperature, numericErrorCode),
      };

      state.telemetry.push(record);

      if (!state.vehicles.some((vehicle) => vehicle.vehicleId === normalizedVehicleId)) {
        state.vehicles.push({
          vehicleId: normalizedVehicleId,
          registered: true,
          status: record.status,
          latestSoH: numericSoH,
          latestTemp: numericTemperature,
          latestVoltage: numericVoltage,
          timestamp: record.timestamp,
        });
      }

      state.vehicles = updateVehicleSummary(state.vehicles, state.telemetry);

      if (numericErrorCode !== 0 || numericSoH < 75 || numericTemperature > 45) {
        const severity = numericErrorCode !== 0 ? 'Critical' : numericTemperature > 45 ? 'Warning' : 'Degraded';
        const alert = {
          id: `alert-${record.timestamp}-${state.alerts.length}`,
          severity,
          vehicleId: normalizedVehicleId,
          message: numericErrorCode !== 0 ? 'Critical battery fault triggered.' : numericTemperature > 45 ? 'Battery temperature above operating threshold.' : 'State of health below degradation threshold.',
          triggerValue: String(numericErrorCode !== 0 ? `Error ${numericErrorCode}` : numericTemperature > 45 ? `${numericTemperature.toFixed(1)}°C` : `${numericSoH.toFixed(1)}%`),
          timestamp: record.timestamp,
        };

        state.alerts.unshift(alert);
      }
      return record;
    });
    res.status(201).json(nextRecord);
  } catch (error) {
    res.status(500).json({ message: 'Failed to save telemetry', error: error.message });
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ message: 'API route not found.' });
});

if (!process.env.VERCEL) {
  app.use(express.static(DIST_PATH));
  app.get('*', (req, res, next) => {
    res.sendFile(path.join(DIST_PATH, 'index.html'), (error) => {
      if (error) {
        next(error);
      }
    });
  });
}

if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`EV Battery Health Monitor backend running on http://localhost:${PORT}`);
  });
}

export default app;
