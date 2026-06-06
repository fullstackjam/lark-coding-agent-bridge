# Changelog

All notable changes to **@fullstackjam/lark-coding-agent-bridge** are documented here.
This project follows [Semantic Versioning](https://semver.org/).

This is a private fork of [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) (upstream npm package `lark-channel-bridge`). The fork's reason for existing is to add an **opencode** adapter alongside the upstream's Claude Code and Codex adapters.

Upstream history is not duplicated here; consult [the upstream repo](https://github.com/zarazhangrui/lark-coding-agent-bridge/commits/main) for changes inherited at fork time.

## [Unreleased]

### Pre-release scaffolding
- Rebranded to `@fullstackjam/lark-coding-agent-bridge`; repo / bugs / homepage URLs retargeted at this fork.
- LICENSE adds a second copyright line for the fork; upstream line preserved per MIT.
- Tag-triggered release workflow added (`.github/workflows/release.yml`): pnpm install + typecheck + test + build, verifies tag matches package.json, publishes to npm with provenance, creates GitHub Release with auto-generated notes.
- **opencode adapter** — work in progress; first release will land once it passes integration tests.
