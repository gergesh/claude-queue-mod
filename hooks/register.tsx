import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { QueueItem } from '../types'

// The engine delivers a prompt typed mid-turn into that turn even when the
// person asked it to wait (`e.wait`, chat:queueSubmit). This mod holds such
// prompts, and those given to `/q <prompt>`, sends them one per turn once the
// session is idle, and lists them in a band above the prompt to edit, reorder,
// remove or pause.

const items = atom({ plugin: 'wait-queue', key: 'items' } as const, [])
const editingId = atom({ plugin: 'wait-queue', key: 'editingId' } as const, null)
const isPaused = atom({ plugin: 'wait-queue', key: 'isPaused' } as const, false)

function moveItem(list: QueueItem[], id: string, offset: -1 | 1): QueueItem[] {
  const from = list.findIndex(item => item.id === id)
  const item = list[from]
  const to = from + offset
  if (item === undefined || to < 0 || to >= list.length) return list
  const rest = list.filter(other => other.id !== id)
  return [...rest.slice(0, to), item, ...rest.slice(to)]
}

async function enqueue($: EngineInterface, text: string): Promise<number> {
  const item: QueueItem = { id: crypto.randomUUID(), text }
  const next = await update($, items, list => [...list, item])
  $.ui.status(`${next.length} queued`)
  return next.length
}

// Sends the head of the queue as the person's own prompt, unless the queue is
// paused or a prompt in it is being edited.
async function sendNext($: EngineInterface) {
  if ((await read($, isPaused)) || (await read($, editingId)) !== null) return
  const [first] = await read($, items)
  if (first === undefined) return

  const rest = await update($, items, list => list.filter(item => item.id !== first.id))
  $.ui.status(rest.length === 0 ? undefined : `${rest.length} queued`)
  // Not awaited: the submitted prompt runs as its own turn once the session is idle.
  void $.prompt.submit({ text: first.text, asUser: true })
}

export const register: Register = on => {
  let runningTurnId: string | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'q',
      description: 'Queue a prompt to send after the current turn ends',
      argumentHint: '<prompt>',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'q' }, async ($, e) => {
    const text = e.args.trim()
    if (text === '') return { text: 'Usage: /q <prompt>. ctrl+x tab manages the queue above the prompt.' }

    const count = await enqueue($, text)
    if (runningTurnId === undefined) {
      // A submit can't start inside this hook (it would wait on the command's own
      // dispatch), so it goes out on the clock's next tick, once the command is done.
      $.clock.after(0, () => void sendNext($))
      return { text: 'Queued; sending now.' }
    }
    return { text: `Queued until this turn ends (${count} waiting).` }
  })

  on('prompt.submit', async ($, e, next) => {
    const isWaitingRequest =
      e.wait && e.turnId !== undefined && e.origin.kind === 'composer' && e.attachments === undefined
    if (!isWaitingRequest) return next(e)

    const count = await enqueue($, e.text)
    return { drop: `Queued until this turn ends (${count} waiting).` }
  })

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    runningTurnId = result.turnId
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    if (e.turnId === runningTurnId) runningTurnId = undefined

    if (e.isAborted) {
      // An interrupted turn pauses the queue; the person resumes or edits it in the band.
      if ((await read($, items)).length > 0) await update($, isPaused, () => true)
      return result
    }

    await sendNext($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, items)
    if (e.props.hasSurvey || list.length === 0) return next(e)

    const paused = await read($, isPaused)
    const editing = await read($, editingId)
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // A surface without text fields lists, reorders and removes, but does not edit.
    const Input = 'Input' in elements ? elements.Input : undefined

    // Sending resumes on its own at the next turn's end; while idle it is nudged here.
    const resumeIfIdle = () => {
      if (runningTurnId === undefined) void sendNext($)
    }
    const state = paused ? 'paused' : editing !== null ? 'paused while editing' : 'sends after this turn'

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold>Queue</Text>
          <Text dimColor>
            {list.length} waiting · {state} · ctrl+x tab to manage
          </Text>
          <Button
            key="pause"
            label={paused ? 'Resume' : 'Pause'}
            dimColor
            onPress={async () => {
              await update($, isPaused, value => !value)
              if (paused) resumeIfIdle()
            }}
          />
          <Button
            key="clear"
            label="Clear"
            dimColor
            onPress={async () => {
              await update($, editingId, () => null)
              await update($, items, () => [])
              $.ui.status(undefined)
            }}
          />
        </Box>
        {list.map((item, index) =>
          item.id === editing && Input !== undefined ? (
            <Box key={`row-${item.id}`} flexDirection="row" gap={1}>
              <Input
                key={`edit-${item.id}`}
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
                  resumeIfIdle()
                }}
              />
              <Button
                key={`cancel-${item.id}`}
                label="Cancel"
                dimColor
                onPress={async () => {
                  await update($, editingId, () => null)
                  resumeIfIdle()
                }}
              />
            </Box>
          ) : (
            <Box key={`row-${item.id}`} flexDirection="row" gap={1}>
              <Text dimColor>{index + 1}.</Text>
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-end">{item.text}</Text>
              </Box>
              {Input !== undefined && (
                <Button
                  key={`edit-${item.id}`}
                  label="Edit"
                  dimColor
                  onPress={() => update($, editingId, () => item.id)}
                />
              )}
              <Button
                key={`up-${item.id}`}
                label="↑"
                dimColor
                onPress={() => update($, items, current => moveItem(current, item.id, -1))}
              />
              <Button
                key={`down-${item.id}`}
                label="↓"
                dimColor
                onPress={() => update($, items, current => moveItem(current, item.id, 1))}
              />
              <Button
                key={`remove-${item.id}`}
                label="✕"
                dimColor
                onPress={async () => {
                  const rest = await update($, items, current => current.filter(one => one.id !== item.id))
                  $.ui.status(rest.length === 0 ? undefined : `${rest.length} queued`)
                }}
              />
            </Box>
          ),
        )}
      </Box>
    )
  })
}
