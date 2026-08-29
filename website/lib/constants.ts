export const SITE_URL = "https://heddle.run";

/* The playground — the editor, the run log and the framework comparison, one
   application — is exported at /playground and served at the root of
   playground.heddle.run. The same page either way; this is the address the
   site links to. It is set at build time because a local build, a preview
   deployment or a fork has no subdomain of its own, and unset the relative
   path is the correct one. */
const PLAYGROUND_ORIGIN = process.env.NEXT_PUBLIC_PLAYGROUND_URL?.replace(
  /\/+$/,
  "",
);

export const PLAYGROUND_URL = PLAYGROUND_ORIGIN || "/playground";

/** The same application, opened on the comparison rather than the editor. */
export const COMPARE_URL = `${PLAYGROUND_ORIGIN ? `${PLAYGROUND_ORIGIN}/` : "/playground"}?view=compare`;

/* Home, addressed from inside the playground. The wordmark in its bar is the
   way back to the site, and on the playground's own origin "/" is the
   playground itself — so there, home has to be spelled out. */
export const HOME_URL = PLAYGROUND_ORIGIN ? SITE_URL : "/";

export const GITHUB_URL = "https://github.com/heddle-run/heddle";
export const NPM_URL = "https://www.npmjs.com/package/@heddle-run/cli";

/* Two audiences arrive wanting different first commands, and the difference is
   not cosmetic: a person wants to see a job run, an agent wants to be taught
   how to write one. The human command runs a finished library agent by its
   bare name — the CLI expands it to the entry's published address, and it is
   the same command the library page prints — because for a reader who does
   not program, one command that produces a result is worth more than any
   install instruction. `npm install -g` and Homebrew are in the docs; a
   landing page owes each visitor one command, not four.

   Every command here is a run, not an install. That is the point. */
export const installTabs = [
  {
    id: "humans",
    label: "Humans",
    note: "A finished agent from the library, run by its name. Nothing is installed into anything.",
    commands: [
      {
        label: "npx",
        cmd: "npx @heddle-run/cli run coding-agent",
      },
    ],
  },
  {
    id: "agents",
    label: "Agents",
    note: "Teaches your coding agent to write, validate and run a heddle agent.",
    commands: [{ label: "skill", cmd: "npx skills add heddle-run/heddle" }],
  },
];

export const definition = {
  word: "heddle",
  pronunciation: "| ˈhɛd(ə)l |",
  partOfSpeech: "noun",
  body: "The part of a loom that lifts individual warp threads to form the shed — the opening through which the weft passes. It decides, thread by thread, what the pattern becomes.",
};

/* 001 — what you can build. The library's agents, each one real: the slug
   is the directory under library/ and the page at /library/<slug>, and
   every detail line is checked against that entry's README. A reader who
   opens the linked flow file learns more than any paragraph here can teach,
   so the links are the point — never let a use case stand without a flow
   that exists. */
export const useCases = [
  {
    slug: "local-notetaker",
    title: "The meeting notes",
    detail:
      "It listens from your own computer — no bot joins the call, and the audio never leaves your machine. Stop it when the meeting ends and you get the summary, the decisions, the action items and the open questions. macOS today.",
  },
  {
    slug: "coding-agent",
    title: "The coding agent",
    detail:
      "Point it at a repository and give it a task. It plans, edits, runs the tests and repeats — OpenAI Codex CLI's own orchestration, rebuilt as one readable flow.",
  },
];

/* 003 — the path from interested to running, stated literally. The claims
   are checked against docs/getting-started.mdx: Node 18+, a provider key
   (or Ollama), heddle init, heddle run. */
export const firstRun = [
  {
    title: "Check you have Node",
    detail:
      "Type node --version in a terminal. A number, 18 or higher, means you are set; if not, installing it takes two minutes.",
  },
  {
    title: "Get a model key",
    detail:
      "An API key from OpenAI or a compatible provider — or install Ollama if you would rather nothing left your machine.",
  },
  {
    title: "Start from something that works",
    detail:
      "heddle init writes a working flow and a working tool into a folder. Or take a finished agent from the library and open its file.",
  },
  {
    title: "Run it, change a line, run it again",
    detail:
      "heddle run does the rest, printing each step as it happens. You will spend your time editing the instructions, not the structure.",
  },
];

