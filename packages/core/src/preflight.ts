/**
 * What an agent needs from the machine, declared and checked before a run.
 *
 * A bundle can already say what it needs; this is what makes saying it mean
 * something. The declaration travels in the manifest, and the check runs at the
 * same preflight point as the tool check — so a bundle that cannot work here
 * says so once, listing everything, instead of failing three times in a row at
 * whichever step reached the gap first.
 *
 * Split in two beneath this module: `preflight/parse.ts` reads and renders
 * declarations without touching a machine, `preflight/check.ts` looks at this
 * one. Node callers import from here and see no seam; a portable host imports
 * only the parse half, which is the point of the split.
 */
export {
  envRequirements,
  formatRequirements,
  parseRequirements,
  requirementLabel,
} from './preflight/parse.js';
export type {
  BinaryRequirement,
  CheckedRequirement,
  EnvRequirement,
  FileRequirement,
  NodeRequirement,
  Requirement,
  Unmet,
} from './preflight/parse.js';
export {
  assertRequirements,
  checkRequirements,
  inspectRequirements,
} from './preflight/check.js';
