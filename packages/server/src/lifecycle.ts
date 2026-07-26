/**
 * The process's readiness, kept separate from its liveness.
 *
 * Liveness ("is the event loop up?") stays true for the whole life of the
 * process; a crashed process answers nothing at all. Readiness ("should new
 * runs be routed here?") is the one that moves: it flips to not-ready the moment
 * the process begins draining, so Kubernetes pulls the pod out of the Service
 * endpoints and stops sending it work while the runs already streaming finish.
 *
 * This is deliberately not tied to load. A pod at its concurrency ceiling is
 * still ready — it is doing exactly what it should — and refuses the overflow
 * with a 429. Reporting it unready would evict a healthy, fully-utilised pod
 * from rotation, which is the opposite of what saturation should trigger.
 */
export class Lifecycle {
  private draining = false;

  /** True once {@link beginDrain} has been called. */
  get isDraining(): boolean {
    return this.draining;
  }

  /** Enter draining state. Irreversible: a process drains, then exits. */
  beginDrain(): void {
    this.draining = true;
  }
}
