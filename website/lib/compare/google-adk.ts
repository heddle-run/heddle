import type { Framework } from "./types";

/* Checked against google-adk 2.6.0 and litellm 1.94.0. All three files were
   run: routing prints its branch with no credential at all, guardrail prints
   the refusal with a deliberately invalid OPENAI_API_KEY (so the model is
   provably never called), and research reaches the provider and stops at
   authentication. */

const RESEARCH = `import asyncio

from google.adk.agents import Agent
from google.adk.models.lite_llm import LiteLlm
from google.adk.runners import InMemoryRunner


# Docstring and type hints become the tool schema sent to the model.
def web_search(query: str) -> str:
    """Search the web for information."""
    return f"Results for {query!r}: the Eiffel Tower is 330 m tall."


def calculator(expression: str) -> str:
    """Evaluate a mathematical expression."""
    # The model picks this string, so a bare eval() would be
    # arbitrary code execution. No letters, no imports.
    if set(expression) - set("0123456789.+-*/() "):
        raise ValueError("unsupported expression")
    return str(eval(expression))


agent = Agent(
    name="research_assistant",
    model=LiteLlm(model="openai/gpt-4o"),  # reads OPENAI_API_KEY
    instruction=(
        "You are a research assistant. Answer the question. Use "
        "web_search when you need current information, and "
        "calculator for arithmetic."
    ),
    tools=[web_search, calculator],
)


async def main(question: str) -> None:
    runner = InMemoryRunner(agent=agent)
    # run_debug handles the session, the Content wrapping and the
    # event stream; quiet=True returns the events instead of
    # printing them.
    events = await runner.run_debug(question, quiet=True)
    print(events[-1].content.parts[0].text)


if __name__ == "__main__":
    asyncio.run(main("How tall is the Eiffel Tower in feet?"))
`;

const GUARDRAIL = `import asyncio
import re

from google.adk.agents import Agent
from google.adk.agents.callback_context import CallbackContext
from google.adk.models import LlmRequest, LlmResponse
from google.adk.models.lite_llm import LiteLlm
from google.adk.runners import InMemoryRunner
from google.genai import types

BLOCKED = re.compile(r"password|credit card", re.IGNORECASE)


def blocklist(
    callback_context: CallbackContext, llm_request: LlmRequest
) -> LlmResponse | None:
    """Return an LlmResponse to skip the model, None to proceed."""
    text = llm_request.contents[-1].parts[0].text or ""
    if BLOCKED.search(text):
        return LlmResponse(
            content=types.ModelContent("that topic is blocked")
        )
    return None


agent = Agent(
    name="assistant",
    model=LiteLlm(model="openai/gpt-4o"),
    instruction="You are a concise, helpful assistant.",
    before_model_callback=blocklist,
)


async def main(question: str) -> None:
    runner = InMemoryRunner(agent=agent)
    events = await runner.run_debug(question, quiet=True)
    print(events[-1].content.parts[0].text)


if __name__ == "__main__":
    asyncio.run(main("what is my password"))
`;

const ROUTING = `import asyncio
import re

from google.adk import Context, Event, Workflow
from google.adk.runners import InMemoryRunner

URGENT = re.compile(r"fire|outage|down|urgent", re.IGNORECASE)


def classify(ctx: Context) -> Event:
    """Routing function: plain Python, no LLM."""
    text = ctx.user_content.parts[0].text
    return Event(route="urgent" if URGENT.search(text) else "normal")


def page_oncall() -> str:
    return "paged the on-call engineer"


def file_ticket() -> str:
    return "filed a ticket for the morning"


# The edges dict dispatches on the route the classifier returned.
root_agent = Workflow(
    name="support_router",
    edges=[
        ("START", classify),
        (classify, {"urgent": page_oncall, "normal": file_ticket}),
    ],
)


async def main(message: str) -> None:
    runner = InMemoryRunner(agent=root_agent)
    events = await runner.run_debug(message, quiet=True)
    print(events[-1].output)


if __name__ == "__main__":
    asyncio.run(main("the database is on fire"))
`;

export const googleAdk: Framework = {
  id: "google-adk",
  name: "Google ADK",
  install: "pip install google-adk litellm",
  packages: ["google-adk", "litellm"],
  artifact: "a Python module, or an agent package",
  modelSwap:
    "Change model=: a bare string for Gemini, LiteLlm(...) for anything else.",
  docs: "https://google.github.io/adk-docs/",
  note:
    "Tools are the high point — a plain function is a tool, with no " +
    "decorator and no registration step. Everything else assumes Gemini and " +
    "a session-backed runner, so a non-Google model and a one-off script are " +
    "both slightly against the grain.",

  impls: {
    research: {
      files: [{ name: "research.py", language: "python", source: RESEARCH }],
      run: "python research.py",
      note:
        "A plain Python function is a tool: its name, docstring and type " +
        "hints become the schema the model sees. Reaching a non-Google model " +
        "means wrapping it in LiteLlm, and the run is async.",
    },

    guardrail: {
      files: [{ name: "guardrail.py", language: "python", source: GUARDRAIL }],
      run: "python guardrail.py",
      note:
        "before_model_callback fires after the request is assembled and " +
        "before the provider call. Returning an LlmResponse short-circuits " +
        "the model; returning None lets it through.",
    },

    routing: {
      files: [{ name: "routing.py", language: "python", source: ROUTING }],
      run: "python routing.py",
      note:
        "ADK 2's Workflow takes a list of edges: the classifier returns an " +
        "Event carrying a route, and the dict dispatches on it. No model is " +
        "constructed, and this one runs with no credential at all.",
    },
  },
};
