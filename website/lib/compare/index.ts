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

export const USE_CASES: UseCase[] = [
  {
    id: "research",
    title: "Research assistant",
    blurb: "One agent, two tools, looping until it has an answer.",
  },
  {
    id: "guardrail",
    title: "An agent with a guardrail",
    blurb: "The user's message is checked before the model is called at all.",
  },
  {
    id: "routing",
    title: "Routing on a branch",
    blurb: "A classifier labels the message, then control flow forks on it.",
  },
];
