# pi-tab-title

A [Pi](https://pi.dev) extension that names each session automatically and shows task state in the terminal tab, so a wall of open tabs stays readable.

On the first prompt of a session it asks a naming model for a short title and applies it to both the **terminal tab title** and the **Pi session name** — in parallel with the main task, without waiting for the first answer. While the agent works, the title carries an animated braille spinner; a failed turn shows `×`, a completed turn `·`.

Uses only public Pi extension APIs. No AppleScript, no window lookup, no terminal configuration changes.

## Requirements

- Node.js **22.19.0+**.
- Pi Coding Agent — developed and tested against **0.85.1** (`@earendil-works/pi-coding-agent`). Other versions are untested.
- A terminal that honors programmatically set titles.

## Terminal support

The extension calls `ctx.ui.setTitle()`, which sends the standard OSC 0 title sequence. Any terminal that lets applications set the window title can work — Ghostty, iTerm2, WezTerm, kitty, Windows Terminal, and others. **The protocol is portable; how a title maps to a tab, window, or split is decided by the terminal.** None of these were tested one by one; treat them as targets, not verified combinations.

Known caveats:

- A manually pinned tab title, a terminal that blocks app-set titles, or tmux/screen may override or intercept the sequence. Configure those environments accordingly.
- Icons depend on font coverage. Titles carry no ANSI color, so a single icon cannot be colored.
- Interactive TUI mode only. Print, JSON, and RPC modes never set a terminal title.

## Install

As a Pi package:

```sh
pi install npm:pi-tab-title
```

Or straight from GitHub:

```sh
pi install git:github.com/KKinsz/pi-tab-title
```

Then reload inside Pi:

```text
/reload
/new
```

Submit the first prompt of a new session to trigger naming.

<details>
<summary>Manual single-file install</summary>

Download `index.ts` into `~/.pi/agent/extensions/auto-tab-name/index.ts`, then run `/reload`.

Use either the package or the manual file, **not both**, or commands and the tool may be registered twice.
</details>

## Usage

| Action | Behavior |
| --- | --- |
| First prompt of a new session | Generates a short title in parallel with the main task |
| `/tabname Login flow triage` | Sets the title immediately; no model call |
| `/tabname auto` | Regenerates once from the first user text of the current branch |
| `/tabname` | Shows the current title and usage |
| `/tabmodel` | Picks a naming model from the credentialed models in Pi; saved globally |
| `/tabmodel provider/model-id` | Sets an exact naming model; the ID may contain `/` |
| `/tabmodel current` | Pins the session model at the time of the command |
| `/tabmodel show` | Shows the current naming model and config path |
| `/tabmodel reset` | Removes the global preference and follows the session model again |
| `/name Custom title` | Pi's built-in rename, mirrored into the terminal title |
| "rename this tab to login triage" | The agent may call `rename_session_tab`, behind a confirmation dialog |

Natural-language renaming is ordinary conversation and may consume main-model usage. The first automatic naming needs no tool call and no confirmation.

## Naming model

By default the extension uses the model of the current session. If that model is slow or expensive, pick a lighter one:

```text
/tabmodel
```

The list comes from Pi's available-model snapshot (credentialed models — not a guarantee that the remote service is reachable). The choice is saved to `~/.pi/agent/pi-tab-title.json` (or `$PI_CODING_AGENT_DIR/pi-tab-title.json` if that variable is set):

```json
{
  "version": 1,
  "provider": "example-provider",
  "model": "example-small-model"
}
```

Only the provider and model identifier are stored — credentials and gateway URLs stay with Pi. You can edit the file by hand.

- **Global:** every session reads it on its next naming request; no restart needed. Concurrent writes resolve to the last successful save.
- **Existing sessions are not renamed retroactively.** Use `/tabname auto` if you want one; it still derives the title from the first user input.
- **An explicit choice never falls back.** A typo, a removed model, or a missing credential fails that attempt instead of silently sending your prompt to a different provider.
- `/tabmodel reset` goes back to following the session model and deletes the file.
- Not a chat command? Model commands are TUI-only.

## Status icons

| Tab title | Meaning |
| --- | --- |
| `⠋ Login flow triage` | Running; the frame advances every 200 ms |
| `× Login flow triage` | Final model error, unrecovered truncation, or failed auto-compaction |
| `· Login flow triage` | The turn ended normally (not an acceptance signal) |

- State comes from lifecycle events. The timer only animates; it never polls the task or the model.
- Animation stops on `agent_settled` once Pi is idle, so automatic retries, compaction, and queued follow-ups are not misreported as complete.
- A failed tool does not fail the task while the agent keeps working; a later successful reply clears it.
- Icons live only in the terminal title. They are never written to the session name or persisted state, and they survive renames.
- Aborted runs clear the icon. Pi sometimes restores its own default title; the extension takes over again on the next run.
- Reload, session switch, tree navigation, and shutdown all stop the animation.

## Behavior notes

- **One-shot:** a `pending` marker is persisted before the network call, so a failure, crash, or reload never auto-retries.
- **Manual wins:** a manual rename cancels the in-flight request, and a late result cannot overwrite it.
- **Session isolation:** requests from a previous session or runtime cannot write into the current one. Branch navigation does not re-open automatic naming.
- **No backfill:** resumed sessions keep their saved title; older sessions without one are not named automatically.
- **Non-blocking:** the request starts in `before_agent_start` and never waits for the assistant. Cancelling the main task does not necessarily cancel a naming request already in flight.
- **TUI only:** print, JSON, and RPC modes write no title, persist no state, and send no request.
- **Empty input skipped:** an image-only or whitespace first prompt is skipped and not retried later.

## Data and cost

Automatic naming sends the naming system prompt plus the first **1,000** characters of the first user text to the naming model. Un-expanded interactive input is preferred over skill/template-expanded bodies; `/tabname auto` reads the first user text from the current branch.

No assistant replies, tool output, images, or main system prompt are attached. **Input is not redacted:** if those 1,000 characters contain a secret, it may be sent — decide based on the data policy of the model you select. The resulting title is stored as the Pi session name and shown in the terminal, so check before sharing screenshots.

Request parameters: up to 1,024 output tokens; `low` reasoning effort when the model supports reasoning (clamped to the model's capability); a 25-second deadline; `cacheRetention: none`. Cancellation is forwarded to the provider, though whether it stops immediately is up to the provider.

A short title is not a small bill. Naming requests may be billed, and their usage is not included in Pi's session footer. A provider reporting `cost=0` does not prove it was free.

## Troubleshooting

**The tab never changes.** Some terminals give a manually set title precedence. Clear the manual override, then run `/tabname Title`. Also check whether another dynamic-title extension is enabled — this extension does not poll to reclaim the title.

**Naming fails.** Run `/tabmodel show`, then verify the configured provider has credentials in Pi. Re-pick with `/tabmodel`, or name the tab manually. Error notices never echo the underlying authentication text.

## Development

```sh
git clone https://github.com/KKinsz/pi-tab-title.git
cd pi-tab-title
npm ci
npm run check
```

- `npm run typecheck` — TypeScript check against the Pi 0.85.1 API.
- `npm test` — 64 offline tests over mock Pi contexts, mock model responses, and an isolated temp config dir. No credentials are read, no real model is called, and the current terminal and session are untouched.
- Coverage includes the one-shot rule, non-blocking start, manual-rename precedence, confirmation-dialog races, non-TUI modes, config corruption and failed saves, in-flight cancellation, picker races, animation lifecycle, retry recovery, tool-error recovery, truncation, compaction failure, and multi-session isolation.
- These tests are not a substitute for a real model, real Pi lifecycle, or GUI end-to-end verification.

```text
index.ts                        Extension entry (no build step)
tests/auto-tab-name.test.mjs    Automatic naming regressions
tests/tab-status.test.mjs       Status icon regressions
tests/tab-model.test.mjs        Naming model config regressions
tests/isolated-config.mjs       Test config isolation
package.json                    Pi package manifest
tsconfig.json                   Type-check config
LICENSE                         MIT
```

## Uninstall

```sh
pi remove npm:pi-tab-title
```

For a manual install, move the `auto-tab-name` directory out of `extensions/`. Both need `/reload`. Session names already saved are kept.

## References

- [Pi extensions](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi packages](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/packages.md)
- [OSC 2 window title](https://ghostty.org/docs/vt/osc/2)

## License

MIT, see [LICENSE](LICENSE).
