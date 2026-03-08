# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

- Nothing yet.

## [0.13.0] - 2026-03-08

- Add a fallback to the official local `codex app-server`
  `account/rateLimits/read` API when newer `token_count` events omit
  `rate_limits`.
- Reuse the newest session snapshot that still contains `rate_limits` if the
  local app-server fallback is unavailable.
- Show the active rate-limit source in the tooltip and detail view to make
  fallback behavior easy to verify during testing.
- Add an optional status-bar source indicator with `Live`, `API`, and `LS`
  labels for quick verification.
- Prefix output-channel entries with explicit log levels such as `INFO`,
  `WARN`, and `ERROR`, and add a configurable minimum log level setting.
- Log the direct live-session source explicitly, so source switches are visible
  in the Output channel even when no fallback is needed.
- Add an npm packaging helper that writes VSIX files as
  `codex-ratelimit-<version>.vsix`.
- Prefer bundled Codex executables before `codex` on `PATH` and avoid noisy
  per-candidate failure logs when a later fallback candidate succeeds.
- Support newer absolute reset timestamps such as `reset_at` alongside the
  historical session formats.

## [0.12.0] - 2025-11-08

- Add an opt-in setting to show the Output panel when errors are logged so it
  no longer steals focus by default.

## [0.11.0] - 2025-11-08

- Switch session discovery to a two-phase search that prioritizes files touched
  within the last hour before walking the previous seven days by modification
  time, ensuring continued work in older sessions is detected.

## [0.10.0] - 2025-10-27

- Add customizable color settings for status bar and webview progress
  indicators with warning and critical thresholds.
- Improve tooltips and webview displays to handle outdated data and format
  token totals more readably.
- Make the rate-limit parser resilient to missing usage payloads while keeping
  the UI responsive.
- Support new input data formats with both absolute (`resets_at`) and relative
  (`resets_in_seconds`) timestamp fields.
- Add validation for `window_minutes` to prevent calculation errors with
  invalid or missing window data.
- Improve reset-time calculation accuracy by using current time instead of the
  record timestamp.

## [0.9.0] - 2025-09-28

- First public release of the Codex Rate Limit Monitor extension