/* The receipt for "one document, two runtimes": the same flow, run locally
   and served over HTTP. Both commands and both outputs are checked against
   docs/cli-reference.mdx and docs/server.mdx — the CLI examples and the
   POST /v1/runs example there, not illustrative shorthand. */
export const runtimes = {
  cli: {
    label: "Local",
    windowTitle: "zsh — heddle",
    code: `$ heddle run flow.yaml \\
    --tools-dir ./tools \\
    --input '{"query": "hello"}'

{
  "query": "hello",
  "result": "..."
}`,
    caption: "On your machine: one program, printing each step as it runs.",
  },
  server: {
    label: "Server",
    windowTitle: "zsh — heddle-server",
    code: `$ heddle-server --port 4319 \\
    --tools-dir ./tools

$ curl -sX POST localhost:4319/v1/runs \\
    -d '{"flowPath": "flow.yaml",
         "inputs": {"query": "hello"}}'

{"flow":"flow","state":{"result":"..."}}`,
    caption:
      "On a server: the same file, unchanged, doing the job without you.",
  },
};

/* 005 — the sandboxing claims, in the order a cautious reader asks them:
   what can it touch, what can it not, what about a file someone sent me,
   and what happens when the protection is missing. The mechanisms are the
   same falsifiable ones as ever — checked against packages/core/src/sandbox/
   and packages/server/DEPLOYMENT.md; translate the language, never the
   claims. Mechanisms, not adjectives. */
export const safeMode = {
  flag: "--safe",
  points: [
    {
      icon: "layers",
      hue: "var(--hue-emerald)",
      title: "What it can touch",
      description:
        "Each agent works inside one folder — its workspace — for the length of the run. Its tools read and write there and hand each other files there. --mount is how you place your own files in it before the run starts.",
    },
    {
      icon: "shield",
      hue: "var(--hue-blue)",
      title: "What it cannot",
      description:
        "Under --safe a tool gets no home folder, can write nowhere outside its workspace, and sees only the environment variables you name with --allow-env. The box is enforced by the operating system itself — bubblewrap on Linux, seatbelt on macOS — not by heddle asking nicely.",
    },
    {
      icon: "file-code",
      hue: "var(--hue-purple)",
      title: "A flow file cannot hide code",
      description:
        "A flow is a list of instructions heddle reads, never a program it executes — so a file someone sends you cannot smuggle code in. And when a caller supplies the spec, a $VAR reference into your environment is refused; heddle will not read its own environment on a stranger's behalf. Running your own spec locally, it still resolves.",
    },
    {
      icon: "circle-check-big",
      hue: "var(--hue-amber)",
      title: "It never degrades quietly",
      description:
        "Ask for the sandbox on a machine that cannot provide it and the run stops. There is no path on which --safe silently carries on unprotected.",
    },
  ],
};

/* The specimen the hero and How-it-works windows show: the local-notetaker
   entry from library/, not an illustration. The spec is an excerpt of
   library/local-notetaker/spec.yaml with the graph plumbing elided and the
   instruction — the interesting part — kept; "…" marks every cut, and the
   node's keys are reordered so the prompt leads (YAML map order is not
   semantic). The transcript states only what the spec guarantees: the
   graph's true shape (6 nodes, 5 edges), the real tool name, and the four
   fixed headings the prompt demands — the notes themselves are elided,
   never invented. Check both against the library entry before changing
   either.

   The rule for samples on this page: never elide the instruction, elide
   the plumbing. A reader who can see one line of English they could
   imagine changing has learned what no paragraph teaches. */
