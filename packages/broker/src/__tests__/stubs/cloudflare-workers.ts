/**
 * Stand-in for the "cloudflare:workers" module under vitest.
 *
 * Only what the code under test touches: the DurableObject base class, whose
 * job here is to hold the ctx (for `ctx.storage`) and env the runtime passes.
 * Wired up by the alias in ../../../vitest.config.ts; the real module still
 * types the production build.
 */
export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
