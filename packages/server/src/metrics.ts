import type { ConcurrencyGate } from './limits.js';

/**
 * Render the Prometheus text exposition served at GET /metrics.
 *
 * Hand-written rather than pulled from a client library: the format is a few
 * lines of text, and this package keeps its production dependency list at
 * exactly one entry (@heddle/core). The same reasoning as the hand-rolled
 * router applies here.
 *
 * The metric that matters is `heddle_active_runs`. An in-flight run is one open
 * streaming session, and it is the *leading* signal for autoscaling: it climbs
 * the instant a session starts, ahead of the CPU and memory that session will
 * go on to consume. That makes it the primary axis to scale on, with container
 * CPU and memory — which cAdvisor/kubelet already export, so they are not
 * duplicated here — as lagging backstops the HPA folds in by taking the max.
 *
 * `heddle_run_saturation` (active / limit, in [0,1]) is the same signal
 * pre-normalised, for when it is convenient to target one dimensionless number
 * across pods of different sizes.
 */
export function renderMetrics(gate: ConcurrencyGate): string {
  const cpu = process.cpuUsage(); // microseconds, user + system
  const cpuSeconds = (cpu.user + cpu.system) / 1e6;
  const rss = process.memoryUsage().rss;
  const saturation = gate.limit > 0 ? gate.inFlight / gate.limit : 0;

  return (
    metric(
      'heddle_active_runs',
      'gauge',
      'Runs currently executing (one per open streaming session).',
      gate.inFlight,
    ) +
    metric(
      'heddle_max_concurrent_runs',
      'gauge',
      'Configured ceiling on concurrent runs (--max-concurrent).',
      gate.limit,
    ) +
    metric(
      'heddle_run_saturation',
      'gauge',
      'Active runs divided by the concurrency ceiling, in [0,1].',
      saturation,
    ) +
    metric(
      'heddle_runs_accepted_total',
      'counter',
      'Runs admitted since start.',
      gate.acceptedTotal,
    ) +
    metric(
      'heddle_runs_rejected_total',
      'counter',
      'Runs refused because the concurrency ceiling was full (429s).',
      gate.rejectedTotal,
    ) +
    metric(
      'process_resident_memory_bytes',
      'gauge',
      'Resident set size of the server process, in bytes.',
      rss,
    ) +
    metric(
      'process_cpu_seconds_total',
      'counter',
      'Total user + system CPU time consumed, in seconds.',
      cpuSeconds,
    )
  );
}

/** One HELP/TYPE/sample triple in Prometheus text exposition format. */
function metric(name: string, type: string, help: string, value: number): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${value}\n`;
}
