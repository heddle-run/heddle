import type { Framework } from "./types";

/* Checked against langchain 1.3.14, langchain-openai 1.4.1 and langgraph
   1.2.10. Every file here was run, under a deliberately invalid
   OPENAI_API_KEY. The ones with no model in them print their answer —
   routing its branch, tool-and-plugin its reversed text — and guardrail
   prints the refusal, which with that key is proof the model was never
   called. The rest reach the provider and stop at authentication. */

const RESEARCH = `from langchain.agents import create_agent
from langchain.tools import tool


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


# create_agent compiles a LangGraph graph whose model -> tools ->
# model loop is already wired. OPENAI_API_KEY is read from the env.
agent = create_agent(
    model="openai:gpt-4o",
    tools=[web_search, calculator],
    system_prompt=(
        "You are a research assistant. Answer the question. Use "
        "web_search when you need current information, and "
        "calculator for arithmetic."
    ),
)

if __name__ == "__main__":
    question = "How tall is the Eiffel Tower in feet?"
    result = agent.invoke(
        {"messages": [{"role": "user", "content": question}]}
    )
    print(result["messages"][-1].text)
`;

const GUARDRAIL = `import re
from typing import Any

from langchain.agents import create_agent
from langchain.agents.middleware import AgentState, before_agent
from langgraph.runtime import Runtime

BLOCKED = re.compile(r"password|credit card", re.IGNORECASE)


# before_agent runs once, ahead of the loop. Returning jump_to
# "end" short-circuits the graph, so a blocked prompt never
# reaches the model and costs nothing.
@before_agent(can_jump_to=["end"])
def blocklist(
    state: AgentState, runtime: Runtime
) -> dict[str, Any] | None:
    if BLOCKED.search(state["messages"][-1].text):
        return {
            "messages": [
                {"role": "assistant", "content": "that topic is blocked"}
            ],
            "jump_to": "end",
        }
    return None


agent = create_agent(
    model="openai:gpt-4o",
    system_prompt="You are a concise, helpful assistant.",
    middleware=[blocklist],
)

if __name__ == "__main__":
    result = agent.invoke(
        {"messages": [{"role": "user", "content": "what is my password"}]}
    )
    print(result["messages"][-1].text)
`;

const ROUTING = `import re

from langgraph.graph import END, START, StateGraph
from typing_extensions import TypedDict


class State(TypedDict):
    message: str
    action: str


URGENT = re.compile(r"fire|outage|down|urgent", re.IGNORECASE)


def classify(state: State) -> str:
    """Routing function: plain Python, no LLM."""
    return "urgent" if URGENT.search(state["message"]) else "normal"


def page_oncall(state: State) -> dict[str, str]:
    return {"action": "paged the on-call engineer"}


def file_ticket(state: State) -> dict[str, str]:
    return {"action": "filed a ticket for the morning"}


builder = StateGraph(State)
builder.add_node("page_oncall", page_oncall)
builder.add_node("file_ticket", file_ticket)
# A conditional edge out of START is LangGraph's conditional entry
# point: classify returns a label, path_map turns it into a node.
builder.add_conditional_edges(
    START,
    classify,
    {"urgent": "page_oncall", "normal": "file_ticket"},
)
builder.add_edge("page_oncall", END)
builder.add_edge("file_ticket", END)
graph = builder.compile()

if __name__ == "__main__":
    result = graph.invoke({"message": "the database is on fire"})
    print(result["action"])
`;

const AGENT = `from langchain.agents import create_agent

# No tools. create_agent still compiles the same graph; the loop
# simply never has a tool call to dispatch.
agent = create_agent(
    model="openai:gpt-4o",
    system_prompt="Answer in one sentence.",
)

if __name__ == "__main__":
    question = "what is a heddle on a loom?"
    result = agent.invoke(
        {"messages": [{"role": "user", "content": question}]}
    )
    print(result["messages"][-1].text)
`;

const SHELL = `import subprocess

from langchain.agents import create_agent
from langchain.tools import tool


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


agent = create_agent(
    model="openai:gpt-4o",
    tools=[bash],
    system_prompt=(
        "You run shell commands to answer the task. python3 and node "
        "are both on PATH. Each call is a fresh shell, so chain what "
        "depends on itself into a single command. Read exit_code every "
        "time. Answer in one or two sentences."
    ),
)

if __name__ == "__main__":
    task = (
        'count the vowels in "weave agents from spec" with python, '
        "then reverse the string with node"
    )
    result = agent.invoke({"messages": [{"role": "user", "content": task}]})
    print(result["messages"][-1].text)
`;

