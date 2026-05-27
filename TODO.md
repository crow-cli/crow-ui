---
title: New Dawn
date: "2026-05-25"
---

# TO DO
All of the above are some of the existing TO DO items inherited from this weekend.


## CROW-CLI RELATED
- create /summary slash command for getting compaction-like summary without creating new agent in crow-cli
- some kind of spec-kit like flow but now with agent orchestration through acp mesh relay
- crow-cli install (desktop|web)

## SEARCH
- and I can't type underscores into the file search in monaco

# Paper TO DOs
I sat down and wrote out some of the things I wanted to accomplish in the coming week and I want to put them in here without trying to categorize right off the bat.

- search? sort of skeptical about this but still tended to use in zed as long ago as like last week. 
- cancellation testing out the wazoo. this needs to **always** work. _ALWAYS_
- session/load
- backend session creation
- auth with AT Proto
- save defaults/cookies for wikipedia

## UI / DESIGN
- use Reka font everywhere for a more polished/professional look (clean up custom UIs: MCP config, ACP spawning, agent profile creation/editing)

## AGENT ORCHESTRATION / PROJECT MANAGEMENT
- build simplified Plane-like task board for agent/human interop using existing queue system
  - sequential task queue: orchestrator agent sees all tasks but only acts on task N
  - task N+1 stays in "on deck" until orchestrator marks N as done
  - orchestrator self-prompts by calling tool to advance queue (mark N complete → advance to N+1)
  - use /cancel-like mechanism to immediately fire next turn when ticket moves to done
    (no waiting for end_turn to empty queue — if done, move to next item)
  - orchestrator becomes the "user" for worker agents — delegates, reviews, then advances
  - inspiration: ./plan (Plane project)
