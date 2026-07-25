# Vendored `agentspec`

This directory is a verbatim copy of the TypeScript SDK for the Oracle Open
Agent Specification.

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

## Local modifications

None. `src/`, `tsconfig.json`, and `tsup.config.ts` are unmodified from the
commit above. Only `package.json` differs from upstream: it is marked `private`,
and the test/lint/example scripts and their devDependencies are dropped, since
upstream's `tests/` and `examples/` are not vendored.

## Refreshing

    git clone https://github.com/oracle/agent-spec.git
    cd agent-spec && git checkout <new-sha>
    rsync -a --delete tsagentspec/src/ <heddle>/vendor/agentspec/src/
    cp tsagentspec/tsconfig.json tsagentspec/tsup.config.ts <heddle>/vendor/agentspec/

Then update the commit in the table above, and run `pnpm -w build && pnpm -w test`.
