import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Fame, Lifetime, Run } from '../types'
import {
  fameOf, freshLifetime, freshRun, hasProgress, isCheckCommand, isExcusedFailure, onBonfire, onBossAppears,
  onCommit, onContext, onEdit, onFailure, onFloorCleared, onPass, onTurn, record, xpToNext,
} from './game'
import type { Step } from './game'

const PANE = 'context-dungeon'
const LIFETIME_KEY = 'lifetime'
const LOG_KEEP = 60

const run = atom({ plugin: 'context-dungeon', key: 'run' } as const, null)
const log = atom({ plugin: 'context-dungeon', key: 'log' } as const, [])
const isPaneOpen = atom({ plugin: 'context-dungeon', key: 'isPaneOpen' } as const, false)
const isTickerHidden = atom({ plugin: 'context-dungeon', key: 'isTickerHidden' } as const, false)
const view = atom({ plugin: 'context-dungeon', key: 'view' } as const, 'room')
const lifetime = atom({ plugin: 'context-dungeon', key: 'lifetime' } as const, null)

type Engine = EngineInterface
type BashOutcome = {
  backgroundTaskId?: string
  gitOperation?: { commit?: { kind?: string }; pr?: { action?: string } }
}

// Every change to the run is computed inside one atomic update, so overlapping
// tool calls each land on the latest run instead of overwriting each other.
// `now` is only needed when a run may start or end; the hot path skips the clock.
async function apply($: Engine, transition: (r: Run) => Step, now = 0) {
  let lines: string[] = []
  let fame: Fame | undefined
  await update($, run, cur => {
    const step = transition(cur ?? freshRun(now))
    lines = step.lines
    fame = step.fame
    return step.run
  })
  if (lines.length > 0) await update($, log, all => [...all, ...lines].slice(-LOG_KEEP))
  if (fame !== undefined) await remember($, fame)
}

// Only a finished run touches the store. Each write re-reads the stored tally so a
// second session's finished runs are added to, not overwritten; writes from this
// session queue one behind another.
let storing: Promise<void> = Promise.resolve()
function remember($: Engine, fame: Fame): Promise<void> {
  storing = storing.then(async () => {
    const stored = ((await $.store.get(LIFETIME_KEY)) as Lifetime | undefined) ?? freshLifetime()
    const life = record(stored, fame)
    await $.store.set(LIFETIME_KEY, life)
    await update($, lifetime, () => life)
  }).catch(() => undefined)
  return storing
}

async function openPane($: Engine) {
  try {
    const opened = await $.ui.open({ id: PANE, title: 'Context Dungeon' })
    await update($, isPaneOpen, () => opened.isPlaced)
    if (!opened.isPlaced) $.ui.toast('Context Dungeon: widen the terminal to enter the dungeon')
  } catch {
    await update($, isPaneOpen, () => false)
  }
}

const bar = (pct: number, width: number) => {
  const full = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width)
  return '█'.repeat(full) + '░'.repeat(width - full)
}
const hpColor = (hp: number) => (hp > 50 ? 'green' : hp > 20 ? 'yellow' : 'red')
const fit = (text: string, room: number) => (text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text)

