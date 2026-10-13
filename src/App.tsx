import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BatteryCharging,
  BatteryFull,
  BellRing,
  Bolt,
  CarFront,
  CircleAlert,
  Cpu,
  CloudSun,
  HardDrive,
  MapPin,
  Plug,
  RefreshCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Thermometer,
  TrendingUp,
  Wallet,
  Zap,
} from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { BrowserProvider, Contract, ethers } from 'ethers';
import { evHealthMonitorAbi, evHealthMonitorAddress } from './contracts/evHealthMonitor';

type NavKey = 'Overview' | 'Vehicles' | 'Safety Alerts' | 'Administration';

type TelemetryRecord = {
  vehicleId: string;
  timestamp: number;
  soH: number;
  temperature: number;
  voltage: number;
  errorCode: number;
  status: 'Normal' | 'Warning' | 'Critical';
  txHash?: string;
};

type AlertRecord = {
  id: string;
  severity: 'Warning' | 'Degraded' | 'Critical';
  vehicleId: string;
  message: string;
  triggerValue: string;
  txHash?: string;
  timestamp: number;
};

type VehicleSummary = {
  vehicleId: string;
  registered: boolean;
  status: string;
  latestSoH: number;
  latestTemp: number;
  latestVoltage: number;
  timestamp: number;
};

type PublicWeather = {
  latitude: number;
  longitude: number;
  timezone: string;
  observedAt: string;
  temperatureC: number;
  apparentTemperatureC: number;
  relativeHumidity: number;
  weatherCode: number;
  source: string;
  attribution: string;
};

type PublicChargingStation = {
  id: string;
  name: string;
  operator: string;
  latitude: number;
  longitude: number;
  distanceKm: number;
  powerKw: string;
  connectors: string[];
  access: string;
};

type PublicVehicleSpecs = {
  vin: string;
  make: string;
  model: string;
  modelYear: string;
  fuelType: string;
  electrificationLevel: string;
  batteryType: string;
  batteryCapacityKwh: string;
  chargerPowerKw: string;
  driveUnit: string;
  bodyClass: string;
  source: string;
  attribution: string;
};

type HealthTuple = [number, number, number, number, number];

const DEFAULT_PUBLIC_LOCATION = { latitude: 37.7749, longitude: -122.4194 };
const EMPTY_TELEMETRY_TIMESTAMP = Date.now();

function describeWeatherCode(code: number) {
  if (code === 0) return 'Clear';
  if ([1, 2, 3].includes(code)) return 'Partly cloudy';
  if ([45, 48].includes(code)) return 'Fog';
  if ([51, 53, 55, 56, 57].includes(code)) return 'Drizzle';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'Rain';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'Snow';
  if ([95, 96, 99].includes(code)) return 'Thunderstorm';
  return 'Conditions unavailable';
}

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
  }
}

const NAV_ITEMS: { key: NavKey; icon: typeof Activity }[] = [
  { key: 'Overview', icon: Activity },
  { key: 'Vehicles', icon: CarFront },
  { key: 'Safety Alerts', icon: ShieldAlert },
  { key: 'Administration', icon: Cpu },
];

const DEMO_VEHICLES = ['VEH-001', 'VEH-002', 'VEH-003'];
const DEFAULT_CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? '11155111');
const API_BASE_URL = import.meta.env.VITE_API_URL ?? '';
const DEMO_ONLY_MODE = import.meta.env.VITE_DEMO_ONLY !== 'false';
const START_IN_DEMO_MODE = DEMO_ONLY_MODE || import.meta.env.VITE_DEMO_MODE !== 'false';

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });

  const result = await response.json();
  if (!response.ok) {
    const message = typeof result?.message === 'string' ? result.message : `Request failed: ${response.status}`;
    throw new Error(message);
  }

  return result as T;
}

function getVehicleIdBytes32(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error('Vehicle ID is required.');
  }

  return ethers.encodeBytes32String(normalized);
}

function formatShortAddress(value: string) {
  if (!value) return 'Not connected';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function formatVehicleLabel(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : 0;
  }
  return 0;
}

function normalizeHealthTuple(raw: unknown[]): HealthTuple {
  const normalized = raw.map((entry) => toNumber(entry));
  const soH = normalized.find((value) => value >= 0 && value <= 100) ?? normalized[0] ?? 0;
  const temperature = normalized.find((value) => value >= -100 && value <= 150 && value !== soH) ?? normalized[1] ?? 0;
  const voltage = normalized.find((value) => value > 100 && value !== soH && value !== temperature) ?? normalized[2] ?? 0;
  const errorCode = normalized.find((value) => value >= 0 && value <= 1000 && value !== soH && value !== temperature && value !== voltage) ?? normalized[3] ?? 0;
  const timestamp = normalized.find((value) => value >= 1_700_000_000 && value <= 5_000_000_000 && value !== soH && value !== temperature && value !== voltage && value !== errorCode) ?? Math.floor(Date.now() / 1000);

  return [soH, temperature, voltage, errorCode, timestamp] as HealthTuple;
}

function getSoHLabel(soH: number) {
  if (soH >= 90) return 'Excellent';
  if (soH >= 75) return 'Good';
  return 'Degraded';
}

function getAlertTone(severity: AlertRecord['severity']) {
  if (severity === 'Critical') return 'text-red-300 border-red-500/40 bg-red-600/10';
  if (severity === 'Degraded') return 'text-amber-200 border-amber-500/40 bg-amber-600/10';
  return 'text-yellow-200 border-yellow-500/40 bg-yellow-500/10';
}

const demoTelemetryMap: Record<string, TelemetryRecord[]> = {
  'VEH-001': [
    { vehicleId: 'VEH-001', timestamp: Date.now() - 1000 * 60 * 35, soH: 92, temperature: 31, voltage: 389.8, errorCode: 0, status: 'Normal' },
    { vehicleId: 'VEH-001', timestamp: Date.now() - 1000 * 60 * 90, soH: 91, temperature: 33, voltage: 388.5, errorCode: 0, status: 'Normal' },
    { vehicleId: 'VEH-001', timestamp: Date.now() - 1000 * 60 * 170, soH: 89, temperature: 35, voltage: 381.2, errorCode: 0, status: 'Normal' },
  ],
  'VEH-002': [
    { vehicleId: 'VEH-002', timestamp: Date.now() - 1000 * 60 * 25, soH: 78, temperature: 44, voltage: 378.9, errorCode: 0, status: 'Warning' },
    { vehicleId: 'VEH-002', timestamp: Date.now() - 1000 * 60 * 120, soH: 76, temperature: 43, voltage: 377.8, errorCode: 0, status: 'Warning' },
    { vehicleId: 'VEH-002', timestamp: Date.now() - 1000 * 60 * 220, soH: 73, temperature: 46, voltage: 374.1, errorCode: 0, status: 'Warning' },
  ],
  'VEH-003': [
    { vehicleId: 'VEH-003', timestamp: Date.now() - 1000 * 60 * 48, soH: 68, temperature: 47, voltage: 366.3, errorCode: 7, status: 'Critical' },
    { vehicleId: 'VEH-003', timestamp: Date.now() - 1000 * 60 * 150, soH: 70, temperature: 45, voltage: 369.7, errorCode: 0, status: 'Warning' },
    { vehicleId: 'VEH-003', timestamp: Date.now() - 1000 * 60 * 260, soH: 71, temperature: 42, voltage: 372.5, errorCode: 0, status: 'Warning' },
  ],
};

const demoAlerts: AlertRecord[] = [
  { id: 'alert-1', severity: 'Warning', vehicleId: 'VEH-002', message: 'Battery temperature above operating threshold.', triggerValue: '46°C', timestamp: Date.now() - 1000 * 60 * 20 },
  { id: 'alert-2', severity: 'Degraded', vehicleId: 'VEH-003', message: 'State of health below degradation threshold.', triggerValue: '68%', timestamp: Date.now() - 1000 * 60 * 35 },
  { id: 'alert-3', severity: 'Critical', vehicleId: 'VEH-003', message: 'Critical fault: thermal runaway risk flagged.', triggerValue: 'Error 7', timestamp: Date.now() - 1000 * 60 * 45 },
];

