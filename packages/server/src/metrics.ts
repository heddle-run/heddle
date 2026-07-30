import type { ConcurrencyGate } from './limits.js';

const MICROSECONDS_PER_SECOND = 1e6;

export function renderMetrics(gate: ConcurrencyGate): string {
  const cpu = process.cpuUsage();
  const cpuSeconds = (cpu.user + cpu.system) / MICROSECONDS_PER_SECOND;
  const saturation = gate.limit > 0 ? gate.inFlight / gate.limit : 0;

  return [
    metric(
      'heddle_active_runs',
      'gauge',
      'Runs currently executing (one per open streaming session).',
      gate.inFlight,
    ),
    metric(
      'heddle_max_concurrent_runs',
      'gauge',
      'Configured ceiling on concurrent runs (--max-concurrent).',
      gate.limit,
    ),
    metric(
      'heddle_run_saturation',
      'gauge',
      'Active runs divided by the concurrency ceiling, in [0,1].',
      saturation,
    ),
    metric(
      'heddle_runs_accepted_total',
      'counter',
      'Runs admitted since start.',
      gate.acceptedTotal,
    ),
    metric(
      'heddle_runs_rejected_total',
      'counter',
      'Runs refused because the concurrency ceiling was full (429s).',
      gate.rejectedTotal,
    ),
    metric(
      'process_resident_memory_bytes',
      'gauge',
      'Resident set size of the server process, in bytes.',
      process.memoryUsage().rss,
    ),
    metric(
      'process_cpu_seconds_total',
      'counter',
      'Total user + system CPU time consumed, in seconds.',
      cpuSeconds,
    ),
  ].join('');
}

function metric(
  name: string,
  type: string,
  help: string,
  value: number,
): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${value}\n`;
}
