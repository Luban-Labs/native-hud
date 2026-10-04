import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit, Timer, TurnUsage } from 'claude-code'

import type { HudCache, HudGit, HudInfo, HudLimit, HudSpeed, HudUsage } from '../types'

const info = atom({ plugin: 'native-hud', key: 'info' } as const, {
  model: '',
  path: '',
  git: null,
} as HudInfo)
const usage = atom({ plugin: 'native-hud', key: 'usage' } as const, {
  ctxPercent: null,
  ctxTokens: null,
  ctxWindow: 0,
  fiveHour: null,
  sevenDay: null,
} as HudUsage)
const speed = atom({ plugin: 'native-hud', key: 'speed' } as const, { last: null, live: null } as HudSpeed)
const cache = atom({ plugin: 'native-hud', key: 'cache' } as const, { last: null } as HudCache)
const now = atom({ plugin: 'native-hud', key: 'now' } as const, 0)

const GIT_EVERY_MS = 30_000
const TICK_MS = 15_000
const LIVE_EVERY = 24

// ---------- pure helpers (exported for tests) ----------

export function prettyModel(raw: string): string {
  const is1m = /\[1m\]/i.test(raw)
  let name = raw.replace(/\[[^\]]*\]/g, '').replace(/^claude-/, '')
  const m = name.match(/^(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-|$)/i)
  if (m) {
    const family = m[1]!
    name = family[0]!.toUpperCase() + family.slice(1).toLowerCase() + ' ' + m[2] + (m[3] ? '.' + m[3] : '')
  } else if (/^[a-z]+$/.test(name)) {
    name = name[0]!.toUpperCase() + name.slice(1)
  }
  return is1m ? name + ' 1M' : name
}

export function shortPath(cwd: string, home: string | undefined): string {
  if (home && (cwd === home || cwd.startsWith(home + '/'))) return '~' + cwd.slice(home.length)
  return cwd
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + 'M'
  if (n >= 1000) return Math.round(n / 1000) + 'k'
  return String(n)
}

export function fmtDur(ms: number): string {
  if (ms <= 0) return 'now'
  const min = Math.floor(ms / 60_000)
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const m = min % 60
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  return `${Math.max(m, 1)}m`
}

export function level(pct: number): 'success' | 'warning' | 'error' {
  return pct >= 85 ? 'error' : pct >= 60 ? 'warning' : 'success'
}

export function hitLevel(pct: number): 'success' | 'warning' | 'error' {
  return pct >= 80 ? 'success' : pct >= 50 ? 'warning' : 'error'
}

// Rough tokens in streamed text for the live estimate: CJK about one per character,
// everything else about one per four.
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯＀-￯　-〿]/g
export function estTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0
  return cjk + (text.length - cjk) / 4
}

export function parseGit(status: string, revParse: string): HudGit | null {
  let branch = ''
  let oid = ''
  let ahead = 0
  let behind = 0
  let dirty = 0
  for (const line of status.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice(14).trim()
    else if (line.startsWith('# branch.oid ')) oid = line.slice(13).trim()
    else if (line.startsWith('# branch.ab ')) {
      const ab = line.slice(12).match(/\+(\d+) -(\d+)/)
      if (ab) {
        ahead = Number(ab[1])
        behind = Number(ab[2])
      }
    } else if (line.trim() !== '' && !line.startsWith('#')) dirty += 1
  }
  if (branch === '') return null
  if (branch === '(detached)' && /^[0-9a-f]{7,}$/.test(oid)) branch = oid.slice(0, 7)
  const [gitDir = '', commonDir = '', top = ''] = revParse.split('\n').map(s => s.trim())
  const worktree = gitDir !== '' && commonDir !== '' && gitDir !== commonDir ? top.split('/').pop() || top : null
  return { branch, dirty, ahead, behind, worktree }
}

function toLimit(limits: readonly SessionRateLimit[], kind: string): HudLimit | null {
  const l = limits.find(x => x.kind === kind)
  if (!l) return null
  const t = l.resetsAt ? Date.parse(l.resetsAt) : NaN
  return { percent: l.percentUsed, resetsAt: Number.isNaN(t) ? null : t }
}

