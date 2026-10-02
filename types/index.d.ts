export type Foe = { name: string; glyph: string; hp: number; maxHp: number; isBoss?: boolean }

export type Run = {
  floor: number
  level: number
  xp: number
  gil: number
  // Context window remaining, 0-100.
  hp: number
  // Foes slain since the last bonfire (compaction).
  streak: number
  kills: number
  chests: number
  bosses: number
  loot: string[]
  foe: Foe | null
  startedAt: number
  // The party fell to a full context; no further wipes until context frees up.
  isExhausted: boolean
  // Context samples to ignore after a bonfire: they may predate the compaction.
  restSkips: number
}

export type Fame = { floor: number; level: number; kills: number; chests: number; bosses: number; fate: string; at: number }

export type Lifetime = {
  runs: number
  kills: number
  chests: number
  bosses: number
  wipes: number
  bestFloor: number
  bestLevel: number
  fame: Fame[]
}

declare module 'claude-code' {
  interface PluginState {
    'context-dungeon': {
      run: Run | null
      log: string[]
      isPaneOpen: boolean
      isTickerHidden: boolean
      view: 'room' | 'fame'
      lifetime: Lifetime | null
    }
  }
}
