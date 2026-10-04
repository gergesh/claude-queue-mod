import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const composer = { kind: 'composer' } as const
const presentation = { isFullscreen: false, columns: 120 }
const band = {
  plugin: 'wait-queue',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 100, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const SURFACES = ['terminal', 'desktop'] as const

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

const runQ = ($: Engine, args: string) => $.command.run({ command: 'q', args, origin: composer, presentation })

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
  await queueDuringTurn($, 'a', 'b')
  expect((await runQ($, 'c')).text).toContain('3 waiting')

  for (const [turnId, sent] of [['t1', ['a']], ['t2', ['a', 'b']], ['t3', ['a', 'b', 'c']]] as const) {
    await $.turn.complete(turnEnd(turnId))
    await settle()
    expect(entered).toEqual([...sent])
  }
})

test('/q while idle sends the prompt right away', async ($, on) => {
  const clock = mock.clock(on)
  const entered = engine(on)
  expect((await runQ($, 'now please')).text).toContain('sending now')
  await clock.advance(0)
  expect(entered).toEqual(['now please'])
})

test('/q with no prompt explains its usage', async $ => {
  expect((await runQ($, '  ')).text).toContain('Usage: /q <prompt>')
})

test('an interrupted turn pauses the queue instead of sending it', async ($, on) => {
  const entered = engine(on)
  await queueDuringTurn($, 'held')
  await $.turn.complete(turnEnd('t1', true))
  await settle()
  expect(entered).toEqual([])

  const ui = await $.ui.mount({ ...band, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', text: 'Resume' })).toBeDefined()
})

for (const surface of SURFACES) {
  test(`${surface}: the band leaves the engine's drawing alone with nothing queued`, async ($, on) => {
    engine(on)
    // Stands in for the engine's own band beneath the mod.
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: 'engine' }))
    const ui = await $.ui.mount({ ...band, surface })
    expect(await ui.find({ text: 'engine' })).toBeDefined()
    expect(await ui.find({ text: /waiting/ })).toBeUndefined()
  })

  test(`${surface}: the band lists, reorders and removes queued prompts`, async ($, on) => {
    const entered = engine(on)
    await queueDuringTurn($, 'first', 'second', 'third')
    const ui = await $.ui.mount({ ...band, surface })
    expect(await ui.find({ text: /3 waiting/ })).toBeDefined()

    const rows = async () => (await ui.findAll({ type: 'Text', text: /^(first|second|third)$/ })).map(found => found.text)
    expect(await rows()).toEqual(['first', 'second', 'third'])

    const ups = await ui.findAll({ type: 'Button', text: '↑' })
    await ui.press({ key: ups[2]!.key! })
    expect(await rows()).toEqual(['first', 'third', 'second'])

    const removes = await ui.findAll({ type: 'Button', text: '✕' })
    await ui.press({ key: removes[0]!.key! })
    expect(await rows()).toEqual(['third', 'second'])

    await $.turn.complete(turnEnd('t1'))
    await settle()
    expect(entered).toEqual(['third'])
  })

  test(`${surface}: editing a queued prompt pauses sending and saves the new text`, async ($, on) => {
    const entered = engine(on)
    await queueDuringTurn($, 'draft')
    const ui = await $.ui.mount({ ...band, surface })

    const edit = (await ui.find({ type: 'Button', text: 'Edit' }))!
    await ui.press({ key: edit.key! })
    expect(await ui.find({ text: /paused while editing/ })).toBeDefined()

    await $.turn.complete(turnEnd('t1'))
    await settle()
    expect(entered).toEqual([])

    await ui.input({ key: edit.key!, text: 'final words' })
    await settle()
    expect(entered).toEqual(['final words'])
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
