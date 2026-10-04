import { expect, mock, test, type Engine, type Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'

const composer = { kind: 'composer' } as const
const presentation = { isFullscreen: false, columns: 120 }
const band = {
  plugin: 'wait-queue',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const SURFACES = ['terminal', 'desktop'] as const
type Band = Mounted<(typeof SURFACES)[number], 'AbovePrompt'>

// Lets the submit the mod starts without awaiting reach the hooks beneath.
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const turnEnd = (turnId: string, isAborted = false) => ({
  answer: '',
  durationMs: 1,
  isAborted,
  turnId,
  reason: isAborted ? ('aborted' as const) : ('answer' as const),
})

// Stands in for the engine beneath the mod: records what entered and runs turns.
const engine = (on: On) => {
  const entered: string[] = []
  on('prompt.submit', (_$, e) => {
    entered.push(e.text)
    return { text: e.text, origin: e.origin }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  return entered
}

// Records the toasts the mod shows, standing in for the surface beneath it.
const toasts = (on: On) => {
  const shown: string[] = []
  on('ui.toast', (_$, e) => {
    shown.push(e.text)
    return { value: undefined }
  })
  return shown
}

const runQ = ($: Engine, args: string) => $.command.run({ command: 'q', args, origin: composer, presentation })

const rows = async (ui: Band) =>
  (await ui.findAll({ type: 'Button', text: /^\d+\. / })).map(found => found.text)
const rowFor = (ui: Band, text: string) =>
  ui.find({ type: 'Button', text: new RegExp(`^\\d+\\. ${text}$`) })
const focus = ($: Engine, element: string) =>
  $.ui.focus({ component: 'AbovePrompt', requestId: 'band', plugin: 'wait-queue', element, origin: { kind: 'person' } })

const queueDuringTurn = async ($: Engine, ...texts: string[]) => {
  await $.turn.start({ text: 'work', turnId: 't1' })
  for (const text of texts) await runQ($, text)
}

test('a waiting prompt typed mid-turn is held, then sent after the turn', async ($, on) => {
  const entered = engine(on)
  const submitted = await $.prompt.submit({ text: 'later', turnId: 't1', wait: true, origin: composer })
  expect(submitted.drop).toBeDefined()
  expect(entered).toEqual([])

  await $.turn.complete(turnEnd('t1'))
  await settle()
  expect(entered).toEqual(['later'])
})

test('a plain Enter mid-turn passes straight through', async ($, on) => {
  const entered = engine(on)
  await $.prompt.submit({ text: 'now', turnId: 't1', wait: false, origin: composer })
  expect(entered).toEqual(['now'])
})

test('queued prompts go out one per turn, in order', async ($, on) => {
  const entered = engine(on)
  const shown = toasts(on)
  await queueDuringTurn($, 'a', 'b')
  expect(await runQ($, 'c')).toEqual({})
  expect(shown.at(-1)).toBe('Queued: 3 waiting.')

  for (const [turnId, sent] of [['t1', ['a']], ['t2', ['a', 'b']], ['t3', ['a', 'b', 'c']]] as const) {
    if (turnId !== 't1') await $.turn.start({ text: '', turnId })
    await $.turn.complete(turnEnd(turnId))
    await settle()
    expect(entered).toEqual([...sent])
  }
})

test('only one queued prompt goes out until its turn starts', async ($, on) => {
  const entered = engine(on)
  await queueDuringTurn($, 'a', 'b')
  await $.turn.complete(turnEnd('t1'))
  await $.turn.complete(turnEnd('t1'))
  await settle()
  expect(entered).toEqual(['a'])
})

test('a queued prompt the engine refuses goes back to the front, with a toast', async ($, on) => {
  // advance(0) waits for the event loop to settle, which the refusal's round trip needs.
  const clock = mock.clock(on)
  const shown = toasts(on)
  const entered: string[] = []
  on('prompt.submit', (_$, e) => {
    entered.push(e.text)
    return entered.length === 1 ? { drop: 'busy' } : { text: e.text, origin: e.origin }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))

  await queueDuringTurn($, 'a', 'b')
  await $.turn.complete(turnEnd('t1'))
  await clock.advance(0)
  expect(shown.at(-1)).toContain('Not sent (busy)')

  // Back at the front: the next turn's end sends it again, before b.
  await $.turn.start({ text: '', turnId: 't2' })
  await $.turn.complete(turnEnd('t2'))
  await clock.advance(0)
  expect(entered).toEqual(['a', 'a'])
})

test('/q while idle sends the prompt right away', async ($, on) => {
  const clock = mock.clock(on)
  const entered = engine(on)
  const shown = toasts(on)
  expect(await runQ($, 'now please')).toEqual({})
  expect(shown).toEqual(['Sending now.'])
  await clock.advance(0)
  expect(entered).toEqual(['now please'])
})

test('/q with no prompt explains its usage in a toast and queues nothing', async ($, on) => {
  const shown = toasts(on)
  expect(await runQ($, '  ')).toEqual({})
  expect(shown[0]).toContain('Usage: /q <prompt>')
})

test('an interrupted turn pauses the queue, says so, and sends nothing', async ($, on) => {
  const entered = engine(on)
  const shown = toasts(on)
  await queueDuringTurn($, 'held')
  await $.turn.complete(turnEnd('t1', true))
  await settle()
  expect(entered).toEqual([])
  expect(shown.at(-1)).toContain('Queue paused: turn interrupted (1 waiting)')

  const ui = await $.ui.mount({ ...band, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', text: 'Resume' })).toBeDefined()
})

for (const surface of SURFACES) {
  test(`${surface}: /q's echo and output rows draw nothing; other rows are left alone`, async ($, on) => {
    on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: 'engine' }))
    const echo = (text: string) =>
      $.ui.mount({
        plugin: 'wait-queue',
        surface,
        component: 'UserMessage',
        props: { text, origin: composer, isExpanded: false },
      })
    const output = (command: string) =>
      $.ui.mount({
        plugin: 'wait-queue',
        surface,
        component: 'CommandOutput',
        props: { command, args: '1', text: 'out', isErrored: false },
      })

    for (const hidden of [await echo('/q 1'), await echo('/q'), await output('q')]) {
      expect(await hidden.find({ text: 'engine' })).toBeUndefined()
    }
    for (const shown of [await echo('/quit now'), await echo('hello /q'), await output('cost')]) {
      expect(await shown.find({ text: 'engine' })).toBeDefined()
    }
  })


  test(`${surface}: the band leaves the engine's drawing alone with nothing queued`, async ($, on) => {
    engine(on)
    // Stands in for the engine's own band beneath the mod.
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: 'engine' }))
    const ui = await $.ui.mount({ ...band, surface })
    expect(await ui.find({ text: 'engine' })).toBeDefined()
    expect(await ui.find({ text: /waiting/ })).toBeUndefined()
  })

  test(`${surface}: focus starts on the newest row and k / j / x act on the focused one`, async ($, on) => {
    const entered = engine(on)
    on('ui.focus', () => ({}))
    await queueDuringTurn($, 'first', 'second', 'third')
    const ui = await $.ui.mount({ ...band, surface })
    expect(await ui.find({ text: /3 waiting/ })).toBeDefined()
    expect(await rows(ui)).toEqual(['1. first', '2. second', '3. third'])

    const third = (await rowFor(ui, 'third'))!
    expect(third.props.autoFocus).toBe(true)

    // ↑ from the newest row lands on the one before it; k then moves that one up.
    await focus($, (await rowFor(ui, 'second'))!.key!)
    await ui.press({ key: 'move-up' })
    expect(await rows(ui)).toEqual(['1. second', '2. first', '3. third'])
    await ui.press({ key: 'move-down' })
    await ui.press({ key: 'move-down' })
    expect(await rows(ui)).toEqual(['1. first', '2. third', '3. second'])

    await ui.press({ key: 'remove' })
    expect(await rows(ui)).toEqual(['1. first', '2. third'])

    await $.turn.complete(turnEnd('t1'))
    await settle()
    expect(entered).toEqual(['first'])
  })

  test(`${surface}: with nothing focused yet, k / j / x act on the newest row`, async ($, on) => {
    engine(on)
    await queueDuringTurn($, 'first', 'second')
    const ui = await $.ui.mount({ ...band, surface })
    await ui.press({ key: 'remove' })
    expect(await rows(ui)).toEqual(['1. first'])
  })

  test(`${surface}: e edits the focused row, pausing sending until saved`, async ($, on) => {
    const entered = engine(on)
    await queueDuringTurn($, 'draft')
    const ui = await $.ui.mount({ ...band, surface })

    await ui.press({ key: 'edit' })
    expect(await ui.find({ text: /paused while editing/ })).toBeDefined()

    await $.turn.complete(turnEnd('t1'))
    await settle()
    expect(entered).toEqual([])

    const field = (await ui.find({ type: 'Input' }))!
    await ui.input({ key: field.key!, text: 'final words' })
    await settle()
    expect(entered).toEqual(['final words'])
  })

  // This build's test kit does not hand a plugin's $.session.append to a test's
  // hooks, so it is refused here: that checks the refused path. A steer that
  // goes through, and its nudge, are checked in a live session.
  test(`${surface}: a steer the session refuses goes back in the queue, with a toast`, async ($, on) => {
    const entered = engine(on)
    const shown = toasts(on)
    await queueDuringTurn($, 'keep', 'use tabs')
    const ui = await $.ui.mount({ ...band, surface })

    await ui.press({ key: (await rowFor(ui, 'use tabs'))!.key! })
    expect(shown.at(-1)).toContain('Not steered')
    expect(await rows(ui)).toEqual(['1. use tabs', '2. keep'])
    expect(entered).toEqual([])
  })

  test(`${surface}: Enter on a row while idle sends it now`, async ($, on) => {
    const entered = engine(on)
    await queueDuringTurn($, 'go')
    // The turn ends paused, so the row is still there while idle.
    const ui = await $.ui.mount({ ...band, surface })
    await ui.press({ key: 'pause' })
    await $.turn.complete(turnEnd('t1'))
    await settle()

    await ui.press({ key: (await rowFor(ui, 'go'))!.key! })
    await settle()
    expect(entered).toEqual(['go'])
  })

  test(`${surface}: pausing holds the queue across turns until resumed`, async ($, on) => {
    const entered = engine(on)
    await queueDuringTurn($, 'wait for me')
    const ui = await $.ui.mount({ ...band, surface })

    await ui.press({ key: 'pause' })
    await $.turn.complete(turnEnd('t1'))
    await settle()
    expect(entered).toEqual([])

    await ui.press({ key: 'pause' })
    await settle()
    expect(entered).toEqual(['wait for me'])
  })
}
