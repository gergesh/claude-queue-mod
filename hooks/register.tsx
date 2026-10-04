import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { QueueItem } from '../types'

// The engine delivers a prompt typed mid-turn into that turn even when the
// person asked it to wait (`e.wait`, chat:queueSubmit). This mod holds such
// prompts, and those given to `/q <prompt>`, sends them one per turn once the
// session is idle, and lists them in a band above the prompt to steer into the
// running turn, edit, reorder, remove or pause.

const items = atom({ plugin: 'wait-queue', key: 'items' } as const, [])
const editingId = atom({ plugin: 'wait-queue', key: 'editingId' } as const, null)
const isPaused = atom({ plugin: 'wait-queue', key: 'isPaused' } as const, false)
const steered = atom({ plugin: 'wait-queue', key: 'steered' } as const, [])
const runningTurnId = atom({ plugin: 'wait-queue', key: 'runningTurnId' } as const, null)
const isReleasing = atom({ plugin: 'wait-queue', key: 'isReleasing' } as const, false)

const ROW = 'row-'
const EDIT = 'edit-'
const STEER_FRAME = '[The user sent this while you were working. Apply it to the current task now.]'
const STEER_NUDGE = 'Continue the task, applying the instruction I just sent.'

function isQueueCommand(text: string): boolean {
  return /^\/q(\s|$)/.test(text.trim())
}

function truncate(text: string, width: number): string {
  const line = text.replace(/\s+/g, ' ')
  return line.length <= width ? line : `${line.slice(0, width - 1)}…`
}

function moveItem(list: QueueItem[], id: string, offset: -1 | 1): QueueItem[] {
  const from = list.findIndex(item => item.id === id)
  const item = list[from]
  const to = from + offset
  if (item === undefined || to < 0 || to >= list.length) return list
  const rest = list.filter(other => other.id !== id)
  return [...rest.slice(0, to), item, ...rest.slice(to)]
}

function showCount($: EngineInterface, count: number) {
  $.ui.status(count === 0 ? undefined : `${count} queued`)
}

async function enqueue($: EngineInterface, text: string): Promise<number> {
  const item: QueueItem = { id: crypto.randomUUID(), text }
  const next = await update($, items, list => [...list, item])
  showCount($, next.length)
  return next.length
}

async function take($: EngineInterface, id: string): Promise<QueueItem | undefined> {
  const item = (await read($, items)).find(one => one.id === id)
  if (item === undefined) return undefined
  const rest = await update($, items, list => list.filter(one => one.id !== id))
  showCount($, rest.length)
  return item
}

// Puts a prompt that did not get through back at the front of the queue.
async function restore($: EngineInterface, item: QueueItem, reason: string) {
  await update($, isReleasing, () => false)
  const list = await update($, items, current => [item, ...current.filter(one => one.id !== item.id)])
  showCount($, list.length)
  $.ui.toast(`${reason}; it is back at the front of the queue.`)
}

// Sends a prompt as the person's own; one the engine refuses goes back in the queue.
function submit($: EngineInterface, item: QueueItem) {
  void $.prompt
    .submit({ text: item.text, asUser: true })
    .then(result => (result.drop === undefined ? undefined : restore($, item, `Not sent (${result.drop})`)))
    .catch(() => restore($, item, 'Could not send'))
}

// Sends the head of the queue, unless the queue is paused, a prompt in it is
// being edited, or one already went and its turn has not started.
async function sendNext($: EngineInterface) {
  if ((await read($, isPaused)) || (await read($, editingId)) !== null || (await read($, isReleasing))) return
  const [first] = await read($, items)
  if (first === undefined) return

  await update($, isReleasing, () => true)
  const item = await take($, first.id)
  if (item !== undefined) submit($, item)
}

