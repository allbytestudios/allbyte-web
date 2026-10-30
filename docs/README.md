# docs/

Reference material for anyone picking apart this repo — most usefully, another
solo developer trying to ship a Godot game to the browser on their own
infrastructure.

This folder is deliberately short. It holds documents written to be read by
someone who did not build this; day-to-day working notes and agent-to-agent
handoffs are kept out of the public tree, because they date fast, assume
context you do not have, and reference a private repo you cannot open.

Start with [`BRING_YOUR_OWN_GAME.md`](BRING_YOUR_OWN_GAME.md) if you want to run
the pipeline against your own game. Start with the
[root README](../README.md) if you want the tour.

| Document | What it is |
|---|---|
| [`BRING_YOUR_OWN_GAME.md`](BRING_YOUR_OWN_GAME.md) | Point the build-and-deploy pipeline at your own Godot project. The practical entry point. |
| [`WEB_GAME_BOUNDARY.md`](WEB_GAME_BOUNDARY.md) | The contract between the host page and the game iframe — what crosses it, and why that line sits where it does. |
| [`security-review-game-pipeline.md`](security-review-game-pipeline.md) | A threat model for shipping paid browser-game content: paid-content bypass, key exfiltration, pipeline compromise, cache poisoning. Threat → controls → residual risk, with the residual risk named honestly. Worth reading before you build gating of your own. |
| [`PUBLIC_PRIVATE_BOUNDARY.md`](PUBLIC_PRIVATE_BOUNDARY.md) | What belongs in a public repo when that repo is also the control plane for a real business, and the rules that keep the two apart. |
| [`DEPLOY_HISTORY.md`](DEPLOY_HISTORY.md) | How a deploy is attributed to a shipped game build. |
| [`self-hosting-with-claude.md`](self-hosting-with-claude.md) | Long-form writeup of the architecture and what it costs to run. |
| [`manual-overrides/`](manual-overrides/) | Edited source text for the in-game instruction booklet. Content, not engineering. |

The deploy runbook lives at [`../DEPLOY.md`](../DEPLOY.md); the reusable
infrastructure templates are in [`../deploy/`](../deploy/).
