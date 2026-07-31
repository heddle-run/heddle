import type { Framework, UseCase } from "./types";
import { heddle } from "./heddle";
import { langgraph } from "./langgraph";
import { openaiAgents } from "./openai-agents";
import { googleAdk } from "./google-adk";

export type {
  CompareFile,
  Framework,
  Implementation,
  UseCase,
  UseCaseId,
} from "./types";
export { countLines } from "./types";
export { heddle };

/** The frameworks heddle is shown against, in the order the picker lists them. */
export const RIVALS: Framework[] = [langgraph, openaiAgents, googleAdk];

export const FRAMEWORKS: Framework[] = [heddle, ...RIVALS];

/* Every use case names the playground example that is its heddle column, so
   the comparison can hand the reader an editor with that flow already in it.
   The two are the same flow; the example drops the api_key line, which the
   playground refuses on a spec it did not write. */
export const USE_CASES: UseCase[] = [
  {
    id: "research",
    title: "Research assistant",
    blurb: "One agent, two tools, looping until it has an answer.",
    example: "research",
  },
  {
    id: "guardrail",
    title: "An agent with a guardrail",
    blurb: "The user's message is checked before the model is called at all.",
    example: "guardrail",
  },
  {
    id: "routing",
    title: "Routing on a branch",
    blurb: "A classifier labels the message, then control flow forks on it.",
    example: "branching",
  },
];
