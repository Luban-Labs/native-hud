import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnStepChunk, TurnStepResult } from 'claude-code'

import { estTokens, fmtDur, fmtTokens, hitLevel, parseGit, prettyModel, shortPath } from '../hooks/register'

const BAND = {
  component: 'PromptHint',
  props: { isDraft: false, isWorking: false, hint: 'auto mode on (shift+tab to cycle)' },
  viewport: { columns: 140, rows: 40 },
} as const

const START = { cwd: '/Users/me/code/app', surface: 'terminal', isInteractive: true } as const
const STEP = { turnId: 't1', index: 0, model: 'm', messageCount: 1 } as const

const RESET_5H = new Date(Date.now() + (2 * 60 + 13) * 60_000 + 30_000).toISOString()
const RESET_7D = new Date(Date.now() + (3 * 24 + 4) * 3_600_000 + 30_000).toISOString()

function busy(ms: number) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // the model at work
  }
}

function usageOf(out: number, input: number, read: number, write: number) {
  return { input_tokens: input, output_tokens: out, cache_read_input_tokens: read, cache_creation_input_tokens: write, model: 'm' }
}

function engine(on: On, opts: { git: boolean }) {
  const argvs: (readonly string[])[] = []
  const clock = mock.clock(on, { now: Date.now() })
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))
  on('session.cwd', () => ({ value: '/Users/me/code/app' }))
  on('env.get', () => ({ value: '/Users/me' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 380_000, window: 1_000_000, percent: 38 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 72.5, resetsAt: RESET_5H },
        { kind: 'seven_day', percentUsed: 9, resetsAt: RESET_7D },
      ],
    },
  }))
  on('process.run', (_$, e) => {
    argvs.push(e.argv)
    if (!opts.git) {
      return { value: { exitCode: 128, stdout: '', stderr: 'not a git repo', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const stdout = e.argv.includes('status')
      ? '# branch.oid abc\n# branch.head feat/hud\n# branch.ab +2 -0\n1 .M N... 100644 100644 100644 a b src/x.ts\n? new.ts\n'
      : '/Users/me/code/app/.git/worktrees/hud\n/Users/me/code/app/.git\n/Users/me/code/hud\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { argvs, clock }
}

// The model's side of one step: the chunks a script lays out, then its result.
function model(on: On, script: () => Generator<TurnStepChunk | 'end', void, void>) {
  on('turn.step', async function* (_$, e): AsyncGenerator<TurnStepChunk, TurnStepResult> {
    let usage = null
    for (const c of script()) {
      if (c === 'end') break
      if (c.kind === 'stop') usage = c.usage
      yield c
    }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: usage ? 'end_turn' : null, usage }
  })
}

async function band($: Engine) {
  const ui = await $.ui.mount({ plugin: 'native-hud', surface: 'terminal', ...BAND })
  const all = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')
  await ui.unmount()
  return all
}

async function drain($: Engine) {
  for await (const _ of $.turn.step(STEP)) {
    // the engine consuming the stream
  }
}

describe('helpers', () => {
  test('prettyModel', () => {
    expect(prettyModel('claude-opus-5-5[1m]')).toBe('Opus 5.5 1M')
    expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(prettyModel('sonnet')).toBe('Sonnet')
  })
  test('shortPath / fmt / levels', () => {
    expect(shortPath('/Users/me/a', '/Users/me')).toBe('~/a')
    expect(shortPath('/Users/meow', '/Users/me')).toBe('/Users/meow')
    expect(fmtTokens(1_000_000)).toBe('1M')
    expect(fmtTokens(76_400)).toBe('76k')
    expect(fmtDur((2 * 60 + 5) * 60_000)).toBe('2h05m')
    expect(fmtDur((3 * 24 + 4) * 3_600_000)).toBe('3d4h')
    expect([hitLevel(95), hitLevel(60), hitLevel(10)]).toEqual(['success', 'warning', 'error'])
    expect(estTokens('中文一共六个')).toBe(6)
    expect(estTokens('abcdefgh')).toBe(2)
  })
  test('parseGit: worktree, dirty, ahead', () => {
    const g = parseGit('# branch.head main\n# branch.ab +1 -3\n1 .M x\n', '/r/.git/worktrees/w1\n/r/.git\n/r-w1\n')
    expect(g).toEqual({ branch: 'main', dirty: 1, ahead: 1, behind: 3, worktree: 'r-w1' })
    expect(parseGit('# branch.head main\n', '.git\n.git\n/r\n')?.worktree).toBe(null)
  })
  test('parseGit: a detached HEAD shows its short sha', () => {
    const g = parseGit('# branch.oid abcdef1234567\n# branch.head (detached)\n', '.git\n.git\n/r\n')
    expect(g?.branch).toBe('abcdef1')
  })
})

test('band draws every segment, no separators, on terminal and desktop', async ($, on) => {
  engine(on, { git: true })
  await $.session.start(START)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'native-hud', surface, ...BAND })
    const all = (await ui.findAll({ type: 'Text' })).map(t => t.text).join(' ')
    for (const part of ['Opus 5.5 1M', '~/code/app', '⎇ feat/hud', 'wt:hud', '●2', '38%', '380k/1M', '73%', '↻ 2h13m', '↻ 3d4h', '— tok/s', 'cache —']) {
      expect(all).toContain(part)
    }
    expect(all).not.toContain('│')
    const tree = await ui.drawn()
    const kids = (tree as { children?: readonly unknown[] }).children ?? []
    expect(kids[kids.length - 1]).toEqual({ type: 'engine', ref: 0 })
    await ui.unmount()
  }
})

