export const THERMAL_THRESHOLDS = Object.freeze({
  referenceMinimumC: 15,
  warningTemperatureC: 40,
  criticalTemperatureC: 45,
  maximumTelemetryAgeMinutes: 15,
  targetMaximumCellSpreadC: 5,
});

/**
 * @typedef {{ timestamp: number, temperature: number, errorCode?: number }} ThermalTelemetry
 */

/**
 * @param {ThermalTelemetry | null | undefined} reading
 * @param {number} [now]
 */
export function assessThermalRisk(reading, now = Date.now()) {
  if (!reading || !Number.isFinite(reading.temperature) || !Number.isFinite(reading.timestamp) || reading.timestamp <= 0) {
    return { status: 'Sensor unavailable', reasons: ['A valid pack-temperature reading and timestamp are required.'] };
  }

  const reasons = [];
  const ageMs = now - reading.timestamp;
  const futureToleranceMs = 2 * 60 * 1000;
  const isStale = ageMs > THERMAL_THRESHOLDS.maximumTelemetryAgeMinutes * 60 * 1000;

  if (ageMs < -futureToleranceMs) {
    return { status: 'Sensor unavailable', reasons: ['The telemetry timestamp is ahead of the analysis clock.'] };
  }

  if (reading.temperature >= THERMAL_THRESHOLDS.criticalTemperatureC) {
    reasons.push(`Pack temperature is at or above ${THERMAL_THRESHOLDS.criticalTemperatureC}°C.`);
  } else if (reading.temperature > THERMAL_THRESHOLDS.warningTemperatureC) {
    reasons.push(`Pack temperature is above the ${THERMAL_THRESHOLDS.warningTemperatureC}°C warning trigger.`);
  } else if (reading.temperature < THERMAL_THRESHOLDS.referenceMinimumC) {
    reasons.push(`Pack temperature is below the ${THERMAL_THRESHOLDS.referenceMinimumC}°C project reference band.`);
  }

  if (Number.isFinite(reading.errorCode) && reading.errorCode !== 0) {
    reasons.push(`Telemetry reports fault code ${reading.errorCode}.`);
  }

  if (reading.temperature >= THERMAL_THRESHOLDS.criticalTemperatureC ||
      (Number.isFinite(reading.errorCode) && reading.errorCode !== 0)) {
    if (isStale) reasons.push('This critical reading is stale; verify with current BMS data.');
    return { status: 'Critical', reasons };
  }

  if (isStale) {
    return { status: 'Stale telemetry', reasons: ['The latest reading is older than the 15-minute freshness limit.'] };
  }

  return {
    status: reasons.length > 0 ? 'Warning' : 'Nominal',
    reasons: reasons.length > 0 ? reasons : ['No configured pack-level threshold was exceeded.'],
  };
}

/**
 * Summarizes readings over time. The observed range is not a simultaneous
 * cell-to-cell temperature spread.
 * @param {Array<Pick<ThermalTelemetry, 'temperature'>>} readings
 */
export function summarizePackTemperatures(readings) {
  const temperatures = readings
    .map((reading) => reading.temperature)
    .filter((temperature) => Number.isFinite(temperature));

  if (temperatures.length === 0) return null;

  const minimumC = Math.min(...temperatures);
  const maximumC = Math.max(...temperatures);
  const meanC = temperatures.reduce((sum, temperature) => sum + temperature, 0) / temperatures.length;

  return {
    sampleCount: temperatures.length,
    minimumC,
    maximumC,
    meanC,
    observedRangeC: maximumC - minimumC,
  };
}
