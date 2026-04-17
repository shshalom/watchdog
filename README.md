# Watchdog

Real-time spec-compliance and drift enforcement for AI coding agents.

Watchdog observes what your agent writes, audits it against a spec you define, and blocks changes that drift from intent — in real time, before the code lands.

## What it does

- **Pre-tool-use enforcement** — deterministic rules (YAML) that block violations before they're written
- **LLM-based drift auditing** — post-write evaluation against your spec, resolves on correction
- **Context-window safety** — forces a handoff before the agent's context fills and attention degrades
- **Real-time dashboard** — see file activity, active drifts, audit trail, and an embedded PTY terminal
- **Session lifecycle tracking** — observe, correct, and resume Claude Code sessions with full history

## Requirements

- [Claude Code](https://claude.ai/code) CLI installed and authenticated
- macOS (Apple Silicon or Intel) or Linux x86_64
- Optional: Anthropic API key for LLM-based drift auditing (deterministic rules and dashboard work without it)

## Install

```bash
brew tap shshalom/watchdog
brew install watchdog
```

Or download a pre-built binary from [Releases](https://github.com/shshalom/watchdog/releases).

## Quickstart

```bash
# One-time setup: registers hooks in your project, prompts for spec + API key
cd /path/to/your/project
watchdog init

# Run the watchdog (dashboard at http://localhost:9100)
watchdog start
```

Now use Claude Code normally in that project — every tool call is observed and audited.

## How it works

1. Watchdog registers `PreToolUse` and `PostToolUse` hooks in `.claude/settings.local.json`
2. Every tool call hits the watchdog server first
3. Deterministic rules (`rules.yml`) block patterns you've defined — no LLM involved
4. File changes are batched and audited against your spec by the LLM auditor
5. Drifts surface in the dashboard with full context; corrections trigger re-audit

## Spec-as-code

A spec is a markdown file that describes intent, plus a `rules.yml` for mechanical checks:

```yaml
# .watchdog/rules.yml
rules:
  - id: no-force-unwrap
    type: file_pattern
    pattern: "\\!"
    files: "**/*.swift"
    message: "Force unwraps prohibited — use guard/if let"

  - id: max-function-length
    type: max_lines_per_function
    max: 40
```

See [`examples/`](./examples) for a complete spec template.

## Configuration

Config is read from (in priority order):

1. Environment variables (`ANTHROPIC_API_KEY`, `WATCHDOG_AUDITOR_MODEL`)
2. Project config: `.watchdog/config.yml`
3. Global config: `~/.config/watchdog/config.yml`

## Commands

```bash
watchdog init                   # interactive setup for current project
watchdog start [--port 9100]    # run the server + dashboard
watchdog status                 # show current session, drift count, pending audits
```

## Architecture

- **Rust CLI** — single binary, embeds the web dashboard
- **Web dashboard** — React + TypeScript, served at `http://localhost:{port}/`
- **Hook protocol** — HTTP POST to `http://localhost:{port}/hook/...`
- **WebSocket events** — real-time file activity, audit results, drift events

## License

MIT — see [LICENSE](./LICENSE).

## Contributing

Issues and PRs welcome. File structure:

- `cli/` — Rust server
- `dashboard-web/` — React dashboard (embedded at build time)
- `examples/` — spec templates
