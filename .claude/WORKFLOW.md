# Agentic workflow pipeline

How feature work gets built in this repo. The orchestrator (Opus, the main session) chunks
requirements and routes them to six specialist subagents defined in `.claude/agents/`, all
pinned to **Sonnet**. Two quality gates loop until they're satisfied; nothing ships past a
gate that still has comments.

## The pipeline

```mermaid
flowchart TD
    U([User requirements]) --> O[["Orchestrator · Opus<br/>chunk into items, route, own the phase doc"]]

    O -->|"UI work"| D["<b>ux-designer</b><br/><i>mockup/*.html</i><br/>Read Write Edit Glob Grep Agent"]
    O -.->|"contract work — starts in parallel,<br/>does not wait for design"| BE["<b>backend-impl</b><br/><i>schema · repositories · store · SQL migrations</i><br/>Read Write Edit Glob Grep Bash Agent"]

    D --> R{"<b>ux-reviewer</b><br/>Nielsen heuristics · WCAG 2.2 AA<br/>DESIGN-SYSTEM.md compliance<br/><i>read-only</i>"}
    R -->|"CHANGES REQUESTED<br/>numbered findings, severity-ranked<br/>blocker / major / minor / nit"| D

    R -->|"<b>APPROVED — zero comments</b>"| FE["<b>frontend-engineer</b><br/><i>src/features · src/components · index.css</i><br/>Read Write Edit Glob Grep Bash Agent"]
    BE <-.->|"publishes contract deltas early;<br/>frontend consumes, never edits"| FE

    FE --> CR{"<b>code-reviewer</b><br/>smells · correctness · consistency<br/>runs build / lint / test<br/><i>read-only</i>"}
    BE --> CR

    CR -->|"findings → the <i>responsible</i> engineer"| FE
    CR -->|"findings → the <i>responsible</i> engineer"| BE

    CR -->|"<b>clean</b>"| QA{"<b>qa-tester</b><br/>end-to-end vs. requirements<br/>writes/extends Vitest<br/>empty · loading · error · offline<br/>light + dark · persistence · regression"}

    QA -->|"<b>FAIL</b> — defects w/ repro steps<br/>→ engineer → re-review → re-QA"| FE
    QA -->|"<b>FAIL</b>"| BE

    QA -->|"<b>PASS</b>"| DONE([Merge / ship])

    classDef gate fill:#fdf1dc,stroke:#c98a2e,stroke-width:2px,color:#3a2c17
    classDef maker fill:#e8f2ec,stroke:#3f8f6b,stroke-width:1.5px,color:#16301f
    classDef orch fill:#efe7f5,stroke:#7a5ba8,stroke-width:2px,color:#2b1f3a
    class R,CR,QA gate
    class D,FE,BE maker
    class O orch
```

**The two hard gates.** `ux-reviewer` only returns `APPROVED` at *zero* comments — it does
not rubber-stamp, and it does not manufacture blockers to prolong the loop. `qa-tester`
runs **only after** `code-reviewer` has fully approved; a defect it finds goes back to the
responsible engineer, then back through code review, then back to QA. Neither gate edits
files — they produce judgment, which is what keeps them honest about the work.

## Haiku fan-out

The three agents that *write* code may parallelise genuinely independent subtasks onto
**Haiku** helpers (`subagent_type: "general-purpose"`, `model: "haiku"`). The parent always
owns integration and final verification.

```mermaid
flowchart LR
    P["ux-designer<br/>frontend-engineer<br/>backend-impl<br/><i>(Sonnet)</i>"] --> H1["helper · Haiku"]
    P --> H2["helper · Haiku"]
    P --> H3["helper · Haiku"]
    H1 --> I["parent integrates<br/>+ verifies"]
    H2 --> I
    H3 --> I

    X["ux-reviewer<br/>code-reviewer<br/>qa-tester"] -.->|"never delegates —<br/>holistic judgment"| X
```

Fan out only **self-contained** tasks: "port these CSS tokens", "write the empty-state
markup for one panel", "restyle the budget category bars". Anything interdependent,
state-critical, or contract-shaping stays under the parent's own hand.

## Who owns what

| Agent | Model | Writes? | Territory |
|---|---|---|---|
| **orchestrator** | Opus | yes | Chunks requirements, routes work, owns `PHASE*.md`, makes the calls that are the user's to confirm |
| **ux-designer** | Sonnet | `mockup/` only | Self-contained static HTML/CSS/JS mockups. **Never touches `src/`** |
| **ux-reviewer** | Sonnet | no | Heuristics, WCAG 2.2 AA, design-system compliance. Verdict + severity-ranked findings |
| **backend-impl** | Sonnet | `src/data`, `src/store`, `supabase/` | Schema, repositories, store actions, migrations, autoplan. Holds the overarching view |
| **frontend-engineer** | Sonnet | `src/features`, `src/components`, `src/index.css` | Implements the *approved* mockup. Consumes contracts, never reshapes them |
| **code-reviewer** | Sonnet | no | Correctness, smells, consistency. May run `build` / `lint` / `test` |
| **qa-tester** | Sonnet | test files only | End-to-end behaviour + Vitest coverage. Does **not** rewrite production code — defects go back to the engineer |

## The rules that make it work

- **Design before implementation.** Non-trivial UI goes through mockup + review first. The
  approved mockup is the source of truth the frontend is built to match.
- **Frozen contracts are one-way.** `src/data/schema.ts`, `tripRepository.ts`, `seed.ts`,
  `useTripStore.ts`, `lib/autoplan.ts` carry `FROZEN CONTRACT` headers. The
  frontend-engineer **flags** a needed contract change to the orchestrator rather than
  editing it — it gets routed to `backend-impl`, which publishes the delta back.
- **The two tracks run in parallel.** `backend-impl` starts alongside the *design* track,
  not after it, so the seams are ready when the frontend begins.
- **Read `mockup/DESIGN-SYSTEM.md` first** — every agent that touches design or CSS. It is
  the written-down token set, semantic colour vocabulary, contrast rules and a11y floor.
  Do not re-derive it from the stylesheet.
- **Green gates are not proof.** A fully green suite has missed real defects here before
  (unmemoized `onClose` breaking typing; debounce refs shared across places; a raw
  `TypeError` surfaced to the user offline). Independently re-verify an agent's claims —
  reverting a fix and watching the test fail beats trusting a green run.
- **Check the documented traps first.** Each `PHASE*.md` lists predicted failure modes. In
  Phase 4 a documented trap fired *exactly as written* and was caught only because someone
  went looking for it.
