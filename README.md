# claude-queue-mod

A [Claude Code](https://code.claude.com) mod that queues prompts until Claude's
running turn ends.

When you send a message while Claude is working, Claude Code delivers it into
the running turn, between tool calls. Sometimes you want the opposite: a
follow-up that waits until Claude has finished, then goes out as its own turn.

```
/q now write tests for what you just changed
```

## What it does

- **`/q <prompt>`**, or **Tab** once bound (below), queues a prompt. While a
  turn is running it confirms in a toast (`Queued: 2 waiting.`); while idle it
  sends straight away. `/q` leaves nothing in the transcript.
- Queued prompts go out **one per turn, in order**, each as your own message.
  Only one goes at a time, and one Claude Code refuses goes back to the front
  of the queue with a toast.
- **A band above the prompt** lists the queue while it has anything in it,
  with **Pause / Resume** and **Clear**.
- **Steer**: Enter on a queued prompt sends it into the turn Claude is running
  now, read at its next step. A "↪ steering" line turns into "✓ read" once the
  model has it; if the turn ends first, a short "continue" prompt follows so the
  steer is not lost. While idle, Enter sends the prompt as a turn of its own.
- Editing a prompt pauses sending, so a half-edited prompt never goes out.
- Interrupting a turn (Esc) pauses the queue rather than sending into the
  interruption, with a toast saying so. Resume from the band.

### Keys

Mods cannot see keys typed in the prompt box, so the two shortcuts come from
Claude Code's own actions. Add them to `~/.claude/keybindings.json`:

```json
{
  "bindings": [
    {
      "context": "Chat",
      "bindings": {
        "tab": "chat:queueSubmit",
        "alt+up": "abovePrompt:focus"
      }
    },
    {
      "context": "Autocomplete",
      "bindings": {
        "tab": "autocomplete:accept"
      }
    }
  ]
}
```

- **Tab** submits the prompt with "wait for this turn", which the mod holds.
  The `Autocomplete` entry keeps Tab accepting file, command and skill
  suggestions while their menu is open: without it, a `Chat` binding for Tab
  wins over the built-in autocomplete one and submits the prompt. The dim
  suggestion in an empty prompt box is taken with → instead: Claude Code drops
  an empty submit before any mod sees it, so Tab cannot do both.
- **alt+↑** (or the default **ctrl+x tab**) moves into the band, with the focus
  on the **newest** queued prompt. alt+↑ is also `/diff`'s file-list key, which
  this binding takes over while the prompt box has focus.

In the band:

| Key | Does |
| --- | --- |
| ↑ / ↓ | move to the prompt before / after |
| Enter | steer the focused prompt into the running turn (send it, while idle) |
| `e` | edit the focused prompt (Enter saves; saving it empty removes it) |
| `k` / `j` | move the focused prompt up / down the queue |
| `x` | remove the focused prompt |
| `p` | pause / resume sending |
| Esc | back to the prompt box |

## Install

From inside Claude Code:

```
/plugin marketplace add gergesh/claude-queue-mod
/plugin install wait-queue@claude-queue-mod
```

Or run it from a checkout without installing:

```sh
git clone https://github.com/gergesh/claude-queue-mod
claude --plugin-dir ./claude-queue-mod
```

Mods (function-hook plugins) are an early-access Claude Code feature; the API
may change between releases.

## Develop

```sh
claude plugin validate .   # what the engine would load or refuse
claude plugin test .       # hooks/register.test.ts against the engine
tsc -p .                   # after Claude Code has loaded the mod once
```

Claude Code writes the API's type declarations into `.claude-plugin/types/` each
time it loads the mod, and `tsconfig.json` extends the config it writes there,
so type-checking works once the mod has been loaded (with `--plugin-dir`, or as
an installed plugin). That folder is not committed.

- `hooks/register.tsx`: the mod
- `hooks/register.test.ts`: its tests, on the terminal and desktop surfaces
- `types/index.d.ts`: the session state the mod keeps (`$.state`)