export const specimenSpread = {
  spec: `component_type: Flow
name: local-notetaker
# start ─ record ─ route ─ notes ─ end
$referenced_components:
  # …
  notes:
    component_type: LlmNode
    name: notes
    prompt_template: |
      You took the notes for a
      meeting … Write the notes
      for someone who was not
      there, under exactly these
      four headings, in this
      order:
      ## Summary
      ## Decisions
      ## Action items
      ## Open questions
      … Add nothing that is not
      in the transcript: an empty
      heading is a correct answer.
    llm_config:
      component_type: OpenAiConfig
      model_id: gpt-4o-mini`,
  terminal: [
    { kind: "prompt", text: "heddle run local-notetaker.heddle" },
    { kind: "blank", text: "" },
    { kind: "muted", text: "  spec      valid" },
    { kind: "muted", text: "  graph     6 nodes, 5 edges, reachable" },
    { kind: "blank", text: "" },
    { kind: "tool", text: "[record] ⚙ record_meeting" },
    {
      kind: "muted",
      text: "  recording — Ctrl-C to stop early, or it ends itself in 60 min",
    },
    { kind: "blank", text: "" },
    { kind: "out", text: "{" },
    { kind: "out", text: '  "notes": "## Summary …' },
    { kind: "out", text: "    ## Decisions … ## Action items …" },
    { kind: "out", text: '    ## Open questions …"' },
    { kind: "out", text: "}" },
  ],
};

/* The sharing chapter's specimen, and the page's pivot: an agent is a file,
   and the file travels. Every command and every printed line here was
   produced by running the real CLI against library/local-notetaker — the
   report fields, their order, the size, the entry count and the closing
   "Run it anywhere with:" line are packages/cli/src/cli/bundle.ts's own
   output, not a transcript written to look plausible. Re-pack the entry
   before editing any of it. The three addresses `heddle run` accepts are
   verbatim from docs/bundles.mdx; what does and does not travel is that
   page's "What deliberately does not travel" section in this reader's
   words. */
export const bundle = {
  pack: `$ heddle bundle spec.yaml --tools-dir ./tools \\
    --requires @requires.json -o local-notetaker.heddle

  Flow: local-notetaker (spec.yaml)
  Tools: ./tools
  Requires: OPENAI_API_KEY, ffmpeg, whisper-cli
Wrote local-notetaker.heddle (11.8 KiB, 5 entries)
Run it anywhere with: heddle run local-notetaker.heddle`,
  /* The three addresses one command opens: a file that arrived, an address,
     and a library entry's bare name. */
  send: [
    "heddle run local-notetaker.heddle",
    "heddle run https://example.com/agent.heddle",
    "heddle run coding-agent",
  ],
  travels: [
    {
      title: "What travels",
      detail:
        "The flow, the tools with their executable bits, any plugin's whole folder, the files you attached, the settings, and a default input — so their first run needs no arguments.",
    },
    {
      title: "What stays behind",
      detail:
        "Your keys. The file names them and they are read on the machine that runs, never the one that packed. Your sandbox settings and your conversations stay too.",
    },
    {
      title: "What it asks of them",
      detail:
        "An author can list what the machine must already have — a program, a variable, a version of Node. heddle reports everything missing at once, before it starts anything.",
    },
  ],
};

/* The FAQ, ordered by what a technically confident non-developer actually
   asks, and in their vocabulary. The framework comparisons (LangGraph,
   CrewAI, Docker Agent, ADK) moved to the compare view of the playground —
   a reader who has heard of those tools finds them there; a reader who has
   not lost nothing. The security answers keep the same falsifiable
   mechanisms as safeMode — translate wording, never claims. */