test('git status never takes optional locks', async ($, on) => {
  const { argvs } = engine(on, { git: true })
  await $.session.start(START)
  const status = argvs.find(a => a.includes('status'))
  expect(status?.slice(0, 3)).toEqual(['git', '--no-optional-locks', 'status'])
})

test('outside git the band says so', async ($, on) => {
  engine(on, { git: false })
  await $.session.start(START)
  expect(await band($)).toContain('no git')
})

test('session.measure pushes new usage into the band', async ($, on) => {
  engine(on, { git: true })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.start(START)
  await $.session.measure({
    context: { tokens: 900_000, window: 1_000_000, percent: 90 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 12, resetsAt: RESET_5H }],
    changed: ['context', 'rateLimits'],
  })
  const all = await band($)
  expect(all).toContain('90%')
  expect(all).toContain('12%')
})

test('turn.step: chunks pass through and output tok/s lands in the band', async ($, on) => {
  engine(on, { git: true })
  model(on, function* () {
    yield { kind: 'text', index: 0, text: 'hello ' }
    busy(500)
    yield { kind: 'text', index: 0, text: 'world' }
    yield { kind: 'stop', stopReason: 'end_turn', usage: usageOf(100, 10, 0, 0) }
  })
  await $.session.start(START)
  const texts: string[] = []
  for await (const c of $.turn.step(STEP)) if (c.kind === 'text') texts.push(c.text)
  expect(texts.join('')).toBe('hello world')
  const all = await band($)
  const tps = Number(all.match(/(\d+) tok\/s/)?.[1])
  expect(tps).toBeGreaterThan(100)
  expect(tps).toBeLessThan(400)
  expect(all).not.toContain('avg')
})

for (const ending of ['interrupted', 'no stop chunk'] as const) {
  test(`a live estimate does not outlive its stream (${ending})`, async ($, on) => {
    engine(on, { git: true })
    model(on, function* () {
      for (let i = 0; i < 60; i += 1) {
        busy(20)
        yield { kind: 'text', index: 0, text: '流式输出' }
      }
      yield 'end'
    })
    await $.session.start(START)
    let n = 0
    for await (const _ of $.turn.step(STEP)) {
      n += 1
      // the hook files chunk 48's estimate as the engine pulls chunk 49
      if (n === 49) {
        expect(await band($)).toMatch(/~\d+ tok\/s/)
        if (ending === 'interrupted') break
      }
    }
    const all = await band($)
    expect(all).not.toMatch(/~\d+ tok\/s/)
    expect(all).toContain('— tok/s')
  })
}

test('cache hit rate of the last request follows the speed', async ($, on) => {
  engine(on, { git: true })
  let step = 0
  model(on, function* () {
    step += 1
    yield { kind: 'text', index: 0, text: 'ok' }
    busy(300)
    yield {
      kind: 'stop',
      stopReason: 'end_turn',
      usage: step === 1 ? usageOf(20, 50, 900, 50) : usageOf(20, 100, 0, 900),
    }
  })
  await $.session.start(START)
  await drain($)
  const first = await band($)
  expect(first).toContain('cache 90%')
  expect(first.indexOf('tok/s')).toBeLessThan(first.indexOf('cache'))
  await drain($)
  const second = await band($)
  expect(second).toContain('cache 0%')
  expect(second).not.toContain('avg')
})

test('a second session.start keeps one tick timer', async ($, on) => {
  const { clock } = engine(on, { git: true })
  let ticks = 0
  on('state.set', (_$, e, next) => {
    if (e.key === 'now') ticks += 1
    return next(e)
  })
  await $.session.start(START)
  await $.session.start(START)
  ticks = 0
  await clock.advance(15_000)
  expect(ticks).toBe(1)
})
