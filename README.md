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

- **`/q <prompt>`** queues a prompt. While a turn is running it answers at once
  (`Queued until this turn ends (2 waiting)`); while idle it sends straight away.
- Queued prompts go out **one per turn, in order**, each as your own message.
- **A band above the prompt** lists the queue while it has anything in it:
  - **Edit** a prompt in place (Enter saves; saving it empty removes it)
  - **↑ / ↓** to reorder, **✕** to remove
  - **Pause / Resume** and **Clear** for the whole queue
- Editing a prompt pauses sending, so a half-edited prompt never goes out.
- Interrupting a turn (Esc) pauses the queue rather than sending into the
  interruption. Resume from the band.
- `chat:queueSubmit` (`ctrl+x enter` by default) feeds the same queue, for
  anyone who prefers a key to a command.

To reach the band from the keyboard: **ctrl+x tab** focuses it, Tab or the
arrows move between buttons, Enter presses one, Esc returns to the prompt.

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
