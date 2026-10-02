import type { On, RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const TICKER = {
  plugin: 'context-dungeon',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} },
} as const

function world(on: On) {
  mock.clock(on, { now: 1000 })
  mock.store(on)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return h(Text, {}, 'engine') as RenderElement
  })
}

const fail = (text: string) => ({ isError: true as const, result: text, text })

test('real tool calls drive the run and are never changed', async ($, on) => {
  world(on)
  let failing = true
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash' && e.command === 'npm test' && failing) return fail('TypeError: nope')
    return { result: {}, text: 'Tests: 3 passed' }
  })
  const first = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(first.isError).toBe(true)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...TICKER, surface })
    expect(await ui.find({ type: 'Text', text: /TypeError/ })).toBeDefined()
    // Other plugins' band still draws beneath the ticker.
    expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
    await ui.unmount()
  }

  failing = false
  const second = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(second.text).toBe('Tests: 3 passed')
  const ui = await $.ui.mount({ ...TICKER, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /TypeError/ })).toBeUndefined()
  await ui.press({ key: 'hide' })
  await ui.unmount()
  const hidden = await $.ui.mount({ ...TICKER, surface: 'terminal' })
  expect(await hidden.find({ key: 'enter' })).toBeUndefined()
  await hidden.unmount()
})

test('searches with no match, background runs and subagents summon nothing', async ($, on) => {
  world(on)
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash' && e.command === 'npm test') return { result: { backgroundTaskId: 'b1' }, text: 'started' }
    if (e.tool === 'Bash' && e.command === 'rg nope') return fail('exit 1')
    return fail('TypeError: sub')
  })
  await $.tool.call({ tool: 'Bash', command: 'rg nope' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'node x.js', agentId: 'sub-1' } as Parameters<typeof $.tool.call>[0])
  const ui = await $.ui.mount({ ...TICKER, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /⚔/ })).toBeUndefined()
  await ui.unmount()
})

test('a PR from git metadata summons the floor boss', async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: { gitOperation: { pr: { action: 'created' } } }, text: 'https://github.com/o/r/pull/1' }))
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  const ui = await $.ui.mount({ ...TICKER, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /⚔/ })).toBeDefined()
  await ui.unmount()
})

test('an amend opens a chest, and an interrupted run summons nothing', async ($, on) => {
  world(on)
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash' && e.command === 'npm test') return fail('Interrupted by user')
    return { result: { gitOperation: { commit: { kind: 'amended' } } }, text: '' }
  })
  await $.tool.call({ tool: 'Bash', command: 'git commit --amend --no-edit' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const ui = await $.ui.mount({ ...TICKER, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /⚔/ })).toBeUndefined()
  await ui.unmount()
})

test('a denied call is ignored and passes through untouched', async ($, on) => {
  world(on)
  on('tool.call', () => ({ deny: 'no' }))
  const ran = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(ran.deny).toBe('no')
  const ui = await $.ui.mount({ ...TICKER, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /⚔/ })).toBeUndefined()
  await ui.unmount()
})
