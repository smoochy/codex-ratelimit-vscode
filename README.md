# Codex Rate Limit Monitor

A Visual Studio Code, Cursor, and Windsurf extension that shows OpenAI Codex
rate-limit usage directly in the status bar and a detailed panel.

## Features

- Shows 5-hour and weekly Codex usage percentages in the status bar.
- Uses configurable warning and critical colors for the status bar and detail
  view.
- Opens a detailed panel with reset times, time progress, and token usage.
- Refreshes automatically every 10 seconds by default and pauses while the
  window is unfocused.
- Handles current Codex data formats by combining session files with the local
  `codex app-server` fallback when needed.
- Can optionally show a short rate-limit source label directly in the status
  bar.
- Formats Output channel entries with explicit log levels such as `INFO`,
  `WARN`, and `ERROR`.
- Shows the active rate-limit source in the tooltip and detail view so you can
  verify whether values came from live session data, the app-server fallback,
  or a session snapshot fallback.

## Installation

For most users, install the extension from the editor marketplace.

### Build and install locally

Prerequisites:

- Visual Studio Code 1.96.0 or newer
- Node.js for local development

Node.js 20 or newer is recommended when packaging with recent versions of
`@vscode/vsce`.

Build a VSIX locally:

```bash
cd codex-ratelimit-vscode
npm ci
npm run package:vsix
```

Install the generated VSIX:

```bash
code --install-extension codex-ratelimit-<version>.vsix
```

After installation, reload the VS Code window.

## Usage

### Status bar

The extension displays rate-limit information in the status bar:

```text
⚡ 5H: 45% | Weekly: 23%
```

If you enable the optional source indicator, it can look like this:

```text
⚡ API | 5H: 45% | Weekly: 23%
```

- `5H` is the 5-hour session usage percentage.
- `Weekly` is the weekly usage percentage.
- Colors follow the configured warning and critical thresholds.
- Optional source labels are `Live` for direct session data, `API` for the
  `codex app-server` fallback, and `LS` for the latest session snapshot
  fallback.

### Detailed view

Click the status bar item or run `Codex Rate Limit: Show Details` to open a
detailed view with:

- 5-hour session time and usage progress
- Weekly time and usage progress
- The active rate-limit source and source detail
- Reset times and outdated indicators
- Total and last token usage summaries

### Output logs

The `Codex Rate Limit` Output channel now prefixes entries with a level label:

```text
[2026-03-08T14:59:50.000Z] [INFO ] Using live session rate limits from: ...
[2026-03-08T15:00:00.000Z] [INFO ] Using Codex app-server fallback rate limits from: ...
[2026-03-08T15:00:10.000Z] [WARN ] No rate limit data found: ...
[2026-03-08T15:00:20.000Z] [ERROR] Error during stats update: ...
```

You can control the minimum level with `codexRatelimit.logLevel`.

## Companion CLI utility

Prefer a terminal workflow? The
[codex-ratelimit](https://github.com/xiangz19/codex-ratelimit) project provides
a single-file Python CLI and TUI with a similar live view of Codex rate limits.

## Commands

- `codex-ratelimit.refreshStats` refreshes the displayed rate-limit data.
- `codex-ratelimit.showDetails` opens the detailed rate-limit panel.
- `codex-ratelimit.openSettings` opens the extension settings.

## Configuration

The extension exposes these settings:

- `codexRatelimit.enableLogging` is a legacy compatibility toggle for older
  setups that have not switched to `codexRatelimit.logLevel` yet.
- `codexRatelimit.logLevel` sets the minimum output level: `off`, `error`,
  `warn`, `info`, or `debug`.
- `codexRatelimit.showOutputOnError` opens the Output panel automatically when
  an error is logged.
- `codexRatelimit.color.enable` enables colorized status bar text and progress
  bars.
- `codexRatelimit.color.warningColor` sets the warning color.
- `codexRatelimit.color.warningThreshold` sets the warning threshold in percent.
- `codexRatelimit.color.criticalColor` sets the critical color.
- `codexRatelimit.color.criticalThreshold` sets the critical threshold in
  percent.
- `codexRatelimit.refreshInterval` controls the refresh interval in seconds.
- `codexRatelimit.sessionPath` overrides the default Codex sessions path.
- `codexRatelimit.statusBar.sourceIndicator` controls whether the status bar
  shows no source label, a short label, or a full label.

## How it works

The extension reads Codex data locally in this order:

1. It scans recent `~/.codex/sessions/.../rollout-*.jsonl` files and finds the
   latest `token_count` event for token usage.
2. If that latest `token_count` event still contains `rate_limits`, it uses
   them directly.
3. If the current local setup uses the default Codex sessions path and the
   latest `token_count` omits `rate_limits`, it queries the local
   `codex app-server` with `account/rateLimits/read`.
4. If the app-server request fails or returns no usable snapshot, it reuses the
   newest session record that still contains `rate_limits`.
5. It calculates reset times, time progress, and usage progress for the UI.

When the app-server fallback uses the bundled Codex executable from the OpenAI
extension, the lookup supports the current platform directory layout such as
`macos-aarch64`, `macos-x86_64`, `linux-aarch64`, `linux-x86_64`,
`windows-aarch64`, and `windows-x86_64` before falling back to `codex` on
`PATH`.

The tooltip and detail view show the active rate-limit source, and the status
bar can optionally show a short source label. That makes it easy to confirm
whether the extension is using the app-server fallback or only an older
session snapshot.

If you configure a custom `codexRatelimit.sessionPath`, the extension stays
session-file based and skips the local app-server fallback.

## Development

### Setup

```bash
npm ci
npm run compile
npm run package:vsix
```

Press `F5` in VS Code to launch an Extension Development Host window.

### Workflow

```bash
npm run watch
npm run compile
```

## Architecture

```text
src/
├── extension.ts           # Main extension entry point
├── services/
│   ├── codexAppServer.ts  # Local Codex app-server fallback for live rate limits
│   ├── ratelimitParser.ts # Session discovery and rate-limit aggregation
│   └── logger.ts          # Logging utilities
├── handlers/
│   ├── statusBar.ts       # Status bar management
│   └── webView.ts         # Detailed view webview
├── utils/
│   └── updateStats.ts     # Refresh scheduling and update flow
└── interfaces/
    └── types.ts           # Shared TypeScript types
```

## License

MIT
