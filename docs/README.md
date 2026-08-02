# docs/

User documentation lives at [heddle.run/docs](https://heddle.run/docs) — start
there for guides, the CLI reference, and the plugin authoring docs.

What is in this directory:

| File | What it is |
|---|---|
| [docker.md](docker.md) | Running heddle in a container: both images, chat mode, local models, file ownership, `--safe` inside a container, the server image. |
| [plugin-system-design.md](plugin-system-design.md) | Internal design notes for the plugin system. A roadmap, not a manual. |
| [session-persistence-design.md](session-persistence-design.md) | Internal design notes for sessions and durable runs. A roadmap, not a manual. |

The design documents record why the code is shaped the way it is, phase by
phase. They cite source files and are checked by tests
(`packages/core/src/plugin/__tests__/design-doc-citations.test.ts`), which is
why they live at these exact paths.
