# Vendored `agentspec`

This directory is a copy of the TypeScript SDK for the Oracle Open Agent
Specification, plus a short series of local patches recorded under
[Local modifications](#local-modifications). It was a verbatim copy until the
first of those landed; treat the patch list, not this tree, as the record of
what heddle changed.

| | |
|---|---|
| Upstream | https://github.com/oracle/agent-spec |
| Path | `tsagentspec/` |
| Commit | `f8b5b0340af064c41f7ac5e8b98d92760f55f435` |
| License | UPL-1.0 (see `LICENSE.txt`) |

## Why this is vendored

The SDK is not published to npm. (The `agentspec` package that *is* on the
public registry is an unrelated project by a different author — do not depend
on it.)

It was previously consumed as a git dependency:

    "agentspec": "github:oracle/agent-spec#f8b5b034…&path:tsagentspec"

That does not work. Upstream's `package.json` declares `"files": ["dist"]` and
ships no built `dist/`, so the git tarball pnpm extracts and caches is empty —
the installed package contains only `README.md` and `package.json`. A
`.pnpmfile.cjs` `readPackage` hook used to try to work around this by deleting
`files` and injecting a `prepare: 'tsup'` script, but `readPackage` rewrites the
manifest *after* the tarball is packed, so it could not recover the missing
sources. The result was a `Cannot find module 'agentspec'` failure on every
clean install.

Vendoring the source removes the network and build-order dependency entirely:
the SDK builds from this tree like any other workspace package.

Source is vendored rather than a prebuilt `dist/`: the source tree is ~400 KB,
while a built `dist/` is ~8.5 MB, dominated by two 3.85 MB rolled-up `.d.ts`
files.

## How it is built and consumed

The workspace root's `prepare` script (`build:vendor`) builds this package after
every `pnpm install`, so a freshly cloned tree can be typechecked and tested
without a separate build step. It invokes this package's own `tsup` binary by
path rather than `pnpm --filter agentspec build`: a nested `pnpm` inside an
install lifecycle script deadlocks against the workspace lock the parent install
holds.

Consumers (`@heddle/core`, `@heddle/cli`) list `agentspec` as a **devDependency**
and bundle it into their own `dist/` via tsup's `noExternal`. It must never be a
runtime dependency of a published package: it is not on npm, and the `agentspec`
name there belongs to an unrelated project, so a published `dependencies` entry
would resolve to the wrong code.

## Local modifications

A numbered patch series. Each entry says what it changes and what breaks in
heddle if a refresh drops it — the refresh procedure below overwrites `src/`
wholesale, so anything not listed here is lost silently.

Every patch is additive and none changes upstream behaviour: heddle carries a
fork of the *validation* layer of a format it does not own, and the way that
stays affordable is that a rebase never has to resolve a semantic conflict.

**1. Export the flow schema registration functions.**
`src/index.ts` re-exports `registerNodeUnionSchema` and `registerFlowSchema`
from `src/flows/lazy-schemas.js`. Both already exist as `export function` there;
the barrel simply did not forward them. Without this, `NodeUnion` is closed to
heddle's plugin-defined node types and a flow containing one is rejected by
`FlowSchema.parse` before the SDK's own deserialization plugin ever runs —
`packages/core/src/plugin/flow-preprocess.ts` exists only to work around that,
by validating a stand-in `InputMessageNode` and swapping the real component back
in by id.

`package.json` also differs from upstream, and predates the series: it is marked
`private`, and the test/lint/example scripts and their devDependencies are
dropped, since upstream's `tests/` and `examples/` are not vendored.
`tsconfig.json` and `tsup.config.ts` are unmodified.

These changes are worth sending upstream — they are small, additive, and useful
to anyone else building a runtime on this SDK. Do not sequence any heddle work
behind them being merged.

## Refreshing

    git clone https://github.com/oracle/agent-spec.git
    cd agent-spec && git checkout <new-sha>
    rsync -a --delete tsagentspec/src/ <heddle>/vendor/agentspec/src/
    cp tsagentspec/tsconfig.json tsagentspec/tsup.config.ts <heddle>/vendor/agentspec/

`--delete` means this discards every patch in the section above. Reapply them,
then update the commit in the table and run `pnpm -w build && pnpm -w test`.

A refresh that drops a patch does not fail loudly: the SDK still builds and its
own behaviour is unchanged, and what breaks is heddle, somewhere downstream of a
missing export. Diffing `src/index.ts` against upstream's after the rsync is the
cheapest way to confirm the series is back.