// The room: walls, the party on the left, the foe (or the stairs) on the right.
function room(r: Run, width: number): { text: string; color?: string; dim?: boolean }[][] {
  const w = Math.max(16, Math.min(width, 44))
  const inner = w - 2
  const party = r.level >= 10 ? '@@@@' : r.level >= 5 ? '@@@' : r.level >= 2 ? '@@' : '@'
  const right = r.foe ? r.foe.glyph : '>'
  const gap = Math.max(1, inner - 2 - party.length - 2 - right.length)
  const wall = [{ text: '#'.repeat(w), dim: true }]
  const empty = [{ text: '#', dim: true }, { text: ' '.repeat(inner) }, { text: '#', dim: true }]
  const middle = [
    { text: '#', dim: true },
    { text: '  ' },
    { text: party, color: 'cyan' },
    { text: ' '.repeat(gap) },
    { text: right, color: r.foe ? 'red' : 'yellow' },
    { text: '  ' },
    { text: '#', dim: true },
  ]
  return [wall, empty, middle, empty, wall]
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'dungeon',
        description: 'Context Dungeon: open the dungeon pane (args: fame, ticker)',
        immediate: true,
      })
      const stored = (await $.store.get(LIFETIME_KEY)) as Lifetime | undefined
      if (stored !== undefined) await update($, lifetime, () => stored)
      const now = await $.clock.now()
      await update($, run, cur => cur ?? freshRun(now))
    } catch {
      // The dungeon is optional; the session is not.
    }
    return next(e)
  })

  on('command.run', { command: 'dungeon' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'ticker') {
      const hidden = await update($, isTickerHidden, was => !was)
      return { text: `Context Dungeon: ticker ${hidden ? 'hidden' : 'shown'}.` }
    }
    await update($, view, () => (arg === 'fame' ? 'fame' : 'room'))
    await openPane($)
    return { text: 'Context Dungeon: you descend into the dungeon.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, isPaneOpen, () => false)
    return next(e)
  })

  // Pure observation: every call runs exactly as it would have; the dungeon only watches.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || e.agentId !== undefined) return ran
    try {
      const seed = e.tool_use_id ?? 'call'
      if (e.tool === 'Bash') {
        const command = String(e.command ?? '')
        // Only a successful result carries Bash's own record; an errored one is just text.
        const result = (ran.isError === true ? {} : (ran.result ?? {})) as BashOutcome
        // A backgrounded command has not finished: it is neither a pass nor a fail yet.
        if (result.backgroundTaskId !== undefined) return ran
        const text = String(ran.text ?? '')
        const failed = ran.isError === true
        const commit = result.gitOperation?.commit?.kind
        const pr = result.gitOperation?.pr?.action
        const isCheck = !failed && isCheckCommand(command)
        const isFoe = failed && !isExcusedFailure(command, text)
        const isChest = commit === 'committed' || commit === 'amended' || commit === 'cherry-picked'
        const isPr = pr === 'created' || pr === 'merged'
        // Nothing for the dungeon: hand the result straight back.
        if (!isCheck && !isFoe && !isChest && !isPr) return ran
        await apply($, r => {
          let step: Step = { run: r, lines: [] }
          const then = (f: (x: Run) => Step) => {
            const s = f(step.run)
            step = { run: s.run, lines: [...step.lines, ...s.lines] }
          }
          if (isChest) then(x => onCommit(x, seed))
          if (pr === 'created') then(x => onBossAppears(x, seed))
          if (pr === 'merged') then(x => onFloorCleared(x, seed))
          if (isCheck) then(x => onPass(x, text, seed))
          if (isFoe) then(x => onFailure(x, text))
          return step
        })
      } else if ((e.tool === 'Edit' || e.tool === 'Write') && ran.isError !== true) {
        const staged = (ran.result as { staged?: boolean } | undefined)?.staged === true
        if (!staged) await apply($, r => onEdit(r, String(e.file_path ?? ''), seed))
      }
    } catch {
      // The dungeon never gets in the way of real work.
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    try {
      const used = (await $.session.usage()).context.percent
      const now = await $.clock.now()
      await apply($, r => {
        const turn = onTurn(r)
        if (used === undefined) return turn
        const after = onContext(turn.run, 100 - used, now)
        return { run: after.run, lines: [...turn.lines, ...after.lines], fame: after.fame }
      }, now)
    } catch {
      // Ignore: usage may be unavailable mid-shutdown.
    }
    return done
  })

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.trigger === 'precompute' || done.messages === undefined) return done
    try {
      await apply($, onBonfire)
    } catch {
      // Ignore.
    }
    return done
  })

  // Leaving the session ends the run with honour: it goes in the hall of fame.
  // /clear scatters the party: the next session's dungeon starts fresh.
  on('session.end', async ($, e, next) => {
    try {
      const r = await read($, run)
      if (r !== null && hasProgress(r)) {
        await remember($, fameOf(r, e.reason === 'clear' ? 'scattered by /clear' : 'retired to the inn', await $.clock.now()))
      }
      await update($, run, () => null)
      await update($, log, () => [])
    } catch {
      // Ignore.
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const r = (await read($, run)) ?? freshRun(0)
    const lines = await read($, log)
    const life = (await read($, lifetime)) ?? freshLifetime()
    const which = await read($, view)
    const cols = Math.max(20, e.props.bodyColumns)
    const rows = e.viewport?.rows ?? 30
    const toggle = (
      <Button
        key="view"
        label={which === 'fame' ? 'room' : 'hall of fame'}
        onPress={() => update($, view, v => (v === 'fame' ? 'room' : 'fame'))}
      />
    )

    if (which === 'fame') {
      return (
        <Box flexDirection="column">
          <Text bold color="yellow">Hall of Fame</Text>
          <Text dimColor>
            {fit(`${life.runs} runs · ${life.kills} foes slain · ${life.bosses} bosses · ${life.wipes} wipes · best floor ${life.bestFloor} · best Lv ${life.bestLevel}`, cols)}
          </Text>
          {life.fame.length === 0 && <Text dimColor>No legends yet. Finish a run to be remembered.</Text>}
          {life.fame.map((f, i) => (
            <Text>{fit(`${i + 1}. Floor ${f.floor} · Lv ${f.level} · ${f.kills} slain · ${f.bosses} bosses · ${f.fate}`, cols)}</Text>
          ))}
          <Box>{toggle}</Box>
        </Box>
      )
    }

    const barWidth = Math.max(8, Math.min(30, cols - 22))
    const logRoom = Math.max(3, rows - 14)
    return (
      <Box flexDirection="column">
        <Text>
          {fit(`Floor ${r.floor} · Lv ${r.level} (${r.xp}/${xpToNext(r.level)} XP) · ${r.gil} gil · streak ${r.streak}`, cols)}
        </Text>
        <Box>
          <Text>HP </Text>
          <Text color={hpColor(r.hp)}>{bar(r.hp, barWidth)}</Text>
          <Text> {r.hp}% context left</Text>
        </Box>
        {room(r, cols).map(row => (
          <Box>
            {row.map(cell => (
              <Text color={cell.color} dimColor={cell.dim}>{cell.text}</Text>
            ))}
          </Box>
        ))}
        {r.foe !== null ? (
          <Box>
            <Text color="red">{r.foe.isBoss === true ? '☠' : '⚔'} {fit(r.foe.name, cols - 24)} </Text>
            <Text color="red">{bar((100 * r.foe.hp) / r.foe.maxHp, 10)}</Text>
            <Text dimColor> {r.foe.hp}/{r.foe.maxHp}</Text>
          </Box>
        ) : (
          <Text dimColor>The room is quiet. Stairs lead down ( &gt; ).</Text>
        )}
        <Text dimColor>{fit(`Loot: ${r.loot.slice(-4).join(', ') || 'nothing yet'}`, cols)}</Text>
        <Text dimColor>{'─'.repeat(Math.min(cols, 44))}</Text>
        {lines.length === 0 && <Text dimColor>Your adventure begins. Run a test, make a commit…</Text>}
        {lines.slice(-logRoom).map(line => (
          <Text>{fit(line, cols)}</Text>
        ))}
        <Box>{toggle}</Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isPaneOpen)) || (await read($, isTickerHidden))) return next(e)
    const r = await read($, run)
    if (r === null) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const cols = e.props.bodyColumns ?? 80
    const foe = r.foe !== null ? ` · ⚔ ${r.foe.name}` : ''
    // The band is shared: draw our line above whatever the other plugins draw.
    const below = await next(e)
    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>Lv{r.level} F{r.floor} HP </Text>
          <Text color={hpColor(r.hp)}>{bar(r.hp, 10)}</Text>
          <Text dimColor>{fit(` ${r.hp}%${foe} `, Math.max(10, cols - 40))}</Text>
          <Button key="enter" label="enter" onPress={() => openPane($)} />
          <Button key="hide" label="×" plain onPress={() => update($, isTickerHidden, () => true)} />
        </Box>
        {below}
      </Box>
    )
  })
}
