import type { Framework, UseCase } from "./types";
import { heddle } from "./heddle";
import { langgraph } from "./langgraph";
import { openaiAgents } from "./openai-agents";
import { googleAdk } from "./google-adk";

export type {
  Cell,
  CompareFile,
  Framework,
  Implementation,
  Reference,
  Unsupported,
  UseCase,
  UseCaseId,
} from "./types";
export { countLines, isUnsupported } from "./types";
export { heddle };

/** The frameworks heddle is shown against, in the order the picker lists them. */
export const RIVALS: Framework[] = [langgraph, openaiAgents, googleAdk];

export const FRAMEWORKS: Framework[] = [heddle, ...RIVALS];

/* Every use case names the playground example that is its heddle column, so
   the comparison can hand the reader an editor with that flow already in it.
   The two are the same flow; the example drops the api_key line, which the
   playground refuses on a spec it did not write.

   This list is the playground's example list — same entries, same order, same
   titles. The two pickers sit in the same bar and swapping between them should
   not feel like changing subject, so a name that differs between the two is a
   bug. lib/playground.ts is the side that owns the wording. */
export const USE_CASES: UseCase[] = [
  {
    id: "tool-and-plugin",
    title: "Tool and plugin",
    blurb: "A subprocess uppercases the text, then a second component reverses it. No model.",
    example: "tool-and-plugin",
  },
  {
    id: "guardrail",
    title: "A guardrail that refuses",
    blurb: "The user's message is checked before the model is called at all.",
    example: "guardrail",
  },
  {
    id: "routing",
    title: "Routing on a branch",
    blurb: "A classifier labels the message, then control flow forks on it.",
    example: "branching",
  },
  {
    id: "agent",
    title: "An agent",
    blurb: "One agent, one model call, no tools.",
    example: "agent",
  },
  {
    id: "research",
    title: "A research assistant",
    blurb: "One agent, two tools, looping until it has an answer.",
    example: "research",
  },
  {
    id: "shell",
    title: "An agent with a shell",
    blurb: "One tool that runs any command, and a model deciding what to run.",
    example: "shell",
  },
  {
    id: "skills",
    title: "An agent with skills",
    blurb: "Procedures the model loads only when it decides it needs them.",
    example: "skills",
  },
  {
    id: "ag-ui",
    title: "A run rendered as AG-UI",
    blurb: "The same run, rendered as AG-UI frames for a client to draw.",
    example: "ag-ui",
  },
];
