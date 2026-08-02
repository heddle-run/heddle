import type { Framework } from "./types";

/* Checked against google-adk 2.6.0 and litellm 1.94.0. Every file here was
   run, under a deliberately invalid OPENAI_API_KEY. The ones with no model in
   them print their answer with no credential at all — routing its branch,
   tool-and-plugin its reversed text — and guardrail prints the refusal, which
   with that key is proof the model was never called. The rest reach the
   provider and stop at authentication. */

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

const AGENT = `import asyncio

from google.adk.agents import Agent
from google.adk.models.lite_llm import LiteLlm
from google.adk.runners import InMemoryRunner

agent = Agent(
    name="assistant",
    model=LiteLlm(model="openai/gpt-4o"),  # reads OPENAI_API_KEY
    instruction="Answer in one sentence.",
)


async def main(question: str) -> None:
    runner = InMemoryRunner(agent=agent)
    events = await runner.run_debug(question, quiet=True)
    print(events[-1].content.parts[0].text)


if __name__ == "__main__":
    asyncio.run(main("what is a heddle on a loom?"))
`;

const SHELL = `import asyncio
import subprocess

from google.adk.agents import Agent
from google.adk.models.lite_llm import LiteLlm
from google.adk.runners import InMemoryRunner


def bash(command: str) -> str:
    """Run a shell command and return its stdout, stderr and exit code."""
    # Whatever the model writes runs here, with this process's
    # privileges and no confinement of any kind.
    done = subprocess.run(
        command, shell=True, capture_output=True, text=True, timeout=20
    )
    return (
        f"exit_code={done.returncode}\\n"
        f"stdout={done.stdout}\\n"
        f"stderr={done.stderr}"
    )


agent = Agent(
    name="shell",
    model=LiteLlm(model="openai/gpt-4o"),
    instruction=(
        "You run shell commands to answer the task. python3 and node "
        "are both on PATH. Each call is a fresh shell, so chain what "
        "depends on itself into a single command. Read exit_code every "
        "time. Answer in one or two sentences."
    ),
    tools=[bash],
)


async def main(task: str) -> None:
    runner = InMemoryRunner(agent=agent)
    events = await runner.run_debug(task, quiet=True)
    print(events[-1].content.parts[0].text)


if __name__ == "__main__":
    asyncio.run(
        main(
            'count the vowels in "weave agents from spec" with python, '
            "then reverse the string with node"
        )
    )
`;

const SKILLS = `import asyncio
from pathlib import Path

from google.adk.agents import Agent
from google.adk.models.lite_llm import LiteLlm
from google.adk.runners import InMemoryRunner

SKILLS = Path("skills")


def list_skills() -> str:
    """Every skill's name and its one-line description."""
    return "\\n".join(
        f"{path.stem}: {path.read_text().splitlines()[0]}"
        for path in sorted(SKILLS.glob("*.md"))
    )


def read_skill(name: str) -> str:
    """One skill's body, by name."""
    path = SKILLS / f"{name}.md"
    if not path.is_file():
        return f"no skill named {name!r}"
    return path.read_text()


agent = Agent(
    name="assistant",
    model=LiteLlm(model="openai/gpt-4o"),
    instruction=(
        "You have skills: short written procedures. Their text is not "
        "in this prompt. Call list_skills first, on every task. If a "
        "description covers the task, read that skill and follow it "
        "exactly -- it outranks how you would otherwise do the job. "
        "Finish by naming the skill you followed."
    ),
    tools=[list_skills, read_skill],
)


async def main(task: str) -> None:
    runner = InMemoryRunner(agent=agent)
    events = await runner.run_debug(task, quiet=True)
    print(events[-1].content.parts[0].text)


if __name__ == "__main__":
    asyncio.run(main("tidy up the numbers in report.csv"))
`;

const TOOL_AND_PLUGIN = `import asyncio
import subprocess

from google.adk import Context, Event, Workflow
from google.adk.runners import InMemoryRunner


def shout(ctx: Context) -> Event:
    """A subprocess, because the step it is compared against is one."""
    done = subprocess.run(
        ["tr", "[:lower:]", "[:upper:]"],
        input=ctx.user_content.parts[0].text,
        capture_output=True,
        text=True,
        check=True,
    )
    # Nodes do not hand each other values; the session state is the
    # channel, and ctx.state is delta-aware, so a write is a commit.
    ctx.state["shouted"] = done.stdout.rstrip("\\n")
    return Event(output=ctx.state["shouted"])


def flip(ctx: Context) -> Event:
    """In this process, sharing its heap. There is no other option."""
    return Event(output=ctx.state["shouted"][::-1])


root_agent = Workflow(
    name="shout_and_flip",
    edges=[("START", shout), (shout, flip)],
)


async def main(text: str) -> None:
    runner = InMemoryRunner(agent=root_agent)
    events = await runner.run_debug(text, quiet=True)
    print(events[-1].output)


if __name__ == "__main__":
    asyncio.run(main("weave agents from spec"))
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
    "Tools are the high point. A plain function is a tool, with no " +
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

    agent: {
      files: [{ name: "agent.py", language: "python", source: AGENT }],
      run: "python agent.py",
      note:
        "One model call still costs a runner, a session and an async main. " +
        "The framework is built around a served agent, so the smallest " +
        "possible script is where that shows most.",
    },

    shell: {
      files: [{ name: "shell.py", language: "python", source: SHELL }],
      run: "python shell.py",
      note:
        "A plain function is the tool, which is ADK at its best. What the " +
        "framework does not bring is a boundary: the command the model " +
        "writes runs as this process, and confining it is left to you.",
    },

    skills: {
      files: [{ name: "skills.py", language: "python", source: SKILLS }],
      run: "python skills.py",
      note:
        "Skills are not a framework concept here, and do not need to be. " +
        "Two functions over a directory, plus a prompt that insists they be " +
        "called, is the whole pattern.",
    },

    "tool-and-plugin": {
      files: [
        { name: "pipeline.py", language: "python", source: TOOL_AND_PLUGIN },
      ],
      run: "python pipeline.py",
      note:
        "Workflow nodes do not pass each other values, so the two steps " +
        "meet through the session state rather than through an edge. Only " +
        "the first is a subprocess, and that is this file's choice.",
    },

    "ag-ui": {
      unsupported:
        "ag-ui-adk exposes an ADK agent over AG-UI as a served endpoint: " +
        "a way for a client to drive the agent, not a second rendering of " +
        "a run that already happened. Nothing here attaches to " +
        "`python research.py`.",
    },
  },
};
