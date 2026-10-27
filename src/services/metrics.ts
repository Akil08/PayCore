const MAX_LATENCY_SAMPLES = 1000;
const latencyBuffer: number[] = [];
let latencyIndex = 0;
let latencyCount = 0;

const processedTimestamps: Record<string, number[]> = {};

export function recordLatency(name: 'transfer_post', ms: number): void {
  if (latencyCount < MAX_LATENCY_SAMPLES) {
    latencyBuffer.push(ms);
    latencyCount++;
  } else {
    latencyBuffer[latencyIndex] = ms;
  }
  latencyIndex = (latencyIndex + 1) % MAX_LATENCY_SAMPLES;
}



export function incProcessed(queue: string): void {
  if (!processedTimestamps[queue]) {
    processedTimestamps[queue] = [];
  }
  processedTimestamps[queue].push(Date.now());
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = lower + 1;
  const weight = index - lower;
  if (upper >= sorted.length) return sorted[lower];
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function snapshot(): {
  latency: { count: number; p50: number; p95: number; p99: number };
  processedPerSec: Record<string, number>;
} {
  const now = Date.now();
  const cutoff = now - 10000; // 10 seconds

  const processedPerSec: Record<string, number> = {};
  for (const [queue, timestamps] of Object.entries(processedTimestamps)) {
    const recent = timestamps.filter((t) => t > cutoff);
    processedTimestamps[queue] = recent; // prune old ones to save memory
    processedPerSec[queue] = recent.length / 10;
  }

  const count = latencyCount;
  const p50 = percentile(latencyBuffer, 50);
  const p95 = percentile(latencyBuffer, 95);
  const p99 = percentile(latencyBuffer, 99);

  return {
    latency: { count, p50, p95, p99 },
    processedPerSec,
  };
}