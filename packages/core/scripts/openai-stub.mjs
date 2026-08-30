// Stands in for the `openai` package in the portable artifact.
//
// The portable host builds its own provider over the host fetch bridge
// (`portable-host.ts`), injected through `Dependencies.createProvider` — so
// the SDK's code path is unreachable there. Aliased out rather than shipped,
// for two reasons: the artifact stays a third of the size, and the SDK's own
// environment probing never runs in a context that has no environment. If
// this constructor ever throws on a device, something removed the injection.
export default class OpenAI {
  constructor() {
    throw new Error(
      'the openai SDK is not part of the portable artifact; the portable ' +
        'host injects its own provider through Dependencies.createProvider',
    );
  }
}
