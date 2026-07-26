# heddle-server on Kubernetes

Manifests for running the engine as a **long-lived, multi-run service** that
streams SSE and autoscales.

This is a different deployment from the one in [`../DEPLOYMENT.md`](../DEPLOYMENT.md),
and the difference is not a setting — it is who the callers are.

|  | Playground (`DEPLOYMENT.md`) | This directory |
|---|---|---|
| Callers | Anyone on the internet | Authenticated, trusted |
| `--allow-request-code` | On | Off |
| Runs per process | Many, concurrent | Many, concurrent |
| Scaling | HPA over a Deployment | HPA over a Deployment |

These manifests leave `--allow-request-code` off because the callers are
trusted and there is no reason to accept code from them. It is no longer the
case that turning it on would be unsafe here.

**This used to say the opposite.** Plugins were imported into the server's Node
process, so a submitted one could read every co-tenant's memory and the pod's
environment, and the only safe topology for untrusted callers was one container
per run. Plugins now execute in their own process with an empty environment,
and a submitted spec can no longer dereference the pod's environment either.
`packages/core/src/plugin/__tests__/remote.test.ts` runs the cross-tenant
attack and asserts it fails.

If you do turn it on, read `../DEPLOYMENT.md` first — the remaining exposure is
egress, not memory.

## The residual trade

Even without request code, runs share a process:

- One run that exhausts memory OOM-kills the pod and **every session on it**.
- `--max-concurrent` and the memory limit are what bound that, which is why
  they are not free-tuning knobs.

Size `--max-concurrent` to what one pod can hold with headroom, and let the HPA
add pods rather than raising it.

## Files

| File | What it does |
|---|---|
| `deployment.yaml` | The pod: args, probes, drain, resources, security context |
| `service.yaml` | Service with session affinity, PDB, SSE-tuned Ingress |
| `hpa.yaml` | Autoscaling on sessions + CPU + memory |
| `prometheus-adapter.yaml` | Makes `heddle_active_runs` readable by the HPA |

## Endpoints this relies on

| Endpoint | Purpose |
|---|---|
| `/healthz` | Liveness. Stays 200 while draining — a draining pod must not be restarted. |
| `/readyz` | Readiness. 503 once draining, so the pod leaves the Service endpoints. |
| `/metrics` | Prometheus text exposition. In-cluster only; never route it publicly. |

`/metrics` exposes `heddle_active_runs`, `heddle_max_concurrent_runs`,
`heddle_run_saturation`, `heddle_runs_accepted_total`,
`heddle_runs_rejected_total`, plus process CPU and RSS.

## `--safe` needs gVisor here

The Deployment sets `--safe --sandbox=bubblewrap` **and** a hardened security
context — `capabilities.drop: [ALL]`, `allowPrivilegeEscalation: false`,
`seccompProfile: RuntimeDefault`. Those two are incompatible under runc:
bubblewrap has to create a user namespace and mount `/proc` in it, which that
context denies. Every tool call fails with `bwrap: Can't mount proc`, and no
test catches it because none exercises a sandboxed tool.

Measured, with the security context above:

| Runtime | bubblewrap |
|---|---|
| rootless podman | fails |
| rootful runc | fails |
| gVisor (runsc) | works, and confines |

So either give the pod a gVisor RuntimeClass:

```yaml
spec:
  runtimeClassName: gvisor
```

or remove `--safe` and `--sandbox=bubblewrap` from the container args. With
trusted callers the second is perfectly reasonable — tool sandboxing is defence
in depth there, not the boundary.

## Two things that are easy to get wrong

**Readiness is not saturation.** A pod at its concurrency ceiling stays *ready*.
It is doing exactly what it was configured to do, and refuses overflow with a
429. Reporting it unready would evict a healthy pod under precisely the load
that needs it, and hand its traffic to peers that are equally busy. Saturation
belongs in the HPA; readiness is only about whether new work should route here.

**The HPA takes the max, not a sum.** `hpa.yaml` lists three metrics; the
controller computes a desired replica count per metric and picks the largest.
"Sessions + CPU + memory" therefore means "scale up when any is hot". If you
want one genuinely blended number, see the PromQL at the bottom of
`prometheus-adapter.yaml`.

## Draining, which is the part that matters for SSE

A run is a long-lived HTTP response. Killing the process ends it mid-flight, and
under an orchestrator that is not an edge case — it is every rolling deploy and
every scale-in. The sequence on SIGTERM:

1. `/readyz` starts answering 503 → the pod leaves the Service endpoints.
2. New `POST /v1/runs` is refused with 503, naming `Draining`.
3. **Open streams keep running**, and the listener stays up so both of the
   above remain observable.
4. Once the last run finishes, the listener closes and the process exits 0.
5. Only if `--drain-timeout` expires are remaining connections closed.

`/healthz` stays 200 throughout — a draining pod is healthy, and failing
liveness here would have the kubelet restart the very pod that is trying to
finish its streams.

A second SIGTERM/SIGINT skips the wait, for when an operator would rather not.

The timing constraint, which must hold or the drain is pointless:

```
terminationGracePeriodSeconds  >  preStop sleep  +  --drain-timeout
            120s               >       5s        +        90s
```

`--drain-timeout` should in turn be ≥ `--timeout`, so a run near its wall-clock
budget can still finish.

The `preStop` sleep is not padding. Endpoint removal and SIGTERM are dispatched
concurrently and propagation is not instant, so without it the server starts
refusing while some proxies still list the pod.

## Apply

```bash
kubectl apply -f packages/server/k8s/
```

The HPA's `Pods` metric needs prometheus-adapter configured first — see
`prometheus-adapter.yaml`. Without it that metric never resolves and the HPA
silently scales on CPU and memory alone, which looks like it is working.

Verify the metric is actually reaching the HPA:

```bash
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1/namespaces/default/pods/*/heddle_active_runs"
```

Then confirm the HPA is reading it, rather than assuming:

```bash
kubectl describe hpa heddle-server
```
