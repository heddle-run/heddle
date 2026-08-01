import type { Framework } from "./types";

/* Checked against openai-agents 0.19.1. Every file here was run, under a
   deliberately invalid OPENAI_API_KEY. The ones with no model in them print
   their answer — routing its branch, tool-and-plugin its reversed text — and
   guardrail prints the refusal, which with that key is proof the model was
   never called. The rest reach the provider and stop at authentication. */

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

const AGENT = `from agents import Agent, Runner

assistant = Agent(
    name="assistant",
    model="gpt-4o",
    instructions="Answer in one sentence.",
)

if __name__ == "__main__":
    result = Runner.run_sync(assistant, "what is a heddle on a loom?")
    print(result.final_output)
`;

const SHELL = `import subprocess

from agents import Agent, Runner
from agents.decorators import tool


@tool
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
    model="gpt-4o",
    instructions=(
        "You run shell commands to answer the task. python3 and node "
        "are both on PATH. Each call is a fresh shell, so chain what "
        "depends on itself into a single command. Read exit_code every "
        "time. Answer in one or two sentences."
    ),
    tools=[bash],
)

if __name__ == "__main__":
    task = (
        'count the vowels in "weave agents from spec" with python, '
        "then reverse the string with node"
    )
    print(Runner.run_sync(agent, task).final_output)
`;

const SKILLS = `from pathlib import Path

from agents import Agent, Runner
from agents.decorators import tool

SKILLS = Path("skills")


@tool
def list_skills() -> str:
    """Every skill's name and its one-line description."""
    return "\\n".join(
        f"{path.stem}: {path.read_text().splitlines()[0]}"
        for path in sorted(SKILLS.glob("*.md"))
    )


@tool
def read_skill(name: str) -> str:
    """One skill's body, by name."""
    path = SKILLS / f"{name}.md"
    if not path.is_file():
        return f"no skill named {name!r}"
    return path.read_text()


agent = Agent(
    name="assistant",
    model="gpt-4o",
    instructions=(
        "You have skills: short written procedures. Their text is not "
        "in this prompt. Call list_skills first, on every task. If a "
        "description covers the task, read that skill and follow it "
        "exactly -- it outranks how you would otherwise do the job. "
        "Finish by naming the skill you followed."
    ),
    tools=[list_skills, read_skill],
)

if __name__ == "__main__":
    task = "tidy up the numbers in report.csv"
    print(Runner.run_sync(agent, task).final_output)
`;

const TOOL_AND_PLUGIN = `import subprocess

from agents import trace

# No model takes part, so this is the SDK's orchestrating-via-code
# pattern again: plain Python, wrapped in one trace.


def shout(text: str) -> str:
    """A subprocess, because the step it is compared against is one."""
    done = subprocess.run(
        ["tr", "[:lower:]", "[:upper:]"],
        input=text,
        capture_output=True,
        text=True,
        check=True,
    )
    return done.stdout.rstrip("\\n")


def flip(text: str) -> str:
    """In this process, sharing its heap. There is no other option."""
    return text[::-1]


if __name__ == "__main__":
    with trace("shout and flip"):
        print(flip(shout("weave agents from spec")))
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

    agent: {
      files: [{ name: "agent.py", language: "python", source: AGENT }],
      run: "python agent.py",
      note:
        "The shortest of the four columns, and the SDK at its best: an " +
        "Agent, a Runner, and nothing else to know.",
    },

    shell: {
      files: [{ name: "shell.py", language: "python", source: SHELL }],
      run: "python shell.py",
      note:
        "One @tool holding a subprocess call. What the framework does not " +
        "bring is a boundary: the command the model writes runs as this " +
        "process, and confining it is left to you.",
    },

    skills: {
      files: [{ name: "skills.py", language: "python", source: SKILLS }],
      run: "python skills.py",
      note:
        "Skills are not a framework concept here, and do not need to be — " +
        "two tools over a directory and a prompt that insists they be " +
        "called is the entire pattern.",
    },

    "tool-and-plugin": {
      files: [
        { name: "pipeline.py", language: "python", source: TOOL_AND_PLUGIN },
      ],
      run: "python pipeline.py",
      note:
        "With no model in the flow there is no agent either, so the SDK " +
        "steps aside and leaves two functions and a trace. It is the " +
        "shortest answer of the four, and the least structured.",
    },

    "ag-ui": {
      unsupported:
        "No AG-UI integration is published for this SDK. Its own answer to " +
        "watching a run is tracing — spans posted to OpenAI's dashboard, " +
        "for the developer rather than a client, and not a protocol a UI " +
        "can be built against.",
    },
  },
};
