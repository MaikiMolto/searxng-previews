// pool-history.js — in-memory time-series of pool utilization
// Samples every second, keeps the last N samples for the sparkline UI.
import { getPoolStats } from './screenshot.js';

const MAX_SAMPLES = 60; // 60 samples @ 1Hz = 60s history
const samples = [];

function sample() {
  const s = getPoolStats();
  samples.push({
    t: Date.now(),
    active: s.active,
    queued: s.queued,
    max: s.max,
  });
  if (samples.length > MAX_SAMPLES) samples.shift();
}

// Start sampling
setInterval(sample, 1000);
// Initial sample so the UI doesn't show an empty chart
sample();

export function getHistory() {
  return samples.slice();
}

export function getPeak() {
  if (samples.length === 0) return { active: 0, queued: 0 };
  let maxActive = 0;
  let maxQueued = 0;
  for (const s of samples) {
    if (s.active > maxActive) maxActive = s.active;
    if (s.queued > maxQueued) maxQueued = s.queued;
  }
  return { active: maxActive, queued: maxQueued };
}
