export type HudGit = {
  branch: string
  dirty: number
  ahead: number
  behind: number
  worktree: string | null
}

export type HudInfo = { model: string; path: string; git: HudGit | null }

export type HudLimit = { percent: number; resetsAt: number | null }

export type HudUsage = {
  ctxPercent: number | null
  ctxTokens: number | null
  ctxWindow: number
  fiveHour: HudLimit | null
  sevenDay: HudLimit | null
}

export type HudSpeed = { last: number | null; live: number | null }

export type HudCache = { last: number | null }

declare module 'claude-code' {
  interface PluginState {
    'native-hud': {
      info: HudInfo
      usage: HudUsage
      speed: HudSpeed
      cache: HudCache
      now: number
    }
  }
}
