---
title: New Dawn
date: "2026-05-25"
---

# TO DO

## Typst / Documentation
- [ ] Command palette entries for "New Chapter" and "New Journal Entry"
- [ ] Agent as Typst tutor — guides user through markup, creates files, opens preview
- [ ] Compile all books in .crow/docs to a single unified site
- [ ] llms.txt in system prompt for Typst reference

## crow-ui Polish
- [ ] Command palette should drop down from top (not modal center)
- [ ] Clean up custom UIs: MCP config, ACP spawning, agent profile creation/editing
- [ ] Fix underscore typing in Monaco file search
- [ ] Save defaults/cookies for Wikipedia (and other web tools)

## Agent / Orchestration
- [ ] /summary slash command — compaction-like summary without creating new agent
- [ ] spec-kit flow with agent orchestration through ACP mesh relay
- [ ] Plane-like task board UI (backend orchestration + CRUD exists — needs frontend kanban board)
  - sequential task queue: orchestrator sees all tasks, acts on task N only
  - task N+1 stays "on deck" until orchestrator marks N as done
  - orchestrator self-prompts to advance queue
  - /cancel-like mechanism to fire next turn immediately when done
  - orchestrator delegates to worker agents, reviews, advances
- [ ] Cancellation testing — needs to **always** work. _ALWAYS_

## Integration
- [ ] auth with AT Proto (for tangled.sh git integration)
- [ ] tangled.sh integration — self-hosted knots and spindles
- [ ] crow-cli install (desktop|web)

## Whiteboard / Knowledge
- [ ] Whiteboard app for agent/human interaction (spatial canvas, not chat)
- [ ] Wiki/knowledge base for agents to edit/use AND for humans
- [ ] Journaling system embedded with the above