const SKILLS = `from pathlib import Path

from langchain.agents import create_agent
from langchain.tools import tool

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


agent = create_agent(
    model="openai:gpt-4o",
    tools=[list_skills, read_skill],
    system_prompt=(
        "You have skills: short written procedures. Their text is not "
        "in this prompt. Call list_skills first, on every task. If a "
        "description covers the task, read that skill and follow it "
        "exactly -- it outranks how you would otherwise do the job. "
        "Finish by naming the skill you followed."
    ),
)

if __name__ == "__main__":
    task = "tidy up the numbers in report.csv"
    result = agent.invoke({"messages": [{"role": "user", "content": task}]})
    print(result["messages"][-1].text)
`;

const TOOL_AND_PLUGIN = `import subprocess

from langgraph.graph import END, START, StateGraph
from typing_extensions import TypedDict


class State(TypedDict):
    text: str
    shouted: str
    flipped: str


def shout(state: State) -> dict[str, str]:
    """A subprocess, because the step it is compared against is one."""
    done = subprocess.run(
        ["tr", "[:lower:]", "[:upper:]"],
        input=state["text"],
        capture_output=True,
        text=True,
        check=True,
    )
    return {"shouted": done.stdout.rstrip("\\n")}


def flip(state: State) -> dict[str, str]:
    """In this process, sharing its heap. There is no other option."""
    return {"flipped": state["shouted"][::-1]}


builder = StateGraph(State)
builder.add_node("shout", shout)
builder.add_node("flip", flip)
builder.add_edge(START, "shout")
builder.add_edge("shout", "flip")
builder.add_edge("flip", END)
graph = builder.compile()

if __name__ == "__main__":
    print(graph.invoke({"text": "weave agents from spec"})["flipped"])
`;

export const langgraph: Framework = {
  id: "langgraph",
  name: "LangGraph",
  install: "pip install langchain langchain-openai langgraph",
  packages: ["langchain", "langchain-openai", "langgraph"],
  artifact: "a Python module that builds a graph",
  modelSwap:
    "Change the model string, and install that provider's integration package.",
  docs: "https://langchain-ai.github.io/langgraph/",
  note:
    "The graph is a live Python object, so checkpointing, streaming and " +
    "human-in-the-loop interrupts all come out of the same runtime. The " +
    "cost is churn: the agent constructor has moved twice in about a year, " +
    "and the three packages pull in roughly forty distributions.",

  impls: {
    research: {
      files: [{ name: "research.py", language: "python", source: RESEARCH }],
      run: "python research.py",
      note:
        "create_agent compiles a graph with the model → tools → model loop " +
        "already wired, so there is no loop to write. It supersedes " +
        "langgraph.prebuilt.create_react_agent, deprecated since v1.",
    },

    guardrail: {
      files: [{ name: "guardrail.py", language: "python", source: GUARDRAIL }],
      run: "python guardrail.py",
      note:
        "LangChain v1 middleware is the framework's own answer to this. " +
        "@before_agent runs once ahead of the loop, and returning a " +
        "jump_to of end finishes the graph without a model call.",
    },

    routing: {
      files: [{ name: "routing.py", language: "python", source: ROUTING }],
      run: "python routing.py",
      note:
        "Plain LangGraph, no LangChain and no model. A conditional edge out " +
        "of START is the documented conditional entry point, so the branch " +
        "needs no dispatcher node of its own.",
    },

    agent: {
      files: [{ name: "agent.py", language: "python", source: AGENT }],
      run: "python agent.py",
      note:
        "The same constructor as the research column with the tools list " +
        "left off. A graph is still compiled and still stepped through, for " +
        "one model call.",
    },

    shell: {
      files: [{ name: "shell.py", language: "python", source: SHELL }],
      run: "python shell.py",
      note:
        "One @tool holding a subprocess call is the whole of it. What the " +
        "framework does not bring is a boundary: the command the model " +
        "writes runs as this process, and confining it is left to you.",
    },

    skills: {
      files: [{ name: "skills.py", language: "python", source: SKILLS }],
      run: "python skills.py",
      note:
        "Skills are not a framework concept here either. Two tools over a " +
        "directory, and a prompt that insists they be called, covers it.",
    },

    "tool-and-plugin": {
      files: [
        { name: "pipeline.py", language: "python", source: TOOL_AND_PLUGIN },
      ],
      run: "python pipeline.py",
      note:
        "Two nodes and a TypedDict for what passes between them. Only the " +
        "first step is a subprocess, and that is this file's choice. The " +
        "second is a function in this process because there is no other " +
        "kind of node to make it.",
    },

    "ag-ui": {
      unsupported:
        "ag-ui-langgraph publishes a graph as an AG-UI endpoint, which is " +
        "a server rather than a rendering: the protocol is how a client " +
        "talks to the agent, not a second way to read a run that already " +
        "happened. There is nothing to attach to `python research.py`.",
    },
  },
};
