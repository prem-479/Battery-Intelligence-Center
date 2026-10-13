import test from 'node:test';
import assert from 'node:assert/strict';
import { assessThermalRisk, summarizePackTemperatures, THERMAL_THRESHOLDS } from '../src/thermal/thermalAnalysis.js';

const now = 1_700_000_000_000;

test('classifies nominal and warning temperatures at the configured boundaries', () => {
  assert.equal(assessThermalRisk({ timestamp: now, temperature: 40, errorCode: 0 }, now).status, 'Nominal');
  assert.equal(assessThermalRisk({ timestamp: now, temperature: 40.1, errorCode: 0 }, now).status, 'Warning');
  assert.equal(assessThermalRisk({ timestamp: now, temperature: 14.9, errorCode: 0 }, now).status, 'Warning');
});

test('flags critical temperatures and non-zero fault codes', () => {
  assert.equal(assessThermalRisk({ timestamp: now, temperature: 45, errorCode: 0 }, now).status, 'Critical');
  assert.equal(assessThermalRisk({ timestamp: now, temperature: 25, errorCode: 7 }, now).status, 'Critical');
});

test('identifies missing, invalid, future, and stale telemetry', () => {
  assert.equal(assessThermalRisk(null, now).status, 'Sensor unavailable');
  assert.equal(assessThermalRisk({ timestamp: now, temperature: Number.NaN }, now).status, 'Sensor unavailable');
  assert.equal(assessThermalRisk({ timestamp: now + 3 * 60_000, temperature: 25 }, now).status, 'Sensor unavailable');
  assert.equal(assessThermalRisk({
    timestamp: now - (THERMAL_THRESHOLDS.maximumTelemetryAgeMinutes + 1) * 60_000,
    temperature: 25,
  }, now).status, 'Stale telemetry');
});

test('does not hide an old critical reading behind a stale-data status', () => {
  const assessment = assessThermalRisk({
    timestamp: now - 20 * 60_000,
    temperature: 46,
    errorCode: 0,
  }, now);
  assert.equal(assessment.status, 'Critical');
  assert.match(assessment.reasons.join(' '), /stale/i);
});

test('summarizes temporal pack readings without calling their range cell spread', () => {
  const summary = summarizePackTemperatures([{ temperature: 20 }, { temperature: 30 }, { temperature: 25 }]);
  assert.deepEqual(summary, {
    sampleCount: 3,
    minimumC: 20,
    maximumC: 30,
    meanC: 25,
    observedRangeC: 10,
  });
  assert.equal(summarizePackTemperatures([{ temperature: Number.NaN }]), null);
});
