import type { Framework } from "./types";

/* Checked against langchain 1.3.14, langchain-openai 1.4.1 and langgraph
   1.2.10. All three files were run: routing prints its branch, guardrail
   prints the refusal with a deliberately invalid OPENAI_API_KEY (so the
   model is provably never called), and research reaches the provider and
   stops at authentication. */

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
  },
};
