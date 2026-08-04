import { basename } from 'node:path';
import { Command } from 'commander';
import {
  BundleError,
  formatRequirements,
  inspectRequirements,
  isBundlePath,
  type Requirement,
} from '@heddle-run/core';
import { openBundle, readRequiresOption } from './bundles.js';

interface DoctorOptions {
  requires?: string;
}

/**
 * "Can this machine run that?", answered without running it.
 *
 * The check `heddle run` does anyway, made addressable. Two things make it
 * worth its own command rather than a flag on `run`: it is the honest way to
 * ask before a meeting starts rather than during one, and its exit status
 * makes the question answerable in CI — a workflow that packs a bundle can
 * assert its runner has what the bundle asks for.
 *
 * It runs nothing and installs nothing, which is the same promise `validate`
 * makes about a bundle's code: opening one of these files does not act. What
 * is missing is printed, with whatever the author wrote as a hint beside it,
 * and the fix is the reader's to make with their own package manager.
 */
export const doctorCommand = new Command('doctor')
  .description(
    'Check whether this machine has what a bundle needs, without running it. ' +
      'Exits non-zero when something is missing, so CI can ask too',
  )
  .argument(
    '<bundle-or-flow>',
    'A .heddle bundle, whose recorded requirements are checked, or a flow ' +
      'file, whose requirements come from --requires',
  )
  .option(
    '--requires <json|@file>',
    'The requirements to check, in the same JSON "heddle bundle --requires" ' +
      'takes. For a flow that is not packed yet, or to try a declaration ' +
      'before packing it',
  )
  .action((path: string, options: DoctorOptions) => {
    const { context, requires, packed } = collect(path, options);

    const checks = inspectRequirements(requires);
    console.log(formatRequirements(context, checks));

    // Said plainly, because "declares no requirements" reads like a clean bill
    // of health, and for a flow file it is not one — there was nowhere for a
    // declaration to be.
    if (!packed && requires.length === 0) {
      console.log(
        `A flow file has nowhere to record requirements, so this checked ` +
          `nothing. Pass --requires to try a list, or point doctor at the ` +
          `.heddle bundle it will be packed into.`,
      );
    }

    // Non-zero rather than thrown: an unmet requirement is a verdict this
    // command was asked for, not a failure of it, and the report above is
    // already the whole message. `run` is where it becomes an error.
    if (checks.some((check) => check.reason !== undefined)) {
      process.exitCode = 1;
    }
  });

/**
 * What to check, and what to call it.
 *
 * A bundle carries its own answer. A flow does not — requirements live in a
 * bundle manifest, and a flow file has nowhere to put them — so `--requires`
 * is how an author checks the declaration they are about to pack, against the
 * machine they are packing on.
 */
function collect(
  path: string,
  options: DoctorOptions,
): { context: string; requires: Requirement[]; packed: boolean } {
  const given = readRequiresOption(options.requires);

  if (!isBundlePath(path)) {
    return { context: basename(path), requires: given ?? [], packed: false };
  }

  const bundle = openBundle(path);
  try {
    if (given && bundle.requires.length > 0) {
      throw new BundleError(
        `${basename(path)} records its own requirements, so --requires would ` +
          `check something other than what running it checks. Drop the flag ` +
          `to ask about the bundle, or point it at the flow to try a new list.`,
      );
    }
    return {
      context: bundle.name,
      requires: given ?? bundle.requires,
      packed: true,
    };
  } finally {
    // Nothing below needs the extraction: a requirement names things on this
    // machine, never anything inside the archive.
    bundle.dispose();
  }
}

