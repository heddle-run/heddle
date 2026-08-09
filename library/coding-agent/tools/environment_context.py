#!/usr/bin/env python3
"""The context Codex assembles before the first model call, as one tool.

Codex opens every session with a contextual bundle: an AGENTS.md instructions
fragment, an <environment_context> block, and permissions instructions built
from its sandbox_mode and approval_policy templates. This tool builds the
same three fragments, with Codex's own wrapper formats and template
sentences, so the flow can hand them to the agent the way Codex hands them
to the model.

AGENTS.md discovery follows Codex: find the project root (the nearest
ancestor of cwd holding .git, stopping at the workspace root), then take one
file per directory from the root down to cwd — AGENTS.override.md first,
else AGENTS.md — joined with blank lines, capped at 32 KiB.
"""

import datetime
import json
import os
import sys

MAX_AGENTS_BYTES = 32_768

SANDBOX_SENTENCES = {
    "workspace-write": (
        "Filesystem sandboxing defines which files can be read or written. "
        "`sandbox_mode` is `workspace-write`: The sandbox permits reading "
        "files, and editing files in `cwd` and `writable_roots`. Editing "
        "files in other directories requires approval. Network access is "
        "{network}."
    ),
    "read-only": (
        "Filesystem sandboxing defines which files can be read or written. "
        "`sandbox_mode` is `read-only`: The sandbox only permits reading "
        "files. Network access is {network}."
    ),
    "danger-full-access": (
        "Filesystem sandboxing defines which files can be read or written. "
        "`sandbox_mode` is `danger-full-access`: No filesystem sandboxing - "
        "all commands are permitted. Network access is {network}."
    ),
}

APPROVAL_NEVER = (
    "Approval policy is currently never. Do not provide the "
    "`sandbox_permissions` for any reason, commands will be rejected."
)

APPROVAL_UNLESS_TRUSTED = (
    "Approvals are your mechanism to get user consent to run shell commands "
    "without the sandbox. `approval_policy` is `unless-trusted`: The harness "
    "will escalate most commands for user approval, apart from a limited "
    "allowlist of safe \"read\" commands."
)

APPROVAL_ON_REQUEST = """# Escalation Requests

Commands are run outside the sandbox if they are approved by the user, or match an existing rule that allows it to run unrestricted. The command string is split into independent command segments at shell control operators, including but not limited to:

- Pipes: |
- Logical operators: &&, ||
- Command separators: ;

Each resulting segment is evaluated independently for sandbox restrictions and approval requirements.

## How to request escalation

IMPORTANT: To request approval to execute a command that will require escalated privileges:

- Provide the `sandbox_permissions` parameter with the value `"require_escalated"`
- Include a short question asking the user if they want to allow the action in `justification` parameter. e.g. "Do you want to download and install dependencies for this project?"
- Optionally suggest a `prefix_rule` - this will be shown to the user with an option to persist the rule approval for future sessions.

If you run a command that is important to solving the user's query, but it fails because of sandboxing or with a likely sandbox-related network error (for example DNS/host resolution, registry/index access, or dependency download failure), rerun the command with "require_escalated". ALWAYS proceed to use the `justification` parameter - do not message the user before requesting approval for the command.

## When to request escalation

- You need to run a command that writes to a directory that requires it (e.g. running tests that write to /var)
- You are about to take a potentially destructive action such as an `rm` or `git reset` that the user did not explicitly ask for.
- Be judicious with escalating, but if completing the user's request requires it, you should do so - don't try and circumvent approvals by using other tools.

## prefix_rule guidance

When choosing a `prefix_rule`, request one that will allow you to fulfill similar requests from the user in the future without re-requesting escalation. It should be categorical and reasonably scoped to similar capabilities. You should rarely pass the entire command into `prefix_rule`. Avoid requesting overly broad prefixes like ["python3"]. NEVER provide a prefix_rule argument for destructive commands like rm. NEVER provide a prefix_rule if your command uses a heredoc or herestring."""


def emit(obj):
    json.dump(obj, sys.stdout)


def find_project_root(workspace, cwd):
    probe = cwd
    while True:
        if os.path.isdir(os.path.join(probe, ".git")):
            return probe
        if os.path.samefile(probe, workspace):
            return workspace
        parent = os.path.dirname(probe)
        if parent == probe:
            return workspace
        probe = parent


def agents_md_fragment(workspace, cwd):
    root = find_project_root(workspace, cwd)
    chain = []
    probe = cwd
    while True:
        chain.append(probe)
        if os.path.samefile(probe, root):
            break
        parent = os.path.dirname(probe)
        if parent == probe:
            break
        probe = parent
    chain.reverse()  # root -> cwd, Codex's order

    docs = []
    for directory in chain:
        for name in ("AGENTS.override.md", "AGENTS.md"):
            candidate = os.path.join(directory, name)
            if os.path.isfile(candidate):
                try:
                    with open(candidate, encoding="utf-8", errors="replace") as fh:
                        content = fh.read().strip()
                except OSError:
                    content = ""
                if content:
                    docs.append(content)
                break

    if not docs:
        return ""
    joined = "\n\n".join(docs)
    if len(joined.encode("utf-8")) > MAX_AGENTS_BYTES:
        joined = joined.encode("utf-8")[:MAX_AGENTS_BYTES].decode("utf-8", "ignore")
    return (
        f"# AGENTS.md instructions for {root}\n\n"
        f"<INSTRUCTIONS>\n{joined}\n</INSTRUCTIONS>"
    )


def environment_block(cwd):
    shell = os.path.basename(os.environ.get("SHELL", "")) or "bash"
    now = datetime.datetime.now().astimezone()
    timezone = now.tzname() or "UTC"
    return (
        "<environment_context>\n"
        f"  <cwd>{cwd}</cwd>\n"
        f"  <shell>{shell}</shell>\n"
        f"  <current_date>{now.date().isoformat()}</current_date>\n"
        f"  <timezone>{timezone}</timezone>\n"
        "</environment_context>"
    )


def permissions_block(sandbox_mode, approval_policy, network, cwd):
    sandbox = SANDBOX_SENTENCES.get(
        sandbox_mode, SANDBOX_SENTENCES["workspace-write"]
    ).format(network=network)

    policy = "on-request" if approval_policy == "on-failure" else approval_policy
    if policy == "never":
        approval = APPROVAL_NEVER
    elif policy == "untrusted":
        approval = APPROVAL_UNLESS_TRUSTED
    else:
        approval = APPROVAL_ON_REQUEST

    return (
        "<permissions instructions>\n"
        f"{sandbox}\n"
        f"{approval}\n"
        f" The writable root is `{cwd}`.\n"
        "</permissions instructions>"
    )


def run():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        data = {}

    workspace = os.path.realpath(os.environ.get("HEDDLE_WORKSPACE") or os.getcwd())
    requested = data.get("cwd") or "."
    cwd = os.path.realpath(os.path.join(workspace, requested))
    if not (cwd == workspace or cwd.startswith(workspace + os.sep)) or not os.path.isdir(cwd):
        cwd = workspace

    approval_policy = data.get("approval_policy") or "on-request"
    sandbox_mode = data.get("sandbox_mode") or "workspace-write"
    network = data.get("network_access") or "restricted"

    emit({
        "environment_context": environment_block(cwd),
        "agents_md": agents_md_fragment(workspace, cwd),
        "permissions": permissions_block(sandbox_mode, approval_policy, network, cwd),
    })


try:
    run()
except Exception as err:  # a crash must still read as data
    emit({
        "environment_context": "",
        "agents_md": "",
        "permissions": "",
        "error": f"environment_context error: {err}",
    })
