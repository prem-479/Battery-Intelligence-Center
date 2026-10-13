import { useMemo } from 'react';
import { AlertTriangle, CircleHelp, Thermometer } from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { assessThermalRisk, summarizePackTemperatures, THERMAL_THRESHOLDS } from './thermal/thermalAnalysis.js';

type ThermalTelemetry = {
  vehicleId: string;
  timestamp: number;
  temperature: number;
  errorCode: number;
};

type Props = {
  vehicleId: string;
  latest: ThermalTelemetry | null;
  history: ThermalTelemetry[];
  demoMode: boolean;
};

const statusTone: Record<string, string> = {
  Nominal: 'border-[#B8F36B]/30 bg-[#B8F36B]/10 text-[#D9F5B0]',
  Warning: 'border-amber-400/30 bg-amber-400/10 text-amber-100',
  Critical: 'border-red-400/30 bg-red-400/10 text-red-100',
  'Stale telemetry': 'border-amber-400/30 bg-amber-400/10 text-amber-100',
  'Sensor unavailable': 'border-white/15 bg-white/5 text-slate-300',
};

function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-[#171D24] p-4">
      <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400">{label}</div>
      <div className="mt-3 text-2xl font-semibold text-white">{value}</div>
      <div className="mt-2 text-xs leading-5 text-slate-400">{detail}</div>
    </div>
  );
}