export const faqItems = [
  {
    question: "What is heddle?",
    answer:
      "A free, open-source program that runs multi-step AI jobs described in a plain text file. You write down the steps and the instructions; heddle reads the file, checks it, and carries the job out with the AI model you chose — using tools, repeatedly, until the job is done. The agent is the file, so it goes where you send it: the same one runs on your computer, in a container, or behind a server, and on anyone else's machine that has heddle.",
  },
  {
    question: "Do I need to know how to program?",
    answer:
      "Not to run an agent, and not to own one. The library agents run as they are, and the file that defines a job is a list of steps and instructions in English — editing it is closer to editing a settings file than to writing software. Code enters in one place: a tool is a short script, so a job that needs a tool heddle does not already have needs you, or a colleague, to write one. That split works in practice — the person who understands the job owns the file, and a developer supplies a tool on the day one is missing.",
  },
  {
    question: "How do I give an agent to someone else?",
    answer:
      "heddle bundle packs the whole thing — the flow, the tools it calls, the files it reads, the settings, and a starting input — into a single .heddle file. Send that file however you send any file, or put it at a web address. Whoever has it runs it with heddle run and needs nothing else installed. The library works exactly this way: a bare name like coding-agent is shorthand for the library's own .heddle at its own address.",
  },
  {
    question: "Someone sent me a .heddle file. Is it safe to run?",
    answer:
      "Treat it as you would any file from that person, with three things in your favour. It cannot hide code: the flow is instructions heddle reads, not a program it runs, and the file is an ordinary compressed archive you can list with your own tools first. It cannot take your keys: a key is named in the file and read from your machine at the moment it is used, so nothing about it travelled. And it does not get to decide its own limits — run it with --safe and every tool it calls is boxed in by the operating system, which is your decision and not the file's. Read the flow before you run it; that it can be read is the point.",
  },
  {
    question: "What does it cost to run?",
    answer:
      "heddle itself is free: open source under the MIT licence, no account, no paid tier. The AI model is the running cost. Hosted models charge per use — the library agents run on gpt-4o-mini as written, where a short run costs a fraction of a cent and an hour-long meeting or a long coding session costs more. A local model through Ollama costs nothing but electricity. Either way a mistaken file is rejected before anything is spent: heddle checks the whole flow before the first request leaves your machine.",
  },
  {
    question: "Where does my data go?",
    answer:
      "heddle has no backend, no gateway and no account — nothing you run passes through servers of ours. Your flow sends what you point it at, the files it reads and the questions you ask, to the model provider the file names, and a tool reaches only what it was written to reach. Point the flow at Ollama and the model runs on your own machine too.",
  },
  {
    question: "What happens when it gets something wrong?",
    answer:
      "You can see everything and redo anything. A run prints each step as it happens, and a conversation's transcript is kept on your disk, where heddle sessions show prints exactly what was said and which tools ran. A flow can be written to stop and ask a person before anything that matters. And a run started with --durable writes its progress down at every step, so a failure resumes from where it stopped rather than starting the job over.",
  },
  {
    question: "How is this different from Zapier or n8n?",
    answer:
      "Those run fixed rules: when this happens, do that, with every branch decided in advance. heddle runs jobs that need reading and judgement — sort these, flag what looks off, draft a reply, stop and ask when unsure — over messy input like transcripts, documents and exports. It is also a program on your computer rather than a hosted subscription: there is no account, and your data goes to the model you chose rather than through a platform.",
  },
  {
    question: "Can I use the connectors I already have, like MCP?",
    answer:
      "Not yet. Tools in heddle are ordinary programs on your machine, and the library agents come with the tools they need. heddle's plugin system is built so that an MCP connector can slot in, but heddle does not ship one today.",
  },
  {
    question: "What stops a tool from doing whatever it likes?",
    answer:
      "Run with --safe. Every tool then runs inside a box the operating system itself enforces — bubblewrap on Linux, seatbelt on macOS — with no home folder, nowhere to write outside the run's own workspace folder, and only the environment variables you name with --allow-env. Plugins are confined by construction: one runs in its own separate process and never sees heddle's memory or your environment. And if the machine cannot provide the box, the run stops rather than quietly carrying on unprotected.",
  },
  {
    question: "Can it hold a conversation, or wait for a person?",
    answer:
      "Both, and they are the same mechanism. --session keeps a conversation across runs — the agent is handed the turns before it — and the same session works on your machine or over the server. A flow can also stop mid-run to wait for a person: the run pauses, the question is stored, and answering it continues the job from where it stopped without redoing the work already done.",
  },
  {
    question: "Which AI models can it use?",
    answer:
      "OpenAI, vLLM, Ollama, and any service that speaks the OpenAI API. Changing model is a few lines in the file; the job itself does not change.",
  },
  {
    question: "Does it work offline?",
    answer:
      "heddle itself runs entirely on your machine: no backend, no gateway, no account. If your flow calls a hosted model you will need a connection for those requests; point it at Ollama or vLLM and the whole thing runs offline.",
  },
  {
    question: "Am I locked in?",
    answer:
      "No, and in two separate ways. There is nothing to be locked into: heddle installs into no project of yours, has no account and no service, and npx fetches it for the length of one command. And the file format is a published open standard that heddle implements rather than owns, so other conforming runtimes read the same files. If this project disappeared tomorrow, your agents would still run somewhere else.",
  },
];