// Sends one queued prompt into the running turn, read at the model's next step;
// while idle it goes as a turn of its own.
async function steer($: EngineInterface, id: string) {
  const isWorking = (await read($, runningTurnId)) !== null
  const item = await take($, id)
  if (item === undefined) return
  if (!isWorking) {
    submit($, item)
    return
  }

  const appended = await $.session
    .append({ message: { type: 'user', content: [{ type: 'text', text: `${STEER_FRAME}\n\n${item.text}` }] } })
    .catch((error: unknown) => ({ deny: error instanceof Error ? error.message : String(error) }))
  if (appended.deny !== undefined) {
    await restore($, item, `Not steered (${appended.deny})`)
    return
  }

  await update($, steered, list => [...list, { id: item.id, text: item.text, status: 'pending' as const }])
  $.ui.toast('Steered into the current turn.')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A reload or a new process starts with nothing in flight.
    await update($, isReleasing, () => false)
    await $.command.register({
      name: 'q',
      description: 'Queue a prompt to send after the current turn ends',
      argumentHint: '<prompt>',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'q' }, async ($, e) => {
    // Answers in a toast, not text: /q leaves nothing in the transcript (see the
    // CommandOutput and UserMessage hooks below).
    const text = e.args.trim()
    if (text === '') {
      $.ui.toast('Usage: /q <prompt>. The queue panel above the prompt manages what is queued.')
      return {}
    }

    const count = await enqueue($, text)
    if ((await read($, runningTurnId)) === null) {
      // A submit can't start inside this hook (it would wait on the command's own
      // dispatch), so it goes out on the clock's next tick, once the command is done.
      $.clock.after(0, () => void sendNext($))
      $.ui.toast('Sending now.')
      return {}
    }
    $.ui.toast(`Queued: ${count} waiting.`)
    return {}
  })

  on('prompt.submit', async ($, e, next) => {
    const isWaitingRequest =
      e.wait && e.turnId !== undefined && e.origin.kind === 'composer' && e.attachments === undefined
    if (!isWaitingRequest) return next(e)

    const count = await enqueue($, e.text)
    return { drop: `Queued (${count} waiting).` }
  })

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    await update($, runningTurnId, () => result.turnId)
    await update($, isReleasing, () => false)
    return result
  })

  on('turn.step', async function* ($, e, next) {
    // The step after a steer carries it to the model.
    if (e.turnId === (await read($, runningTurnId)) && (await read($, steered)).some(one => one.status === 'pending')) {
      await update($, steered, list => list.map(one => ({ ...one, status: 'read' as const })))
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    if (e.turnId === (await read($, runningTurnId))) await update($, runningTurnId, () => null)

    const hasUnreadSteer = (await read($, steered)).some(one => one.status === 'pending')
    await update($, steered, () => [])

    if (e.isAborted) {
      // An interrupted turn pauses the queue; the person resumes or edits it in the band.
      const waiting = (await read($, items)).length
      if (waiting > 0) {
        await update($, isPaused, () => true)
        $.ui.toast(`Queue paused: turn interrupted (${waiting} waiting). Resume it from the panel.`)
      }
      return result
    }

    if (hasUnreadSteer) {
      // The turn ended before the model read the steer: ask it to pick it up
      // first; the queue goes on after that turn.
      void $.prompt.submit({ text: STEER_NUDGE, asUser: true }).catch(() => $.ui.toast('Could not ask Claude to continue.'))
      return result
    }

    await sendNext($)
    return result
  })

  // /q runs are kept out of the transcript's drawing (the model still reads them).
  on('ui.render', { component: 'CommandOutput' }, ($, e, next) =>
    e.props.command === 'q' ? $.ui.resolve(e).Box({}) : next(e),
  )

  on('ui.render', { component: 'UserMessage' }, ($, e, next) =>
    isQueueCommand(e.props.text) ? $.ui.resolve(e).Box({}) : next(e),
  )

  // The row the band's focus ring is on, so e / k / j / x act on it.
  let focusedId: string | undefined

  on('ui.focus', { component: 'AbovePrompt' }, ($, e, next) => {
    if (e.plugin === $.plugin.name && e.element?.startsWith(ROW) === true) focusedId = e.element.slice(ROW.length)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, items)
    const steering = await read($, steered)
    if (e.props.hasSurvey || (list.length === 0 && steering.length === 0)) return next(e)

    const paused = await read($, isPaused)
    const editing = await read($, editingId)
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // A surface without text fields lists, steers, reorders and removes, but does not edit.
    const Input = 'Input' in elements ? elements.Input : undefined

    // Sending resumes on its own at the next turn's end; while idle it is nudged here.
    const resumeIfIdle = async () => {
      if ((await read($, runningTurnId)) === null) await sendNext($)
    }
    // Read at press time: moving the focus ring does not redraw the band.
    const focusedRow = async () => {
      const current = await read($, items)
      return (current.find(item => item.id === focusedId) ?? current[current.length - 1])?.id
    }
    const moveFocused = async (offset: -1 | 1) => {
      const id = await focusedRow()
      if (id !== undefined) await update($, items, current => moveItem(current, id, offset))
    }
    const state = paused ? 'paused' : editing !== null ? 'paused while editing' : 'sends after this turn'
    const width = Math.max(20, e.props.bodyColumns - 8)

    return (
      <Box flexDirection="column">
        {steering.length > 0 && (
          <Box key="steering" flexDirection="column">
            {steering.map(one => (
              <Text key={`steered-${one.id}`} color="cyan" wrap="truncate-end">
                {one.status === 'pending' ? '↪ steering' : '✓ read'} · {truncate(one.text, width - 12)}
              </Text>
            ))}
          </Box>
        )}
        {list.length > 0 && (
          <Box flexDirection="row" gap={1}>
            <Text bold>Queue</Text>
            <Text dimColor>
              {list.length} waiting · {state}
            </Text>
            <Button
              key="pause"
              label={paused ? 'Resume' : 'Pause'}
              hotkey="p"
              plain
              dimColor
              onPress={async () => {
                await update($, isPaused, value => !value)
                if (paused) await resumeIfIdle()
              }}
            />
            <Button
              key="clear"
              label="Clear"
              dimColor
              onPress={async () => {
                await update($, editingId, () => null)
                await update($, items, () => [])
                showCount($, 0)
              }}
            />
          </Box>
        )}
        {list.map((item, index) =>
          item.id === editing && Input !== undefined ? (
            <Box key={`editing-${item.id}`} flexDirection="row" gap={1}>
              <Input
                key={`${EDIT}${item.id}`}
                label={`${index + 1}.`}
                value={item.text}
                submitLabel="save"
                autoFocus
                onSubmit={async (value: string) => {
                  const text = value.trim()
                  await update($, items, current =>
                    text === ''
                      ? current.filter(one => one.id !== item.id)
                      : current.map(one => (one.id === item.id ? { ...one, text } : one)),
                  )
                  await update($, editingId, () => null)
                  await resumeIfIdle()
                }}
              />
              <Button
                key={`cancel-${item.id}`}
                label="Cancel"
                dimColor
                onPress={async () => {
                  await update($, editingId, () => null)
                  await resumeIfIdle()
                }}
              />
            </Box>
          ) : (
            <Button
              key={`${ROW}${item.id}`}
              label={truncate(`${index + 1}. ${item.text}`, width)}
              plain
              autoFocus={editing === null && index === list.length - 1 ? true : undefined}
              onPress={() => steer($, item.id)}
            />
          ),
        )}
        {list.length > 0 && editing === null && (
          <Box flexDirection="row" gap={2}>
            <Text dimColor>enter: {e.props.isWorking ? 'steer now' : 'send now'}</Text>
            {Input !== undefined && (
              <Button
                key="edit"
                label="edit"
                hotkey="e"
                plain
                dimColor
                onPress={async () => {
                  const id = await focusedRow()
                  if (id !== undefined) await update($, editingId, () => id)
                }}
              />
            )}
            <Button key="move-up" label="move up" hotkey="k" plain dimColor onPress={() => moveFocused(-1)} />
            <Button key="move-down" label="move down" hotkey="j" plain dimColor onPress={() => moveFocused(1)} />
            <Button
              key="remove"
              label="remove"
              hotkey="x"
              plain
              dimColor
              onPress={async () => {
                const id = await focusedRow()
                if (id !== undefined) await take($, id)
              }}
            />
          </Box>
        )}
      </Box>
    )
  })
}