export default function ThermalIntelligence({ vehicleId, latest, history, demoMode }: Props) {
  const assessment = useMemo(() => assessThermalRisk(latest), [latest]);
  const summary = useMemo(() => summarizePackTemperatures(history), [history]);
  const chartData = useMemo(
    () => [...history]
      .filter((reading) => Number.isFinite(reading.temperature) && Number.isFinite(reading.timestamp))
      .sort((left, right) => left.timestamp - right.timestamp)
      .map((reading) => ({
        timestamp: reading.timestamp,
        temperature: reading.temperature,
        label: new Date(reading.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      })),
    [history],
  );

  return (
    <div className="space-y-5">
      <section className="rounded-3xl border border-white/10 bg-[#11161B] p-5 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-[#4DD8E8]/30 bg-[#4DD8E8]/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#4DD8E8]">
              <Thermometer className="h-3.5 w-3.5" />
              Transparent threshold baseline
            </div>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-white">Thermal intelligence</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
              Pack-level telemetry checks for {vehicleId}. This view applies documented rules to the available temperature and timestamp; it is not an AI model, cell-level monitor, or cooling-system simulation.
            </p>
          </div>
          <div className={`rounded-xl border px-4 py-3 text-sm ${statusTone[assessment.status]}`}>
            <div className="text-[10px] uppercase tracking-[0.18em] opacity-80">Current rule assessment</div>
            <div className="mt-1 text-lg font-semibold">{assessment.status}</div>
            <ul className="mt-2 list-inside list-disc text-xs leading-5">
              {assessment.reasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          </div>
        </div>
        <div className="mt-5 rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-xs leading-5 text-amber-100">
          Provenance: {demoMode ? 'sample/demo telemetry' : 'backend telemetry; source is not independently verified'}. The app has no live BMS connection or per-cell sensor data.
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Latest pack temperature"
          value={latest && Number.isFinite(latest.temperature) ? `${latest.temperature.toFixed(1)}°C` : 'Unavailable'}
          detail={latest ? `Recorded ${new Date(latest.timestamp).toLocaleString()}` : 'No selected-vehicle reading available.'}
        />
        <MetricCard
          label="Observed history range"
          value={summary ? `${summary.observedRangeC.toFixed(1)}°C` : 'Unavailable'}
          detail={summary ? `${summary.sampleCount} pack-level readings, ${summary.minimumC.toFixed(1)}–${summary.maximumC.toFixed(1)}°C. Not a cell-to-cell spread.` : 'No valid pack-temperature history.'}
        />
        <MetricCard
          label="Mean of available readings"
          value={summary ? `${summary.meanC.toFixed(1)}°C` : 'Unavailable'}
          detail="Descriptive average of the selected vehicle's available history; not a forecast."
        />
        <MetricCard
          label="Cell temperature spread"
          value="Not measured"
          detail={`Design target ≤${THERMAL_THRESHOLDS.targetMaximumCellSpreadC}°C cannot be assessed without synchronized per-cell sensors.`}
        />
      </section>

      <section className="grid gap-5 xl:grid-cols-[1.3fr_0.7fr]">
        <div className="rounded-3xl border border-white/10 bg-[#11161B] p-5">
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Recorded telemetry</div>
            <h3 className="mt-2 text-xl font-semibold text-white">Pack temperature over time</h3>
            <p className="mt-1 text-xs text-slate-500">Shaded band is the project's 15–45°C reference range, not a certified safe operating envelope.</p>
          </div>
          {chartData.length > 0 ? (
            <div className="mt-5 h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                  <CartesianGrid stroke="#2A2E35" vertical={false} strokeDasharray="3 3" />
                  <ReferenceArea y1={THERMAL_THRESHOLDS.referenceMinimumC} y2={THERMAL_THRESHOLDS.criticalTemperatureC} fill="#B8F36B" fillOpacity={0.07} />
                  <XAxis dataKey="label" tick={{ fill: '#929BA7', fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={24} />
                  <YAxis
                    domain={['dataMin - 3', 'dataMax + 3']}
                    tick={{ fill: '#929BA7', fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    width={52}
                    unit="°C"
                  />
                  <Tooltip
                    contentStyle={{ background: '#11161B', border: '1px solid #343B44', borderRadius: 12 }}
                    labelStyle={{ color: '#CBD5E1' }}
                    formatter={(value) => [`${Number(value).toFixed(1)}°C`, 'Pack temperature']}
                  />
                  <Line type="monotone" dataKey="temperature" name="Pack temperature" stroke="#4DD8E8" strokeWidth={2.5} dot={{ r: 3, fill: '#4DD8E8' }} activeDot={{ r: 5 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="mt-5 flex h-[220px] items-center justify-center rounded-2xl border border-dashed border-white/10 text-sm text-slate-400">
              No valid temperature history for this vehicle.
            </div>
          )}
        </div>

        <div className="space-y-5">
          <div className="rounded-3xl border border-white/10 bg-[#11161B] p-5">
            <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Model status</div>
            <h3 className="mt-2 text-xl font-semibold text-white">No predictive model enabled</h3>
            <p className="mt-3 text-sm leading-6 text-slate-400">
              There is no validated training dataset, trained model, or uncertainty calibration in this repository. Risk labels above are threshold rules only; no future temperature or remaining time is predicted.
            </p>
            <div className="mt-4 flex items-start gap-2 rounded-xl border border-white/10 bg-[#171D24] p-3 text-xs leading-5 text-slate-300">
              <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-[#4DD8E8]" />
              CFD outputs, coolant flow, pressure drop, and heat-transfer coefficients are not available from current app data.
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-[#11161B] p-5">
            <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Research configuration</div>
            <h3 className="mt-2 text-xl font-semibold text-white">Concept only · not simulated</h3>
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
              {[
                ['Pack layout', '10 × 21700 cells'],
                ['Channel concept', 'Circular · 1 mm Dh'],
                ['Flow regime', 'Re 400–700'],
                ['Coolant concept', 'Water-based Al₂O₃'],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl border border-white/10 bg-[#171D24] p-3">
                  <div className="text-[10px] uppercase tracking-[0.12em] text-slate-500">{label}</div>
                  <div className="mt-1 font-medium text-slate-200">{value}</div>
                </div>
              ))}
            </div>
            <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-xs leading-5 text-amber-100">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              Reference design brief only. Cell temperatures, nanofluid properties, and CFD performance have not been measured or computed.
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-3xl border border-white/10 bg-[#11161B] p-5">
        <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Pack concept illustration</div>
        <h3 className="mt-2 text-xl font-semibold text-white">10-cell layout · no cell-level values</h3>
        <div className="mt-4 grid grid-cols-5 gap-3 sm:grid-cols-10">
          {Array.from({ length: 10 }, (_, index) => (
            <div key={index} className="flex flex-col items-center gap-2 rounded-xl border border-white/10 bg-[#171D24] p-3">
              <div className="flex h-11 w-8 items-center justify-center rounded-full border border-slate-500/60 bg-slate-700/30 text-[10px] text-slate-400">{index + 1}</div>
              <span className="text-[10px] uppercase tracking-[0.1em] text-slate-500">Concept</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