export function toUsage(context: SessionContextUsage, limits: readonly SessionRateLimit[]): HudUsage {
  return {
    ctxPercent: context.percent ?? null,
    ctxTokens: context.tokens ?? null,
    ctxWindow: context.window,
    fiveHour: toLimit(limits, 'five_hour'),
    sevenDay: toLimit(limits, 'seven_day'),
  }
}

// ---------- data refresh ----------

async function readGit($: EngineInterface, cwd: string): Promise<HudGit | null> {
  try {
    const [st, rp] = await Promise.all([
      // --no-optional-locks: a read must never take index.lock from the model's own git writes
      $.process.run(['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'], { cwd, timeoutMs: 5000 }),
      $.process.run(['git', 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'], {
        cwd,
        timeoutMs: 5000,
      }),
    ])
    if (st.exitCode !== 0) return null
    return parseGit(st.stdout, rp.exitCode === 0 ? rp.stdout : '')
  } catch {
    return null
  }
}

async function refreshInfo($: EngineInterface): Promise<void> {
  const [model, cwd, home] = await Promise.all([$.session.model(), $.session.cwd(), $.env.get('HOME')])
  const git = await readGit($, cwd)
  const next: HudInfo = { model, path: shortPath(cwd, home), git }
  await update($, info, prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
}

async function refreshUsage($: EngineInterface): Promise<void> {
  const u = await $.session.usage()
  await update($, usage, () => toUsage(u.context, u.rateLimits))
}

async function settleStep($: EngineInterface, u: TurnUsage | null, ms: number): Promise<void> {
  const out = u?.output_tokens ?? 0
  await update($, speed, s => (ms >= 250 && out > 0 ? { last: out / (ms / 1000), live: null } : { ...s, live: null }))
  if (u === null) return
  const read = u.cache_read_input_tokens ?? 0
  const total = (u.input_tokens ?? 0) + read + (u.cache_creation_input_tokens ?? 0)
  if (total > 0) await update($, cache, () => ({ last: (read / total) * 100 }))
}

// ---------- module ----------

export const register: Register = on => {
  let lastGitAt = 0
  let tick: Timer | undefined

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await update($, now, () => Date.now())
    await Promise.all([refreshInfo($), refreshUsage($)])
    lastGitAt = Date.now()
    // session.start can fire again in the same environment: keep one interval.
    tick?.cancel()
    tick = $.clock.every(TICK_MS, () => {
      const t = Date.now()
      void update($, now, () => t)
      if (t - lastGitAt >= GIT_EVERY_MS) {
        lastGitAt = t
        void refreshInfo($)
      }
    })
    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, () => toUsage(e.context, e.rateLimits))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      lastGitAt = Date.now()
      await refreshInfo($)
    }
    return result
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (/\bgit\b|\bcd\b/.test(e.command)) {
      lastGitAt = Date.now()
      void refreshInfo($)
    }
    return ran
  })

  // Token speed and cache hits of each main-loop response. Speed is output tokens
  // over the time from the response's first streamed item to its stop: the first
  // item (the envelope) arrives once the prompt is processed, so time-to-first-token
  // stays out, and thinking the stream does not show stays in. While text streams,
  // a live estimate from what it shows. Chunks pass through untouched.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      yield* next(e)
      return
    }
    let tStart = 0
    let tShown = 0
    let shown = 0
    let pieces = 0
    let isStopped = false
    let isLive = false
    try {
      for await (const chunk of next(e)) {
        const t = Date.now()
        yield chunk
        if (tStart === 0) tStart = t
        if (chunk.kind === 'stop') {
          isStopped = true
          await settleStep($, chunk.usage, t - tStart)
          continue
        }
        const piece = chunk.kind === 'text' || chunk.kind === 'thinking' ? chunk.text : chunk.kind === 'input' ? chunk.json : ''
        if (piece === '') continue
        if (tShown === 0) tShown = t
        shown += estTokens(piece)
        pieces += 1
        if (pieces % LIVE_EVERY === 0 && t - tShown >= 800) {
          const est = shown / ((t - tShown) / 1000)
          isLive = true
          await update($, speed, s => ({ ...s, live: est }))
        }
      }
    } finally {
      // Interrupted (Esc) or ended without a stop: no estimate may outlive its stream.
      if (isLive && !isStopped) await update($, speed, s => ({ ...s, live: null })).catch(() => {})
    }
  })

  // Drawn in the footer under the prompt, where a settings statusLine sits: the HUD
  // rows first, then the engine's own hint line (mode, pills) kept live beneath them.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const engineLine = await next(e)
    const [i, u, s, c, t] = await Promise.all([
      read($, info),
      read($, usage),
      read($, speed),
      read($, cache),
      read($, now),
    ])
    if (i.model === '') return engineLine

    const { Box, Text } = $.ui.resolve(e)
    const cols = e.viewport?.columns ?? 120
    const barW = cols >= 130 ? 10 : cols >= 100 ? 8 : 5
    const clock = t || Date.now()

    const bar = (k: string, pct: number) => {
      const filled = Math.max(0, Math.min(barW, Math.round((pct / 100) * barW)))
      return (
        <Box key={k} flexDirection="row">
          <Text color={level(pct)}>{'━'.repeat(filled)}</Text>
          <Text dimColor>{'━'.repeat(barW - filled)}</Text>
        </Box>
      )
    }

    const limit = (k: string, label: string, l: HudLimit | null) =>
      l === null ? (
        <Box key={k} flexDirection="row" columnGap={1}>
          <Text dimColor>{label}</Text>
          <Text dimColor>—</Text>
        </Box>
      ) : (
        <Box key={k} flexDirection="row" columnGap={1}>
          <Text dimColor>{label}</Text>
          {bar(k + '-bar', l.percent)}
          <Text color={level(l.percent)} bold>
            {Math.round(l.percent)}%
          </Text>
          {l.resetsAt !== null ? <Text dimColor>↻ {fmtDur(l.resetsAt - clock)}</Text> : null}
        </Box>
      )

    const g = i.git
    const gitSeg =
      g === null ? (
        <Text key="git" dimColor>
          no git
        </Text>
      ) : (
        <Box key="git" flexDirection="row" columnGap={1}>
          <Text color="suggestion">⎇ {g.branch}</Text>
          {g.worktree !== null ? <Text color="warning">wt:{g.worktree}</Text> : null}
          {g.dirty > 0 ? <Text color="warning">●{g.dirty}</Text> : <Text color="success">✓</Text>}
          {g.ahead > 0 ? <Text dimColor>↑{g.ahead}</Text> : null}
          {g.behind > 0 ? <Text dimColor>↓{g.behind}</Text> : null}
        </Box>
      )

    const ctxSeg =
      u.ctxPercent === null ? (
        <Box key="ctx" flexDirection="row" columnGap={1}>
          <Text dimColor>ctx</Text>
          <Text dimColor>— / {fmtTokens(u.ctxWindow)}</Text>
        </Box>
      ) : (
        <Box key="ctx" flexDirection="row" columnGap={1}>
          <Text dimColor>ctx</Text>
          {bar('ctx-bar', u.ctxPercent)}
          <Text color={level(u.ctxPercent)} bold>
            {u.ctxPercent}%
          </Text>
          <Text dimColor>
            {fmtTokens(u.ctxTokens ?? 0)}/{fmtTokens(u.ctxWindow)}
          </Text>
        </Box>
      )

    const speedSeg = (
      <Box key="speed" flexDirection="row" columnGap={1}>
        <Text color="claude">⚡</Text>
        {s.live !== null ? (
          <Text color="claude">~{Math.round(s.live)} tok/s</Text>
        ) : s.last !== null ? (
          <Text color="claude" bold>
            {Math.round(s.last)} tok/s
          </Text>
        ) : (
          <Text dimColor>— tok/s</Text>
        )}
      </Box>
    )

    const cacheSeg = (
      <Box key="cache" flexDirection="row" columnGap={1}>
        <Text dimColor>cache</Text>
        {c.last === null ? (
          <Text dimColor>—</Text>
        ) : (
          <Text color={hitLevel(c.last)} bold>
            {Math.round(c.last)}%
          </Text>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
          <Text color="claude" bold>
            ◆ {prettyModel(i.model)}
          </Text>
          <Text color="text" wrap="truncate-middle">
            {i.path}
          </Text>
          {gitSeg}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
          {ctxSeg}
          {limit('5h', '5h', u.fiveHour)}
          {limit('7d', '7d', u.sevenDay)}
          {speedSeg}
          {cacheSeg}
        </Box>
        {engineLine}
      </Box>
    )
  })
}