const demoVehicleSummaries: VehicleSummary[] = DEMO_VEHICLES.map((value) => {
  const latest = demoTelemetryMap[value].reduce((best, current) => (current.timestamp > best.timestamp ? current : best), demoTelemetryMap[value][0]);
  return {
    vehicleId: value,
    registered: true,
    status: latest.soH < 75 ? 'Degraded' : latest.temperature > 45 ? 'Warning' : 'Normal',
    latestSoH: latest.soH,
    latestTemp: latest.temperature,
    latestVoltage: latest.voltage,
    timestamp: latest.timestamp,
  };
});

function createChartData(items: TelemetryRecord[]) {
  return [...items].sort((left, right) => left.timestamp - right.timestamp).map((entry) => ({
    ...entry,
    label: new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  }));
}

function AnimatedMetricSlider({ metrics }: { metrics: Array<{ label: string; value: string; status: string; icon: typeof BatteryCharging }> }) {
  return (
    <div className="metric-slider" aria-label="Battery metrics carousel">
      <div className="metric-slider-track">
        {metrics.map(({ label, value, status, icon: Icon }) => (
          <AnimatedMetricCard key={label} label={label} value={value} status={status} icon={Icon} />
        ))}
      </div>
    </div>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState<NavKey>('Overview');
  const [mobileNavOpen, setMobileNavOpen] = useState<boolean>(false);
  const [selectedVehicle, setSelectedVehicle] = useState<string>(DEMO_VEHICLES[0]);
  const [walletAddress, setWalletAddress] = useState<string>('');
  const [chainId, setChainId] = useState<number>(DEFAULT_CHAIN_ID);
  const [chainName, setChainName] = useState<string>(DEMO_ONLY_MODE ? 'Demo backend' : 'Ethereum Sepolia');
  const [contractAddress] = useState<string>(evHealthMonitorAddress || '0x0000000000000000000000000000000000000000');
  const [demoMode, setDemoMode] = useState<boolean>(START_IN_DEMO_MODE);
  const [syncing, setSyncing] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [latestTelemetry, setLatestTelemetry] = useState<TelemetryRecord | null>(demoTelemetryMap[DEMO_VEHICLES[0]][0]);
  const [history, setHistory] = useState<TelemetryRecord[]>(demoTelemetryMap[DEMO_VEHICLES[0]]);
  const [alerts, setAlerts] = useState<AlertRecord[]>(demoAlerts);
  const [vehicleSummaries, setVehicleSummaries] = useState<VehicleSummary[]>(demoVehicleSummaries);
  const [ownerAddress, setOwnerAddress] = useState<string>('0x0000000000000000000000000000000000000000');
  const [oracleAddress, setOracleAddress] = useState<string>('0x0000000000000000000000000000000000000000');
  const [pendingTx, setPendingTx] = useState<string>('');
  const [txStatus, setTxStatus] = useState<string>('Ready');
  const [selectedChartMetric, setSelectedChartMetric] = useState<'soH' | 'temperature' | 'voltage'>('soH');
  const [vehicleRegistryInput, setVehicleRegistryInput] = useState<string>('VEH-004');
  const [oracleInput, setOracleInput] = useState<string>('0x0000000000000000000000000000000000000000');
  const [manualForm, setManualForm] = useState({ soH: '84', temperature: '31', voltage: '390', errorCode: '0' });
  const [publicLatitude, setPublicLatitude] = useState(String(DEFAULT_PUBLIC_LOCATION.latitude));
  const [publicLongitude, setPublicLongitude] = useState(String(DEFAULT_PUBLIC_LOCATION.longitude));
  const [publicWeather, setPublicWeather] = useState<PublicWeather | null>(null);
  const [chargingStations, setChargingStations] = useState<PublicChargingStation[]>([]);
  const [publicDataLoading, setPublicDataLoading] = useState(true);
  const [publicDataError, setPublicDataError] = useState('');
  const [vehicleSpecsVin, setVehicleSpecsVin] = useState('');
  const [vehicleSpecs, setVehicleSpecs] = useState<PublicVehicleSpecs | null>(null);
  const [vehicleSpecsLoading, setVehicleSpecsLoading] = useState(false);
  const [vehicleSpecsError, setVehicleSpecsError] = useState('');

  const connected = walletAddress.length > 0;
  const canRegisterVehicle = demoMode || (!demoMode && connected && ownerAddress.toLowerCase() === walletAddress.toLowerCase());
  const canSubmitTelemetry = demoMode || (!demoMode && connected && oracleAddress.toLowerCase() === walletAddress.toLowerCase());

  const loadPublicLocationData = useCallback(async (latitude: number, longitude: number) => {
    const query = `latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}`;
    const [weatherResult, chargingResult] = await Promise.allSettled([
      fetchJson<PublicWeather>(`/api/public/weather?${query}`),
      fetchJson<{ stations: PublicChargingStation[] }>(`/api/public/charging-stations?${query}&radius=5000`),
    ]);

    const errors: string[] = [];
    if (weatherResult.status === 'fulfilled') {
      setPublicWeather(weatherResult.value);
    } else {
      errors.push(`Weather: ${weatherResult.reason instanceof Error ? weatherResult.reason.message : 'unavailable'}`);
    }
    if (chargingResult.status === 'fulfilled') {
      setChargingStations(chargingResult.value.stations);
    } else {
      errors.push(`Charging stations: ${chargingResult.reason instanceof Error ? chargingResult.reason.message : 'unavailable'}`);
    }

    if (errors.length > 0) {
      setPublicDataError(errors.join(' · '));
    }
    setPublicDataLoading(false);
  }, []);

  const loadVehicleSpecs = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setVehicleSpecsLoading(true);
    setVehicleSpecsError('');
    setVehicleSpecs(null);
    try {
      const result = await fetchJson<PublicVehicleSpecs>(`/api/public/vehicle-specs/${encodeURIComponent(vehicleSpecsVin.trim())}`);
      setVehicleSpecs(result);
    } catch (caughtError) {
      setVehicleSpecsError(caughtError instanceof Error ? caughtError.message : 'Unable to decode vehicle.');
    } finally {
      setVehicleSpecsLoading(false);
    }
  }, [vehicleSpecsVin]);

  async function handlePublicLocationSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const latitude = Number(publicLatitude);
    const longitude = Number(publicLongitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      setPublicDataError('Enter a valid latitude (-90 to 90) and longitude (-180 to 180).');
      return;
    }
    setPublicDataLoading(true);
    setPublicDataError('');
    await loadPublicLocationData(latitude, longitude);
  }

  function useCurrentLocation() {
    if (!navigator.geolocation) {
      setPublicDataError('This browser does not provide location access. Enter coordinates instead.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        setPublicLatitude(latitude.toFixed(5));
        setPublicLongitude(longitude.toFixed(5));
        setPublicDataLoading(true);
        setPublicDataError('');
        void loadPublicLocationData(latitude, longitude);
      },
      () => setPublicDataError('Location permission was unavailable. Enter coordinates instead.'),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  }

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        void loadPublicLocationData(DEFAULT_PUBLIC_LOCATION.latitude, DEFAULT_PUBLIC_LOCATION.longitude);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadPublicLocationData]);

  const refreshBackendDashboard = useCallback(async () => {
    try {
      const data = await fetchJson<{
        vehicles: VehicleSummary[];
        alerts: AlertRecord[];
        telemetry: TelemetryRecord[];
      }>('/api/overview');

      const nextVehicle = data.vehicles.find((vehicle) => vehicle.vehicleId === selectedVehicle) ?? data.vehicles[0];
      const vehicleTelemetry = data.telemetry.filter((record) => record.vehicleId === (nextVehicle?.vehicleId ?? selectedVehicle));

      if (nextVehicle) {
        setVehicleSummaries(data.vehicles);
        setLatestTelemetry(vehicleTelemetry[0] ?? null);
        setHistory(vehicleTelemetry.length > 0 ? vehicleTelemetry : (demoTelemetryMap[selectedVehicle] ?? []));
      }

      setAlerts(data.alerts.length > 0 ? data.alerts : demoAlerts);
      setErrorMessage('');
      setOwnerAddress('0x0000000000000000000000000000000000000000');
      setOracleAddress('0x0000000000000000000000000000000000000000');
      setSyncing(false);
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Backend unavailable';
      setErrorMessage(`Backend unavailable: ${message}. Falling back to local demo data.`);
      setSyncing(false);
      setLatestTelemetry(demoTelemetryMap[selectedVehicle]?.[0] ?? null);
      setHistory(demoTelemetryMap[selectedVehicle] ?? []);
      setAlerts(demoAlerts);
      setVehicleSummaries(demoVehicleSummaries);
    }
  }, [selectedVehicle]);

  const refreshContractData = useCallback(async () => {
    if (demoMode) {
      await refreshBackendDashboard();
      return;
    }

    try {
      const backendHealthy = await fetch(`${API_BASE_URL}/api/health`).then((response) => response.ok).catch(() => false);
      if (backendHealthy) {
        setSyncing(true);
        setErrorMessage('');
        await refreshBackendDashboard();
        return;
      }

      setSyncing(true);
      setErrorMessage('');
      if (!window.ethereum) {
        setErrorMessage('Wallet provider is not installed');
        setSyncing(false);
        return;
      }

      const provider = new BrowserProvider(window.ethereum as never);
      const signer = await provider.getSigner();
      const wallet = await signer.getAddress();
      const network = await provider.getNetwork();
      const contract = new Contract(contractAddress, evHealthMonitorAbi, provider);

      const [ownerValue, oracleValue, registered, latestRecord] = await Promise.all([
        contract.owner(),
        contract.authorizedOracle(),
        contract.registeredVehicles(getVehicleIdBytes32(selectedVehicle)),
        contract.getLatestHealth(getVehicleIdBytes32(selectedVehicle)).catch(() => [0, 0, 0, 0, 0]),
      ]);

      const parsedLatest = normalizeHealthTuple(latestRecord);
      const parsedRecord: TelemetryRecord = {
        vehicleId: selectedVehicle,
        timestamp: Number(parsedLatest[4]) * 1000 || Date.now(),
        soH: parsedLatest[0],
        temperature: parsedLatest[1],
        voltage: parsedLatest[2] / 1000,
        errorCode: parsedLatest[3],
        status: parsedLatest[3] !== 0 ? 'Critical' : parsedLatest[0] < 75 ? 'Warning' : 'Normal',
      };

      const blockNumber = Number(await provider.getBlockNumber());
      const fromBlock = Math.max(0, blockNumber - 2000);
      const events = await contract.queryFilter(contract.filters.HealthLogged(), fromBlock, blockNumber);
      const historyRows: TelemetryRecord[] = [];

      for (const event of events) {
        const logEvent = event as ethers.EventLog;
        const args = logEvent.args ?? [];
        const vehicleIdHex = String(args[0] ?? '');
        const decodedVehicleId = vehicleIdHex ? ethers.decodeBytes32String(vehicleIdHex) : 'UNKNOWN';
        const timestamp = Number(args[1] ?? 0) * 1000;
        const soH = Number(args[2] ?? 0);
        const temperature = Number(args[3] ?? 0);
        const voltage = Number(args[4] ?? 0) / 1000;
        const errorCode = Number(args[5] ?? 0);
        historyRows.push({
          vehicleId: decodedVehicleId,
          timestamp,
          soH,
          temperature,
          voltage,
          errorCode,
          status: errorCode !== 0 ? 'Critical' : soH < 75 ? 'Warning' : 'Normal',
          txHash: event.transactionHash,
        });
      }

      const uniqueHistory = [...new Map(historyRows.map((item) => [item.timestamp, item])).values()].sort((left, right) => right.timestamp - left.timestamp);
      const eventAlertsData = await contract.queryFilter(contract.filters.AlertTriggered(), fromBlock, blockNumber);
      const derivedAlerts: AlertRecord[] = eventAlertsData.map((event, index) => {
        const logEvent = event as ethers.EventLog;
        const args = logEvent.args ?? [];
        const vehicleIdHex = String(args[0] ?? '');
        const decodedVehicleId = vehicleIdHex ? ethers.decodeBytes32String(vehicleIdHex) : 'UNKNOWN';
        const timestamp = Number(args[1] ?? 0) * 1000;
        const message = String(args[2] ?? 'Alert triggered');
        const severityNumber = Number(args[4] ?? 0);
        const severity = severityNumber === 2 ? 'Critical' : severityNumber === 1 ? 'Degraded' : 'Warning';

        return {
          id: `${decodedVehicleId}-${timestamp}-${index}`,
          severity,
          vehicleId: decodedVehicleId,
          message,
          triggerValue: String(args[3] ?? '0'),
          txHash: event.transactionHash,
          timestamp,
        };
      });

      setOwnerAddress(ownerValue ?? '0x0000000000000000000000000000000000000000');
      setOracleAddress(oracleValue ?? '0x0000000000000000000000000000000000000000');
      setWalletAddress(wallet || '');
      setChainId(Number(network.chainId));
      setChainName(network.name || 'Unknown network');
      setLatestTelemetry(registered ? parsedRecord : null);
      setHistory(uniqueHistory.length > 0 ? uniqueHistory : []);
      setAlerts(derivedAlerts.length > 0 ? derivedAlerts : []);
      setVehicleSummaries([
        {
          vehicleId: selectedVehicle,
          registered: Boolean(registered),
          status: parsedRecord.soH < 75 ? 'Degraded' : parsedRecord.temperature > 45 ? 'Warning' : 'Normal',
          latestSoH: parsedRecord.soH,
          latestTemp: parsedRecord.temperature,
          latestVoltage: parsedRecord.voltage,
          timestamp: parsedRecord.timestamp,
        },
      ]);
      setSyncing(false);
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Unable to read contract state';
      setErrorMessage(message);
      setSyncing(false);
    }
  }, [contractAddress, demoMode, refreshBackendDashboard, selectedVehicle]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) {
        return;
      }
      if (demoMode) {
        void refreshBackendDashboard();
      } else if (selectedVehicle) {
        void refreshContractData();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [demoMode, selectedVehicle, walletAddress, chainId, refreshBackendDashboard, refreshContractData]);

  async function connectWallet() {
    if (!window.ethereum) {
      setErrorMessage('Install MetaMask or a compatible Ethereum wallet to continue.');
      return;
    }

    try {
      setTxStatus('Connecting wallet');
      const provider = new BrowserProvider(window.ethereum as never);
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      const signer = await provider.getSigner();
      const wallet = await signer.getAddress();
      const network = await provider.getNetwork();
      setWalletAddress(wallet);
      setChainId(Number(network.chainId));
      setChainName(network.name || 'Unknown network');
      setTxStatus('Wallet connected');
      setErrorMessage('');
      if (accounts && Array.isArray(accounts)) {
        setWalletAddress(String(accounts[0]));
      }
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Wallet connection was rejected.';
      setErrorMessage(message);
      setTxStatus('Connection rejected');
    }
  }

  async function disconnectWallet() {
    setWalletAddress('');
    setTxStatus('Wallet disconnected');
  }

  async function handleRegisterVehicle(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canRegisterVehicle) {
      setErrorMessage('Only the contract owner can register vehicles.');
      return;
    }

    try {
      if (demoMode) {
        const nextVehicle = formatVehicleLabel(vehicleRegistryInput);
        const vehicle = await fetchJson<VehicleSummary>('/api/vehicles', {
          method: 'POST',
          body: JSON.stringify({ vehicleId: nextVehicle }),
        });
        setVehicleSummaries((current) => [...current.filter((item) => item.vehicleId !== vehicle.vehicleId), vehicle]);
        setSelectedVehicle(vehicle.vehicleId);
        setErrorMessage('');
        setTxStatus('Demo vehicle saved');
        return;
      }

      const nextVehicle = formatVehicleLabel(vehicleRegistryInput);
      const response = await fetch(`${API_BASE_URL}/api/vehicles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicleId: nextVehicle }),
      });

      if (!response.ok) {
        throw new Error('Vehicle registration via backend failed');
      }

      const vehicle = (await response.json()) as VehicleSummary;
      setVehicleSummaries((current) => [
        ...current.filter((item) => item.vehicleId !== vehicle.vehicleId),
        vehicle,
      ]);
      setSelectedVehicle(vehicle.vehicleId);
      setPendingTx('');
      setTxStatus('Vehicle registered via backend');
      setErrorMessage('');
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Transaction failed.';
      setErrorMessage(message);
      setPendingTx('');
      setTxStatus('Registration failed');
    }
  }

  async function handleSetOracle(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canRegisterVehicle) {
      setErrorMessage('Only the contract owner can update the oracle address.');
      return;
    }

    try {
      if (demoMode) {
        setOracleAddress(oracleInput);
        setTxStatus('Demo oracle updated');
        return;
      }

      const provider = new BrowserProvider(window.ethereum as never);
      const signer = await provider.getSigner();
      const contract = new Contract(contractAddress, evHealthMonitorAbi, signer);
      setPendingTx('Updating oracle...');
      setTxStatus('Pending confirmation');
      const tx = await contract.setOracle(oracleInput);
      await tx.wait();
      setOracleAddress(oracleInput);
      setPendingTx('');
      setTxStatus('Oracle updated');
      setErrorMessage('');
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Oracle update failed.';
      setErrorMessage(message);
      setPendingTx('');
      setTxStatus('Oracle update failed');
    }
  }

  async function handleTelemetrySubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canSubmitTelemetry) {
      setErrorMessage('The connected wallet must be the authorized oracle to submit telemetry.');
      return;
    }

    try {
      if (demoMode) {
        const nextRecord = await fetchJson<TelemetryRecord>('/api/telemetry', {
          method: 'POST',
          body: JSON.stringify({
          vehicleId: selectedVehicle,
          soH: Number(manualForm.soH),
          temperature: Number(manualForm.temperature),
          voltage: Number(manualForm.voltage),
          errorCode: Number(manualForm.errorCode),
          }),
        });
        setHistory((current) => [nextRecord, ...current].sort((left, right) => right.timestamp - left.timestamp));
        setLatestTelemetry(nextRecord);
        setVehicleSummaries((current) => current.map((vehicle) => vehicle.vehicleId === selectedVehicle
          ? { ...vehicle, status: nextRecord.status, latestSoH: nextRecord.soH, latestTemp: nextRecord.temperature, latestVoltage: nextRecord.voltage, timestamp: nextRecord.timestamp }
          : vehicle));
        setTxStatus('Demo telemetry saved');
        setErrorMessage('');
        return;
      }

      const payload = {
        vehicleId: selectedVehicle,
        soH: Number(manualForm.soH),
        temperature: Number(manualForm.temperature),
        voltage: Number(manualForm.voltage),
        errorCode: Number(manualForm.errorCode),
      };

      const response = await fetch(`${API_BASE_URL}/api/telemetry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error('Telemetry submission via backend failed');
      }

      const nextRecord = (await response.json()) as TelemetryRecord;
      setHistory((current) => [nextRecord, ...current].sort((left, right) => right.timestamp - left.timestamp));
      setLatestTelemetry(nextRecord);
      setPendingTx('');
      setTxStatus('Telemetry submitted via backend');
      setErrorMessage('');
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : 'Telemetry submission failed.';
      setErrorMessage(message);
      setPendingTx('');
      setTxStatus('Submission failed');
    }
  }

  const overviewMetrics = useMemo(() => {
    const averageSoH = vehicleSummaries.length
      ? vehicleSummaries.reduce((acc, current) => acc + current.latestSoH, 0) / vehicleSummaries.length
      : 0;
    const activeAlerts = alerts.length;
    const latestTime = latestTelemetry ? latestTelemetry.timestamp : EMPTY_TELEMETRY_TIMESTAMP;

    return [
      { label: 'Battery SoH', value: `${latestTelemetry ? latestTelemetry.soH.toFixed(1) : '--'}%`, status: `${getSoHLabel(latestTelemetry?.soH ?? 0)} band`, icon: BatteryFull },
      { label: 'Battery Temperature', value: `${latestTelemetry ? latestTelemetry.temperature.toFixed(1) : '--'}°C`, status: latestTelemetry && latestTelemetry.temperature > 45 ? 'Thermal warning' : 'Stable', icon: Thermometer },
      { label: 'Battery Voltage', value: `${latestTelemetry ? latestTelemetry.voltage.toFixed(1) : '--'}V`, status: latestTelemetry && latestTelemetry.voltage > 390 ? 'Voltage high' : 'Nominal', icon: Bolt },
      { label: 'Average Battery SoH', value: `${averageSoH ? averageSoH.toFixed(1) : '--'}%`, status: 'Fleet average', icon: TrendingUp },
      { label: 'Registered Vehicles', value: `${vehicleSummaries.length}`, status: demoMode ? 'Backend registry' : 'On-chain sync', icon: CarFront },
      { label: 'Active Safety Alerts', value: `${activeAlerts}`, status: 'Safety watch', icon: BellRing },
      { label: 'Latest Telemetry Update', value: new Date(latestTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), status: 'Telemetry timestamp', icon: Activity },
    ];
  }, [alerts, demoMode, latestTelemetry, vehicleSummaries]);

  const chartData = useMemo(() => createChartData(history), [history]);
  const currentGauge = latestTelemetry ?? { soH: 0, temperature: 0, voltage: 0, timestamp: EMPTY_TELEMETRY_TIMESTAMP };
  const gaugeValue = Number.isFinite(currentGauge.soH) ? Math.min(Math.max(currentGauge.soH, 0), 100) : 0;

  return (
    <div className="app-shell min-h-screen bg-[#0B0D10] text-slate-100">
      <aside className="sidebar hidden w-[240px] shrink-0 border-r border-white/10 bg-[#11161B] xl:flex xl:flex-col">
        <div className="flex items-center gap-3 px-6 py-7 text-xl font-black tracking-[0.2em] text-white">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-[#B8F36B]/40 bg-[#B8F36B]/10 text-[#B8F36B]">
            <Zap className="h-5 w-5" />
          </div>
          VOLT//GUARD
        </div>

        <nav className="flex flex-1 flex-col gap-2 px-3">
          {NAV_ITEMS.map(({ key, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setActiveTab(key)}
              className={`flex items-center gap-3 rounded-xl px-4 py-3 text-left text-sm font-medium transition ${
                activeTab === key
                  ? 'bg-[#B8F36B]/12 text-[#B8F36B] ring-1 ring-[#B8F36B]/40'
                  : 'text-slate-300 hover:bg-white/5 hover:text-white'
              }`}
            >
              <Icon className="h-4 w-4" />
              {key}
            </button>
          ))}
        </nav>

        <div className="space-y-3 border-t border-white/10 px-4 py-5 text-xs text-slate-300">
          <div className="flex items-center justify-between rounded-lg bg-[#191F26] px-3 py-2">
            <span className="inline-flex items-center gap-2 text-slate-400"><HardDrive className="h-3.5 w-3.5" /> Network</span>
            <span className="font-semibold text-[#B8F36B]">{demoMode ? 'Demo backend' : chainName}</span>
          </div>
          <div className="flex items-center justify-between rounded-lg bg-[#191F26] px-3 py-2">
            <span className="inline-flex items-center gap-2 text-slate-400"><Wallet className="h-3.5 w-3.5" /> Wallet</span>
            <span className="font-semibold text-slate-100">{connected ? 'Connected' : 'Offline'}</span>
          </div>
          <div className="truncate rounded-lg border border-white/10 bg-[#0F1418] px-3 py-2 text-slate-100">
            {connected ? formatShortAddress(walletAddress) : 'No active wallet'}
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-white/10 bg-[#0B0D10]/85 backdrop-blur-xl">
          <div className="flex flex-col gap-3 px-4 py-4 xl:flex-row xl:items-center xl:justify-between xl:px-6">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setMobileNavOpen((current) => !current)}
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-[#11161B] text-slate-100 xl:hidden"
                aria-label="Toggle navigation menu"
              >
                <span className="block h-0.5 w-5 rounded-full bg-current" />
              </button>

              <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.25em] text-[#B8F36B]">{activeTab}</div>
                <h1 className="mt-1 text-xl font-semibold text-white sm:text-2xl">
                  {activeTab === 'Overview' ? 'Battery Intelligence Center (Prem)' : activeTab}
                </h1>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-[#11161B] px-3 py-2 text-xs text-slate-300">
                <span className="inline-flex items-center gap-2"><CarFront className="h-3.5 w-3.5 text-[#4DD8E8]" /> Selected</span>
                <select
                  value={selectedVehicle}
                  onChange={(event) => {
                    setSyncing(true);
                    setSelectedVehicle(event.target.value);
                  }}
                  className="bg-transparent px-1 text-sm font-medium text-white outline-none"
                  aria-label="Selected vehicle"
                >
                  {vehicleSummaries.map(({ vehicleId }) => (
                    <option key={vehicleId} value={vehicleId} className="bg-[#11161B] text-slate-100">
                      {vehicleId}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-[#11161B] px-3 py-2 text-xs text-slate-300">
                <span className="h-2.5 w-2.5 rounded-full bg-[#B8F36B]" />
                {demoMode ? 'Demo backend' : chainName}
              </div>

              {!DEMO_ONLY_MODE && (
                <>
                  <button
                    type="button"
                    onClick={() => setDemoMode((current) => !current)}
                    className="rounded-lg border border-[#4DD8E8]/40 bg-[#4DD8E8]/10 px-3 py-2 text-xs font-medium uppercase tracking-[0.2em] text-[#4DD8E8]"
                  >
                    {demoMode ? 'DEMO MODE' : 'LIVE MODE'}
                  </button>

                  <button
                    type="button"
                    onClick={connected ? disconnectWallet : connectWallet}
                    className="inline-flex items-center gap-2 rounded-xl bg-[#B8F36B] px-4 py-2.5 text-sm font-semibold text-[#0B0D10] transition hover:brightness-110"
                  >
                    <Wallet className="h-4 w-4" />
                    {connected ? 'Disconnect' : 'Connect Wallet'}
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={() => {
                  setSyncing(true);
                  void refreshContractData();
                }}
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-[#13171C] px-3.5 py-2.5 text-sm text-slate-200 hover:bg-white/5"
              >
                <RefreshCcw className="h-4 w-4" />
                Refresh
              </button>

              <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-[#11161B] px-3 py-2 text-[10px] uppercase tracking-[0.2em] text-slate-300">
                <span className="h-2 w-2 rounded-full bg-[#4DD8E8]" />
                {pendingTx || txStatus}
              </div>
            </div>
          </div>
        </header>

        {mobileNavOpen && (
          <div className="border-b border-white/10 bg-[#11161B] px-4 py-3 xl:hidden">
            <div className="grid gap-2">
              {NAV_ITEMS.map(({ key, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setActiveTab(key);
                    setMobileNavOpen(false);
                  }}
                  className={`flex items-center gap-3 rounded-xl px-4 py-3 text-left text-sm font-medium ${
                    activeTab === key ? 'bg-[#B8F36B]/10 text-[#B8F36B]' : 'text-slate-300'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {key}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-x-hidden px-4 py-5 sm:px-5 xl:px-6">
          {errorMessage && (
            <div className="mb-4 flex items-start gap-3 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}

          {syncing && (
            <div className="mb-5 overflow-hidden rounded-2xl border border-white/10 bg-[#12181D] p-5">
              <div className="loader-panel" aria-live="polite" aria-busy="true">
                <div className="loader-overlay" aria-hidden="true" />
                <div className="loader-text" aria-label="Syncing data">
                  {Array.from('SYNCING DATA').map((letter, index) => (
                    <span key={`${letter}-${index}`} style={{ animationDelay: `${index * 0.12}s` }}>
                      {letter}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'Overview' && (
            <div className="space-y-5">
              <section className="rounded-3xl border border-white/10 bg-[#11161B] p-5 sm:p-6">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <div className="inline-flex items-center gap-2 rounded-full border border-[#B8F36B]/30 bg-[#B8F36B]/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#B8F36B]">
                      <span className="h-2 w-2 rounded-full bg-[#B8F36B]" />
                      {demoMode ? 'Demo mode active' : 'Operational status'}
                    </div>
                    <h2 className="mt-4 text-3xl font-semibold tracking-tight text-white">Battery Intelligence Center</h2>
                    <p className="mt-2 text-sm text-slate-400">Real-time battery health, telematics, and safety monitoring.</p>
                  </div>
                  <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-[#0F1418] px-4 py-3 text-sm text-slate-300">
                    <ShieldCheck className="h-4 w-4 text-[#B8F36B]" />
                    <div>
                      <div className="font-medium text-white">System status</div>
                      <div className="text-slate-400">{demoMode ? 'Demo backend data loaded' : 'Blockchain connected and healthy'}</div>
                    </div>
                  </div>
                </div>
              </section>

              <section className="metric-slider-section">
                <AnimatedMetricSlider metrics={overviewMetrics.slice(0, 3)} />
              </section>

              <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                {overviewMetrics.slice(3).map(({ label, value, status, icon: Icon }) => (
                  <KpiCard key={label} label={label} value={value} status={status} icon={Icon} />
                ))}
              </section>

              <section className="grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
                <div className="rounded-3xl border border-white/10 bg-[#11161B] p-5">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <div>
                      <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Battery Health</div>
                      <h3 className="mt-2 text-2xl font-semibold text-white">State of Health</h3>
                    </div>
                    <div className="rounded-full border border-[#4DD8E8]/30 bg-[#4DD8E8]/10 px-3 py-1 text-xs font-medium text-[#4DD8E8]">
                      {getSoHLabel(currentGauge.soH)}
                    </div>
                  </div>

                  <div className="flex flex-col items-center gap-5 md:flex-row md:items-center md:justify-between">
                    <BatteryHealthGauge soH={gaugeValue} temperature={currentGauge.temperature} voltage={currentGauge.voltage} timestamp={currentGauge.timestamp} />
                    <div className="grid w-full max-w-md gap-3 sm:grid-cols-3">
                      <div className="rounded-2xl border border-white/10 bg-[#171D24] p-3">
                        <div className="text-[11px] uppercase tracking-[0.2em] text-slate-400">Temp</div>
                        <div className="mt-3 text-2xl font-semibold text-white">{currentGauge.temperature.toFixed(1)}°C</div>
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-[#171D24] p-3">
                        <div className="text-[11px] uppercase tracking-[0.2em] text-slate-400">Voltage</div>
                        <div className="mt-3 text-2xl font-semibold text-white">{currentGauge.voltage.toFixed(1)}V</div>
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-[#171D24] p-3">
                        <div className="text-[11px] uppercase tracking-[0.2em] text-slate-400">Updated</div>
                        <div className="mt-3 text-sm font-semibold text-white">{new Date(currentGauge.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-3xl border border-white/10 bg-[#11161B] p-5">
                  <div className="mb-4 text-xs uppercase tracking-[0.2em] text-slate-400">Health insight</div>
                  <div className="space-y-4">
                    <div className="rounded-2xl border border-[#B8F36B]/30 bg-[#B8F36B]/10 p-4">
                      <div className="text-sm text-slate-300">Current interpretation</div>
                      <div className="mt-2 text-2xl font-semibold text-[#B8F36B]">{getSoHLabel(gaugeValue)}</div>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-[#171D24] p-4">
                      <div className="flex items-center justify-between text-sm text-slate-300">
                        <span>Thermal band</span>
                        <span className="font-medium text-white">{currentGauge.temperature > 45 ? 'Hot' : currentGauge.temperature > 35 ? 'Warm' : 'Nominal'}</span>
                      </div>
                      <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-slate-700">
                        <div className="h-full rounded-full bg-gradient-to-r from-[#B8F36B] via-[#4DD8E8] to-[#F7B267]" style={{ width: `${Math.min((currentGauge.temperature / 60) * 100, 100)}%` }} />
                      </div>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-[#171D24] p-4 text-sm text-slate-300">
                      <div className="flex items-center justify-between">
                        <span>Contract health</span>
                        <span className="font-medium text-[#B8F36B]">{demoMode ? 'Demo backend' : 'Live contract'}</span>
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <span>{demoMode ? 'Submission access' : 'Oracle access'}</span>
                        <span className="font-medium text-white">{demoMode ? 'Demo' : canSubmitTelemetry ? 'Authorized' : 'Restricted'}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              <section className="rounded-3xl border border-white/10 bg-[#11161B] p-5">
                <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Telemetry</div>
                    <h3 className="mt-2 text-2xl font-semibold text-white">Battery analytics</h3>
                  </div>
                  <div className="flex gap-2 rounded-xl border border-white/10 bg-[#0F1418] p-1">
                    {['soH', 'temperature', 'voltage'].map((metric) => (
                      <button
                        key={metric}
                        type="button"
                        onClick={() => setSelectedChartMetric(metric as 'soH' | 'temperature' | 'voltage')}
                        className={`rounded-lg px-3 py-1.5 text-sm ${selectedChartMetric === metric ? 'bg-[#B8F36B] text-[#0B0D10]' : 'text-slate-300'}`}
                      >
                        {metric === 'soH' ? 'SoH' : metric === 'temperature' ? 'Temp' : 'Voltage'}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="h-[280px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData}>
                      <CartesianGrid stroke="#2A2E35" vertical={false} strokeDasharray="3 3" />
                      <XAxis dataKey="label" tick={{ fill: '#929BA7', fontSize: 11 }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fill: '#929BA7', fontSize: 11 }} tickLine={false} axisLine={false} />
                      <Tooltip
                        contentStyle={{ background: '#11161B', borderColor: '#2A2E35', borderRadius: 12, color: '#F5F7FA' }}
                        formatter={(value: unknown) => {
                          const numeric = Number(Array.isArray(value) ? value[0] : value ?? 0);
                          return [`${numeric.toFixed(1)}`, selectedChartMetric === 'soH' ? 'SoH %' : selectedChartMetric === 'temperature' ? '°C' : 'V'];
                        }}
                      />
                      <Line type="monotone" dataKey={selectedChartMetric === 'soH' ? 'soH' : selectedChartMetric === 'temperature' ? 'temperature' : 'voltage'} stroke="#B8F36B" strokeWidth={2.5} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </section>

              <section className="rounded-3xl border border-white/10 bg-[#11161B] p-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs uppercase tracking-[0.2em] text-slate-400">History</div>
                    <h3 className="mt-2 text-2xl font-semibold text-white">Recent telemetry</h3>
                  </div>
                  <div className="rounded-full border border-white/10 bg-[#171D24] px-3 py-1 text-xs text-slate-300">
                    {history.length} records
                  </div>
                </div>

                {history.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-left text-sm text-slate-200">
                      <thead className="text-xs uppercase tracking-[0.2em] text-slate-400">
                        <tr>
                          <th className="pb-3 pr-4">Vehicle</th>
                          <th className="pb-3 pr-4">Timestamp</th>
                          <th className="pb-3 pr-4">SoH</th>
                          <th className="pb-3 pr-4">Temp</th>
                          <th className="pb-3 pr-4">Voltage</th>
                          <th className="pb-3 pr-4">Error</th>
                          <th className="pb-3 pr-4">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.slice(0, 6).map((entry) => (
                          <tr key={`${entry.vehicleId}-${entry.timestamp}`} className="border-t border-white/10 text-slate-200">
                            <td className="py-3 pr-4 font-medium text-white">{entry.vehicleId}</td>
                            <td className="py-3 pr-4">{new Date(entry.timestamp).toLocaleString()}</td>
                            <td className="py-3 pr-4">{entry.soH.toFixed(1)}%</td>
                            <td className="py-3 pr-4">{entry.temperature.toFixed(1)}°C</td>
                            <td className="py-3 pr-4">{entry.voltage.toFixed(1)}V</td>
                            <td className="py-3 pr-4">{entry.errorCode}</td>
                            <td className="py-3 pr-4">
                              <span className={`inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-medium ${entry.status === 'Critical' ? 'border-red-500/30 bg-red-500/10 text-red-200' : entry.status === 'Warning' ? 'border-amber-500/30 bg-amber-500/10 text-amber-200' : 'border-[#B8F36B]/30 bg-[#B8F36B]/10 text-[#B8F36B]'}`}>
                                {entry.status}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <EmptyState title="No telemetry yet" description="This vehicle has no health log entries in the configured network." />
                )}
              </section>

              <section className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
                <div className="rounded-3xl border border-white/10 bg-[#11161B] p-5">
                  <div className="flex items-center gap-3">
                    <CloudSun className="h-5 w-5 text-[#4DD8E8]" />
                    <div>
                      <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Free live data</div>
                      <h3 className="mt-1 text-xl font-semibold text-white">Local weather</h3>
                    </div>
                  </div>
                  <form onSubmit={handlePublicLocationSubmit} className="mt-4 grid gap-3 sm:grid-cols-2">
                    <label className="text-xs text-slate-400">
                      Latitude
                      <input type="number" min="-90" max="90" step="any" value={publicLatitude} onChange={(event) => setPublicLatitude(event.target.value)} className="mt-1 w-full rounded-xl border border-white/10 bg-[#171D24] px-3 py-2 text-sm text-white" />
                    </label>
                    <label className="text-xs text-slate-400">
                      Longitude
                      <input type="number" min="-180" max="180" step="any" value={publicLongitude} onChange={(event) => setPublicLongitude(event.target.value)} className="mt-1 w-full rounded-xl border border-white/10 bg-[#171D24] px-3 py-2 text-sm text-white" />
                    </label>
                    <div className="flex flex-wrap gap-2 sm:col-span-2">
                      <button type="submit" disabled={publicDataLoading} className="inline-flex items-center gap-2 rounded-xl bg-[#4DD8E8] px-3 py-2 text-xs font-semibold text-[#0B0D10] disabled:opacity-50">
                        <Search className="h-3.5 w-3.5" /> {publicDataLoading ? 'Loading public data…' : 'Load this location'}
                      </button>
                      <button type="button" onClick={useCurrentLocation} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-[#171D24] px-3 py-2 text-xs text-slate-200">
                        <MapPin className="h-3.5 w-3.5" /> Use my location
                      </button>
                    </div>
                  </form>
                  <p className="mt-3 text-[11px] leading-5 text-slate-500">
                    The dashboard loads the sample San Francisco location on startup. Coordinates are sent to Open-Meteo and OpenStreetMap through this backend and are not written to the demo data store. Browser location is requested only when you select “Use my location”.
                  </p>
                  {publicWeather && (
                    <div className="mt-4 rounded-2xl border border-white/10 bg-[#171D24] p-4">
                      <div className="flex items-baseline justify-between gap-2">
                        <div className="text-3xl font-semibold text-white">{publicWeather.temperatureC.toFixed(1)}°C</div>
                        <div className="text-sm text-[#4DD8E8]">{describeWeatherCode(publicWeather.weatherCode)}</div>
                      </div>
                      <div className="mt-2 text-sm text-slate-400">
                        Feels like {publicWeather.apparentTemperatureC.toFixed(1)}°C · Humidity {publicWeather.relativeHumidity}%
                      </div>
                      <div className="mt-2 text-xs text-slate-500">{publicWeather.timezone} · Updated {publicWeather.observedAt}</div>
                      <div className="mt-2 text-[11px] text-slate-500">{publicWeather.attribution}</div>
                    </div>
                  )}
                  {publicDataError && <p role="status" className="mt-3 text-xs text-amber-200">{publicDataError}</p>}
                </div>

                <div className="rounded-3xl border border-white/10 bg-[#11161B] p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <Plug className="h-5 w-5 text-[#B8F36B]" />
                      <div>
                        <div className="text-xs uppercase tracking-[0.2em] text-slate-400">OpenStreetMap · 5 km</div>
                        <h3 className="mt-1 text-xl font-semibold text-white">Nearby charging stations</h3>
                      </div>
                    </div>
                    <div className="rounded-full border border-white/10 bg-[#171D24] px-3 py-1 text-xs text-slate-300">{chargingStations.length} found</div>
                  </div>
                  <div className="mt-4 space-y-2">
                    {chargingStations.slice(0, 5).map((station) => (
                      <a
                        key={station.id}
                        href={`https://www.openstreetmap.org/${station.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-[#171D24] px-3 py-2.5 hover:border-[#4DD8E8]/40"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-white">{station.name}</span>
                          <span className="block truncate text-xs text-slate-400">{station.operator || station.connectors.join(' · ') || 'Charging station'}</span>
                        </span>
                        <span className="shrink-0 text-xs text-[#B8F36B]">{station.distanceKm.toFixed(1)} km</span>
                      </a>
                    ))}
                    {chargingStations.length === 0 && (
                      <div className="rounded-xl border border-dashed border-white/10 bg-[#171D24] p-4 text-sm text-slate-400">
                        {publicDataLoading ? 'Searching public map data…' : 'No mapped stations found for this area.'}
                      </div>
                    )}
                  </div>
                  <div className="mt-3 text-[11px] text-slate-500">© OpenStreetMap contributors · Map data can be incomplete. Select a location to refresh.</div>
                </div>
              </section>
            </div>
          )}

          {activeTab === 'Vehicles' && (
            <div className="space-y-5">
              <section className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
                <div className="rounded-3xl border border-white/10 bg-[#11161B] p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Fleet registry</div>
                      <h3 className="mt-2 text-2xl font-semibold text-white">Registered vehicles</h3>
                    </div>
                    <div className="rounded-full border border-white/10 bg-[#171D24] px-3 py-1 text-xs text-slate-300">{vehicleSummaries.length} total</div>
                  </div>

                  <div className="mt-5 grid gap-4 md:grid-cols-2">
                    {vehicleSummaries.map((vehicle) => (
                      <div key={vehicle.vehicleId} className="rounded-2xl border border-white/10 bg-[#171D24] p-4">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-lg font-semibold text-white">{vehicle.vehicleId}</div>
                          <span className={`rounded-full border px-2 py-1 text-[10px] uppercase tracking-[0.2em] ${vehicle.status === 'Degraded' ? 'border-amber-500/30 bg-amber-500/10 text-amber-200' : vehicle.status === 'Warning' ? 'border-yellow-500/30 bg-yellow-500/10 text-yellow-200' : 'border-[#B8F36B]/30 bg-[#B8F36B]/10 text-[#B8F36B]'}`}>
                            {vehicle.status}
                          </span>
                        </div>
                        <div className="mt-4 grid grid-cols-2 gap-3 text-sm text-slate-300">
                          <div>
                            <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">SoH</div>
                            <div className="mt-1 text-xl font-semibold text-white">{vehicle.latestSoH.toFixed(1)}%</div>
                          </div>
                          <div>
                            <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Temp</div>
                            <div className="mt-1 text-xl font-semibold text-white">{vehicle.latestTemp.toFixed(1)}°C</div>
                          </div>
                        </div>
                        <div className="mt-4 text-sm text-slate-400">
                          Last update: {new Date(vehicle.timestamp).toLocaleString()}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-3xl border border-white/10 bg-[#11161B] p-5">
                  <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Vehicle registry</div>
                  <h3 className="mt-2 text-2xl font-semibold text-white">Register a vehicle</h3>
                  <p className="mt-2 text-sm text-slate-400">Vehicle IDs are encoded as bytes32 using ethers.encodeBytes32String(vehicleId) for contract compatibility.</p>

                  <form onSubmit={handleRegisterVehicle} className="mt-5 space-y-4">
                    <label className="block text-sm text-slate-300">
                      Vehicle identifier
                      <input
                        value={vehicleRegistryInput}
                        onChange={(event) => setVehicleRegistryInput(event.target.value)}
                        className="mt-2 w-full rounded-xl border border-white/10 bg-[#171D24] px-3 py-2.5 text-white outline-none ring-0 placeholder:text-slate-500 focus:border-[#B8F36B]/50"
                        placeholder="VEH-004"
                      />
                    </label>
                    <div className="rounded-xl border border-[#4DD8E8]/20 bg-[#4DD8E8]/5 p-3 text-sm text-slate-300">
                      Contract value: <span className="font-mono text-[#4DD8E8]">{getVehicleIdBytes32(vehicleRegistryInput || 'VEH-004')}</span>
                    </div>
                    <button
                      type="submit"
                      className="w-full rounded-xl bg-[#B8F36B] px-4 py-3 font-semibold text-[#0B0D10] disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={!canRegisterVehicle}
                    >
                      {canRegisterVehicle ? 'Register vehicle' : 'Owner-only action'}
                    </button>
                  </form>
                </div>
              </section>

              <section className="rounded-3xl border border-white/10 bg-[#11161B] p-5">
                <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Free vehicle data · NHTSA vPIC</div>
                <h3 className="mt-2 text-2xl font-semibold text-white">Decode EV specifications</h3>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
                  Optionally look up make, model, year, fuel/electrification, and any battery details NHTSA has for a 17-character VIN. The VIN is sent to the public NHTSA decoder and briefly cached in server memory; it is not written to the demo data store.
                </p>
                <form onSubmit={(event) => void loadVehicleSpecs(event)} className="mt-5 flex flex-col gap-3 sm:flex-row">
                  <input
                    aria-label="Vehicle VIN"
                    autoComplete="off"
                    maxLength={17}
                    minLength={17}
                    pattern="[A-HJ-NPR-Z0-9]{17}"
                    value={vehicleSpecsVin}
                    onChange={(event) => setVehicleSpecsVin(event.target.value.toUpperCase())}
                    placeholder="Enter 17-character VIN"
                    className="min-w-0 flex-1 rounded-xl border border-white/10 bg-[#171D24] px-3 py-3 font-mono text-sm text-white outline-none placeholder:text-slate-500 focus:border-[#4DD8E8]/50"
                  />
                  <button type="submit" disabled={vehicleSpecsLoading || vehicleSpecsVin.length !== 17} className="rounded-xl bg-[#4DD8E8] px-5 py-3 text-sm font-semibold text-[#0B0D10] disabled:cursor-not-allowed disabled:opacity-50">
                    {vehicleSpecsLoading ? 'Looking up…' : 'Decode VIN'}
                  </button>
                </form>
                {vehicleSpecsError && <p role="alert" className="mt-3 text-sm text-amber-200">{vehicleSpecsError}</p>}
                {vehicleSpecs && (
                  <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    {[
                      ['Vehicle', [vehicleSpecs.modelYear, vehicleSpecs.make, vehicleSpecs.model].filter(Boolean).join(' ')],
                      ['Electric type', vehicleSpecs.electrificationLevel || vehicleSpecs.fuelType],
                      ['Battery', [vehicleSpecs.batteryCapacityKwh && `${vehicleSpecs.batteryCapacityKwh} kWh`, vehicleSpecs.batteryType].filter(Boolean).join(' · ')],
                      ['Drive unit', vehicleSpecs.driveUnit || vehicleSpecs.bodyClass],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-2xl border border-white/10 bg-[#171D24] p-4">
                        <div className="text-[11px] uppercase tracking-[0.2em] text-slate-400">{label}</div>
                        <div className="mt-2 text-sm font-medium text-white">{value || 'Not reported by source'}</div>
                      </div>
                    ))}
                    <div className="text-xs text-slate-500 sm:col-span-2 lg:col-span-4">{vehicleSpecs.attribution}</div>
                  </div>
                )}
              </section>
            </div>
          )}

          {activeTab === 'Safety Alerts' && (
            <div className="space-y-5">
              <section className="rounded-3xl border border-white/10 bg-[#11161B] p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Safety monitoring</div>
                    <h3 className="mt-2 text-2xl font-semibold text-white">Alert feed</h3>
                  </div>
                  <div className="rounded-full border border-[#4DD8E8]/30 bg-[#4DD8E8]/10 px-3 py-1 text-xs text-[#4DD8E8]">{alerts.length} active</div>
                </div>

                {alerts.length > 0 ? (
                  <div className="mt-5 space-y-3">
                    {alerts.map((alert) => (
                      <div key={alert.id} className={`rounded-2xl border p-4 ${getAlertTone(alert.severity)}`}>
                        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                          <div className="flex items-center gap-3">
                            {alert.severity === 'Critical' ? <ShieldAlert className="h-5 w-5" /> : alert.severity === 'Degraded' ? <AlertTriangle className="h-5 w-5" /> : <BellRing className="h-5 w-5" />}
                            <div>
                              <div className="text-lg font-semibold text-white">{alert.severity}</div>
                              <div className="text-sm text-slate-200">{alert.vehicleId}</div>
                            </div>
                          </div>
                          <div className="text-sm text-slate-200">{new Date(alert.timestamp).toLocaleString()}</div>
                        </div>
                        <div className="mt-4 text-sm text-slate-100">{alert.message}</div>
                        <div className="mt-3 flex flex-wrap gap-3 text-xs uppercase tracking-[0.16em] text-slate-300">
                          <span>Trigger: {alert.triggerValue}</span>
                          {alert.txHash && <span>Tx: {formatShortAddress(alert.txHash)}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="No alerts" description="No high-risk conditions were detected in the current contract state." />
                )}
              </section>
            </div>
          )}

          {activeTab === 'Administration' && (
            <div className="space-y-5">
              <section className="grid gap-5 xl:grid-cols-2">
                <div className="rounded-3xl border border-white/10 bg-[#11161B] p-5">
                  {demoMode ? (
                    <>
                      <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Demo environment</div>
                      <h3 className="mt-2 text-2xl font-semibold text-white">Backend connected</h3>
                      <p className="mt-3 text-sm leading-6 text-slate-400">Demo vehicle and telemetry changes are saved by the API. No wallet, account, or blockchain transaction is needed.</p>
                      <div className="mt-5 rounded-2xl border border-[#B8F36B]/30 bg-[#B8F36B]/10 p-4 text-sm text-[#D9F5B0]">Public sample data only — do not submit private or real vehicle data.</div>
                    </>
                  ) : (
                    <>
                      <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Contract</div>
                      <h3 className="mt-2 text-2xl font-semibold text-white">Blockchain configuration</h3>
                      <div className="mt-4 space-y-3 text-sm text-slate-300">
                        <div className="rounded-2xl border border-white/10 bg-[#171D24] p-3">
                          <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Address</div>
                          <div className="mt-2 font-mono text-xs text-white break-all">{contractAddress}</div>
                        </div>
                        <div className="rounded-2xl border border-white/10 bg-[#171D24] p-3">
                          <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Owner</div>
                          <div className="mt-2 font-mono text-xs text-white break-all">{ownerAddress}</div>
                        </div>
                        <div className="rounded-2xl border border-white/10 bg-[#171D24] p-3">
                          <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Authorized oracle</div>
                          <div className="mt-2 font-mono text-xs text-white break-all">{oracleAddress}</div>
                        </div>
                        <div className="rounded-2xl border border-white/10 bg-[#171D24] p-3">
                          <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">Connection</div>
                          <div className="mt-2 text-white">Chain {chainId} · {chainName}</div>
                        </div>
                      </div>
                    </>
                  )}
                </div>

                {!demoMode && (
                  <div className="rounded-3xl border border-white/10 bg-[#11161B] p-5">
                    <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Oracle</div>
                    <h3 className="mt-2 text-2xl font-semibold text-white">Set authorized oracle</h3>
                    <form onSubmit={handleSetOracle} className="mt-5 space-y-4">
                      <label className="block text-sm text-slate-300">
                        Oracle wallet address
                        <input
                          value={oracleInput}
                          onChange={(event) => setOracleInput(event.target.value)}
                          className="mt-2 w-full rounded-xl border border-white/10 bg-[#171D24] px-3 py-2.5 text-white outline-none placeholder:text-slate-500 focus:border-[#4DD8E8]/50"
                          placeholder="0x..."
                        />
                      </label>
                      <button
                        type="submit"
                        className="w-full rounded-xl bg-[#4DD8E8] px-4 py-3 font-semibold text-[#0B0D10] disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={!canRegisterVehicle}
                      >
                        {canRegisterVehicle ? 'Update oracle' : 'Owner-only action'}
                      </button>
                    </form>
                  </div>
                )}
              </section>

              <section className="rounded-3xl border border-white/10 bg-[#11161B] p-5">
                <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Manual telemetry</div>
                <h3 className="mt-2 text-2xl font-semibold text-white">{demoMode ? 'Submit demo telemetry' : 'Direct telemetry submission'}</h3>
                <p className="mt-2 text-sm text-slate-400">{demoMode ? 'Add a sample reading to the demo backend. This does not create a blockchain transaction.' : 'In production, telemetry should be submitted by a secure IoT gateway or backend. Direct browser submission is restricted to the authorized oracle wallet and marked as manual telemetry.'}</p>

                <form onSubmit={handleTelemetrySubmit} className="mt-5 grid gap-4 md:grid-cols-2">
                  <label className="block text-sm text-slate-300">
                    SoH (%)
                    <input value={manualForm.soH} onChange={(event) => setManualForm((current) => ({ ...current, soH: event.target.value }))} className="mt-2 w-full rounded-xl border border-white/10 bg-[#171D24] px-3 py-2.5 text-white outline-none focus:border-[#B8F36B]/50" />
                  </label>
                  <label className="block text-sm text-slate-300">
                    Temperature (°C)
                    <input value={manualForm.temperature} onChange={(event) => setManualForm((current) => ({ ...current, temperature: event.target.value }))} className="mt-2 w-full rounded-xl border border-white/10 bg-[#171D24] px-3 py-2.5 text-white outline-none focus:border-[#B8F36B]/50" />
                  </label>
                  <label className="block text-sm text-slate-300">
                    Voltage (V)
                    <input value={manualForm.voltage} onChange={(event) => setManualForm((current) => ({ ...current, voltage: event.target.value }))} className="mt-2 w-full rounded-xl border border-white/10 bg-[#171D24] px-3 py-2.5 text-white outline-none focus:border-[#B8F36B]/50" />
                  </label>
                  <label className="block text-sm text-slate-300">
                    Error code
                    <input value={manualForm.errorCode} onChange={(event) => setManualForm((current) => ({ ...current, errorCode: event.target.value }))} className="mt-2 w-full rounded-xl border border-white/10 bg-[#171D24] px-3 py-2.5 text-white outline-none focus:border-[#B8F36B]/50" />
                  </label>
                  <div className="md:col-span-2 flex flex-wrap items-center gap-3">
                    <button type="submit" className="rounded-xl bg-[#B8F36B] px-4 py-3 font-semibold text-[#0B0D10] disabled:cursor-not-allowed disabled:opacity-50" disabled={!canSubmitTelemetry}>
                      {demoMode ? 'Save demo telemetry' : 'Submit telemetry'}
                    </button>
                    <div className="rounded-full border border-white/10 bg-[#171D24] px-3 py-1.5 text-xs text-slate-300">
                      {demoMode ? 'No wallet required' : canSubmitTelemetry ? 'Eligible oracle wallet' : 'Oracle-only action'}
                    </div>
                  </div>
                </form>
              </section>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

type AnimatedMetricCardProps = {
  label: string;
  value: string;
  status: string;
  icon: typeof BatteryCharging;
};

function AnimatedMetricCard({ label, value, status, icon: Icon }: AnimatedMetricCardProps) {
  return (
    <div className="metric-card-wrap metric-slide">
      <div className="metric-card" aria-label={`${label}: ${value}`}>
        <div className="metric-card-inner">
          <div className="metric-header">
            <span className="metric-label">{label}</span>
            <Icon className="metric-icon" />
          </div>
          <div className="metric-value">{value}</div>
          <div className="metric-status">{status}</div>
        </div>
      </div>
    </div>
  );
}

type KpiCardProps = {
  label: string;
  value: string;
  status: string;
  icon: typeof BatteryCharging;
};

function KpiCard({ label, value, status, icon: Icon }: KpiCardProps) {
  return (
    <div className="rounded-2xl border border-white/10 bg-[#11161B] p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.2em] text-slate-400">{label}</div>
          <div className="mt-3 text-3xl font-semibold text-white">{value}</div>
        </div>
        <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[#B8F36B]/30 bg-[#B8F36B]/10 text-[#B8F36B]">
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <div className="mt-4 text-sm text-slate-400">{status}</div>
    </div>
  );
}

type BatteryHealthGaugeProps = {
  soH: number;
  temperature: number;
  voltage: number;
  timestamp: number;
};

function BatteryHealthGauge({ soH, temperature, voltage, timestamp }: BatteryHealthGaugeProps) {
  const radius = 72;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (soH / 100) * circumference;

  return (
    <div className="flex items-center gap-6">
      <div className="gauge-shell">
        <svg viewBox="0 0 180 180" className="h-40 w-40">
          <circle cx="90" cy="90" r={radius} className="gauge-bg" />
          <circle
            cx="90"
            cy="90"
            r={radius}
            className="gauge-ring"
            stroke="#B8F36B"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
          />
        </svg>
        <div className="gauge-value">
          <div className="text-4xl font-semibold text-white">{Number.isFinite(soH) ? Math.round(soH) : 0}%</div>
        </div>
      </div>
      <div className="space-y-3 text-sm text-slate-300">
        <div className="flex items-center gap-2"><BatteryFull className="h-4 w-4 text-[#B8F36B]" /> Battery capacity: {Number.isFinite(soH) ? Math.round(soH) : 0}%</div>
        <div className="flex items-center gap-2"><Thermometer className="h-4 w-4 text-[#4DD8E8]" /> Temperature: {temperature.toFixed(1)}°C</div>
        <div className="flex items-center gap-2"><Bolt className="h-4 w-4 text-[#B8F36B]" /> Voltage: {voltage.toFixed(1)}V</div>
        <div className="flex items-center gap-2"><Activity className="h-4 w-4 text-slate-400" /> Last update: {new Date(timestamp).toLocaleString()}</div>
      </div>
    </div>
  );
}

type EmptyStateProps = {
  title: string;
  description: string;
};

function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <div className="flex min-h-40 items-center justify-center rounded-2xl border border-dashed border-white/10 bg-[#171D24] p-8 text-center">
      <div>
        <div className="text-lg font-semibold text-white">{title}</div>
        <div className="mt-2 max-w-md text-sm text-slate-400">{description}</div>
      </div>
    </div>
  );
}

export default App;
