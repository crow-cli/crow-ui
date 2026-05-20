# crow-ui Vision & Roadmap

## Philosophy

crow-ui is a **personal operating system** for learning and exploration — not an IDE for developers. It's edutainment. A teaching assistant, not just a coding assistant.

The agent is the central focus. Users learn by watching agents work and copying what they see. The system teaches users how to use itself.

> "I copy stuff I see the agent do from the command line!"

## Target User

**Normal people** who have never thought about becoming developers but are interested in AI agents. They want to:
- Learn new subjects through guided exploration
- Have agents do research on topics they care about
- Own their online identity (get off Facebook/Twitter)
- Have their own webpage and services

## Architecture Principles

1. **Treat it like a server**, not a general-purpose "open anywhere IDE"
2. **Backend owns the state** — frontend is a view into backend state that agents can control
3. **FlexLayout panels are atomic** — each panel is a "screen" like in a strategy game
4. **No VSCode extension model** — features are built into core, not plugins
5. **Protocols over bespoke tools** — ACP, MCP, atproto — but hide the complexity from users

## UI Vision

Canvas-like experience for new users. Introduce them to the system slowly.

```
┌──────────────────────────────────────────────────────────────┐
│  🤖 Agent Canvas (central focus)                             │
│  ┌─────────────────────────────┐  ┌─────────────────────┐   │
│  │                             │  │  📊 Status Panel     │   │
│  │  [Agent working...]         │  │  Coder ▶▶▶          │   │
│  │                             │  │  Searcher ○○○       │   │
│  │  "Let me search for         │  │  Teacher ●●●        │   │
│  │   papers on CRISPR..."      │  │                      │   │
│  │                             │  │  [View Terminal]     │   │
│  │  [Explain this] [Cancel]    │  │  [View Code]         │   │
│  └─────────────────────────────┘  └─────────────────────┘   │
├──────────────────────────────────────────────────────────────┤
│  🖥️ Terminal │ 📝 Editor │ 🐳 Containers │ 🌐 Identity       │
│  (discoverable, not default)                                  │
└──────────────────────────────────────────────────────────────┘
```

Eventually: d3.js or HTML5 game engine for crazy customizable UI on top of backend state.

## Agent Architecture

### HITL Orchestrator (Teaching Agent)
- Talks to user
- Manages research quests
- Explains what other agents are doing
- **NEVER interrupts coding agents with questions**

### HOTL Workers
- **Coder Agent**: implements, tests, iterates
- **Searcher Agent**: scours literature/web
- **Verifier Agent**: tries to reproduce results, updates knowledge graph (real vs imagined)
- **Teacher Agent**: generates explanations for user

The bottleneck IS the user. The orchestrator's job is to keep the user informed and educated without slowing down the workers.

## Business Model

Managed hosting via crow-ai.dev:
- User pays → gets domain + pre-configured droplet
- Own PDS (atproto identity)
- Own tangled.sh knot (git++ / social coding)
- crow-ui preconfigured
- Email forwarding (synpon.com or ProtonMail)

Desktop (Electron) = free, local, unauthenticated by default
Web (managed) = paid, remote, authenticated via user's PDS

## Integration Points

### tangled.sh (git++)
- Not raw git — the full social coding platform
- PRs, stacked PRs, round-based reviews
- Spindle CI status
- Activity feed from social graph
- Panel in FlexLayout alongside filesystem

### atproto / PDS
- Each user gets their own PDS
- OAuth auth into crow-ui
- Identity for tangled.sh, Bluesky, etc.
- Data ownership

### Email
- synpon.com forwarding or ProtonMail integration
- Part of the "own your identity" story

## Technical Priorities

### Immediate (This Week)

1. **Chat focus fix** — keep scroll at bottom when user clicks back into chat
2. **Streamdown link fix** — remove link control behavior that's banning local links
3. **Shell config loading** — ensure ~/.bashrc, ~/.zshrc are sourced in spawned terminals/agents
4. **API provider panel** — UI for OpenAI-compatible API key + base URL
5. **Agent config panel** — already started, finish it

### Short Term (Next 2 Weeks)

6. **Backend orchestration APIs** — Rust APIs where agent requests get responses when done
7. **MCP/ACP debugging platform** — view inputs/outputs of agent/MCP servers with debug stops
8. **crow-cli integration** — tighter coupling, eliminate `crow-cli init`
9. **Frontend state API** — backend exposes state that agents can control

### Medium Term (Next Month)

10. **Tangled panel** — integrate tangled.sh into FlexLayout
11. **Container management panel** — Docker/Compose UI
12. **Knowledge graph** — visualize user interests and agent findings
13. **Research queue** — structured quests for agents

### Long Term

14. **d3.js/HTML5 game UI** — Civilization-style panels
15. **Email integration** — synpon.com or ProtonMail
16. **Multi-agent orchestration** — full HITL/HOTL pipeline
17. **OpenPipe/ART training** — fine-tune models on agent traces

## Research & Training

- Feed examples from https://github.com/openpipe/art
- Start small, iterate quickly
- Scale to qwen3.6-35B-A3B and larger
- Agents teach users by example — "I copy stuff I see the agent do"

## Notes

- "Our UI is pretty good for minimal IDE style! I have to stop myself in Zed to remind myself this isn't crow-ui!"
- crow-ui-server running on remote machine (coast-after-3) — working well
- Need to avoid hardcoding `/home/thomas` — use `dirs::home_dir()`
- Need to ensure PATH includes `~/.local/bin` when spawning agents
