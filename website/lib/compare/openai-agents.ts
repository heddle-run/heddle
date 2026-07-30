import type { Framework } from "./types";

/* Checked against openai-agents 0.19.1. All three files were run: routing
   prints its branch, guardrail prints the refusal with a deliberately
   invalid OPENAI_API_KEY (so the model is provably never called), and
   research reaches the provider and stops at authentication. */

const RESEARCH = `from agents import Agent, Runner
from agents.decorators import tool


@tool
def web_search(query: str) -> str:
    """Search the web for information."""
    return f"Results for {query!r}: the Eiffel Tower is 330 m tall."


@tool
def calculator(expression: str) -> str:
    """Evaluate a mathematical expression."""
    # The model picks this string, so a bare eval() would be
    # arbitrary code execution. No letters, no imports.
    if set(expression) - set("0123456789.+-*/() "):
        raise ValueError("unsupported expression")
    return str(eval(expression))


agent = Agent(
    name="Research assistant",
    model="gpt-4o",
    instructions=(
        "You are a research assistant. Answer the question. Use "
        "web_search when you need current information, and "
        "calculator for arithmetic."
    ),
    tools=[web_search, calculator],
)


if __name__ == "__main__":
    # Runner.run_sync drives the whole model/tool loop until the
    # agent produces a final answer.
    result = Runner.run_sync(
        agent, "How tall is the Eiffel Tower in feet?"
    )
    print(result.final_output)
`;

const GUARDRAIL = `import re

from agents import (
    Agent,
    GuardrailFunctionOutput,
    InputGuardrailTripwireTriggered,
    RunContextWrapper,
    Runner,
    TResponseInputItem,
)
from agents.decorators import input_guardrail

BLOCKED = re.compile(r"password|credit card", re.IGNORECASE)


# Guardrails run in parallel with the agent by default, which is
# faster but can spend tokens before the tripwire cancels the run.
# run_in_parallel=False makes it block: the guardrail finishes first.
@input_guardrail(run_in_parallel=False)
def blocklist(
    ctx: RunContextWrapper[None],
    agent: Agent,
    input: str | list[TResponseInputItem],
) -> GuardrailFunctionOutput:
    return GuardrailFunctionOutput(
        output_info="that topic is blocked",
        tripwire_triggered=bool(BLOCKED.search(str(input))),
    )


agent = Agent(
    name="Assistant",
    model="gpt-4o",
    instructions="You are a concise, helpful assistant.",
    input_guardrails=[blocklist],
)


if __name__ == "__main__":
    try:
        result = Runner.run_sync(agent, "what is my password")
        print(result.final_output)
    except InputGuardrailTripwireTriggered as e:
        print(e.guardrail_result.output.output_info)
`;

const ROUTING = `import re

from agents import trace

# The SDK's answer to a deterministic branch is its
# "orchestrating via code" pattern, wrapped in one trace.

URGENT = re.compile(r"fire|outage|down|urgent", re.IGNORECASE)


def classify(message: str) -> str:
    """Routing function: plain Python, no LLM."""
    return "urgent" if URGENT.search(message) else "normal"


def page_oncall() -> str:
    return "paged the on-call engineer"


def file_ticket() -> str:
    return "filed a ticket for the morning"


def handle(message: str) -> str:
    if classify(message) == "urgent":
        return page_oncall()
    return file_ticket()


if __name__ == "__main__":
    with trace("support routing"):
        print(handle("the database is on fire"))
`;

export const openaiAgents: Framework = {
  id: "openai-agents",
  name: "OpenAI Agents SDK",
  install: "pip install openai-agents",
  packages: ["openai-agents"],
  artifact: "a Python module you run yourself",
  modelSwap:
    "Change model= on the Agent; anything but OpenAI needs the litellm extra.",
  docs: "https://openai.github.io/openai-agents-python/",
  note:
    "The smallest surface of the three: one package, few concepts, and " +
    "tracing to a hosted dashboard included. It is also the most opinionated " +
    "about where the model comes from — everything else arrives through a " +
    "LiteLLM adapter.",

  impls: {
    research: {
      files: [{ name: "research.py", language: "python", source: RESEARCH }],
      run: "python research.py",
      note:
        "Runner.run_sync is the loop: it calls the model, dispatches tool " +
        "calls, feeds the results back, and returns once the agent has an " +
        "answer. @tool turns a signature and docstring into the schema.",
    },

    guardrail: {
      files: [{ name: "guardrail.py", language: "python", source: GUARDRAIL }],
      run: "python guardrail.py",
      note:
        "@input_guardrail is the real hook, and a tripped tripwire raises. " +
        "It is handed the whole input, where the callback-style hooks in the " +
        "other columns see only the newest message.",
    },

    routing: {
      files: [{ name: "routing.py", language: "python", source: ROUTING }],
      run: "python routing.py",
      note:
        "For a branch no model takes part in, the SDK's documented answer is " +
        "plain Python around the agent runs — its orchestrating-via-code " +
        "pattern — with a trace wrapped round the whole thing.",
    },
  },
};
