// The rules of the dungeon: pure functions from a run and an event to the next run
// and the battle-log lines it earned. No `$` here, so the rules test on their own.
import type { Fame, Foe, Lifetime, Run } from '../types'

export type Step = { run: Run; lines: string[]; fame?: Fame }

const CREATURES = ['Wraith', 'Imp', 'Golem', 'Drake', 'Lich', 'Tonberry', 'Behemoth', 'Malboro', 'Cactuar', 'Ghoul', 'Wyvern', 'Mimic']
const GLYPHS: Record<string, string> = {
  Wraith: 'W', Imp: 'i', Golem: 'G', Drake: 'D', Lich: 'L', Tonberry: 't',
  Behemoth: 'B', Malboro: 'M', Cactuar: 'c', Ghoul: 'g', Wyvern: 'V', Mimic: 'm',
}
const BOSSES = ['Review Behemoth', 'CI Ultima Weapon', 'Merge Conflict Malboro', 'Gatekeeper Margit', 'Ragnaros of the Main Branch']
const LOOT = [
  'Potion', 'Hi-Potion', 'Ether', 'Phoenix Down', 'Elixir', 'Megalixir', 'Ribbon', 'Genji Glove',
  'Flask of Crimson Tears', 'Golden Rune', 'Smithing Stone', 'Hearthstone', 'Thunderfury (shard)',
  'Mythril Sword', 'Masamune', 'Ultima Weapon', 'Rusty Key', 'Stale Bread',
]
const HEROES = ['Cloud', 'Tifa', 'Squall', 'Zidane', 'Terra', 'Ramza', 'the Tarnished']

export const XP_PER_TURN = 5
export const xpToNext = (level: number) => level * 20
// At or below this much context left (percent) the party falls.
export const WIPE_AT = 2
// A foe stops growing here, however many errors it eats.
export const MAX_FOE_HP = 12
// Context samples ignored after a compaction, until a fresh response reports.
export const REST_SKIPS = 1

export const freshRun = (now: number, hp = 100): Run => ({
  floor: 1, level: 1, xp: 0, gil: 0, hp, streak: 0, kills: 0, chests: 0, bosses: 0,
  loot: [], foe: null, startedAt: now, isExhausted: false, restSkips: 0,
})

export const freshLifetime = (): Lifetime => ({
  runs: 0, kills: 0, chests: 0, bosses: 0, wipes: 0, bestFloor: 1, bestLevel: 1, fame: [],
})

// Whether a run did anything worth remembering. Passive turn XP is not an adventure.
export const hasProgress = (r: Run) => r.kills > 0 || r.chests > 0 || r.bosses > 0 || r.floor > 1 || r.foe?.isBoss === true

// A small stable hash, so the same error always summons the same creature.
export function pick<T>(list: readonly T[], seed: string): T {
  let h = 2166136261
  for (let i = 0; i < seed.length; i += 1) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  return list[(h >>> 0) % list.length] as T
}

// The monster's first name comes from the error itself, never from the command
// (a command line can carry tokens and passwords).
export function errorKind(text: string): string {
  const named = /\b([A-Z][A-Za-z]*(?:Error|Exception))\b/.exec(text)
  if (named) return named[1] as string
  const code = /\b(E[A-Z]{3,}[A-Z0-9]*)\b/.exec(text)
  if (code) return code[1] as string
  if (/\b(fail(ed|ing|ures?)?)\b/i.test(text)) return 'Red Test'
  if (/command not found/i.test(text)) return 'Missing Binary'
  const exit = /exit (?:code )?(\d+)/i.exec(text)
  if (exit) return `Exit ${exit[1]}`
  return 'Nameless'
}

export function summon(kind: string, floor: number, seed: string): Foe {
  const creature = pick(CREATURES, seed)
  const maxHp = 2 + Math.min(floor, 4)
  return { name: `${kind} ${creature}`, glyph: GLYPHS[creature] ?? '?', hp: maxHp, maxHp }
}

const hero = (run: Run, seed: string) => (run.level >= 10 ? 'the party' : pick(HEROES, seed))

function gainXp(run: Run, xp: number, lines: string[]): Run {
  let next = { ...run, xp: run.xp + xp }
  while (next.xp >= xpToNext(next.level)) {
    next = { ...next, xp: next.xp - xpToNext(next.level), level: next.level + 1 }
    lines.push(`★ Level up! The party reaches Lv ${next.level}.`)
  }
  return next
}

// A tool call failed: a monster appears, or the one already here grows stronger.
export function onFailure(run: Run, text: string): Step {
  const lines: string[] = []
  const kind = errorKind(text)
  if (run.foe === null) {
    const foe = summon(kind, run.floor, `${kind}:${run.kills}`)
    lines.push(`! A wild ${foe.name} appears!`)
    return { run: { ...run, foe }, lines }
  }
  if (run.foe.maxHp >= MAX_FOE_HP) {
    lines.push(`! ${run.foe.name} shrugs off the ${kind}.`)
    return { run, lines }
  }
  const foe = { ...run.foe, maxHp: run.foe.maxHp + 1, hp: run.foe.hp + 1 }
  lines.push(`! ${foe.name} feeds on the ${kind}. It grows stronger.`)
  return { run: { ...run, foe }, lines }
}

// Output that still reports failures, even from a zero exit: a runner's summary
// with a failure count, a FAIL/FAILED line, or a failed-test mark. Test titles
// that merely mention failures do not count.
const ANSI = /\x1b\[[0-9;]*m/g
export function reportsFailures(raw: string): boolean {
  const text = raw.replace(ANSI, '')
  if (/^\s*(FAIL(ED)?\b|--- FAIL)/m.test(text)) return true
  if (/^\s*[✕✗×] /m.test(text)) return true
  if (/^\s*[1-9]\d* failing\b/m.test(text)) return true
  if (/^FAILED \((failures|errors)=\d+/m.test(text)) return true
  return text.split('\n').some(line => {
    if (!/\b[1-9]\d* (failed|failures?|errors?)\b/i.test(line)) return false
    return /^\s*(Tests?|Test Suites|Test Files|Examples?|Specs?):/i.test(line) || /\b\d+ passed\b/.test(line) || /={3,}/.test(line)
  })
}

// A check passed. A clean run is a finishing blow on a common foe; a boss takes two hits.
export function onPass(run: Run, text: string, seed: string): Step {
  const lines: string[] = []
  const isClean = !reportsFailures(text)
  if (run.foe === null) {
    if (!isClean) return { run, lines: [`… The checks report failures. Something stirs in the dark.`] }
    const next = gainXp(run, 2, lines)
    lines.unshift(`✓ ${hero(run, seed)} keeps watch. The checks are green.`)
    return { run: next, lines }
  }
  // A boss already held at 1 HP waits for the merge; another green run changes nothing.
  if (run.foe.isBoss === true && run.foe.hp <= 1) return { run, lines }
  const damage = !isClean ? 1 : run.foe.isBoss === true ? Math.ceil(run.foe.maxHp / 2) : run.foe.hp
  const foe = { ...run.foe, hp: run.foe.hp - damage }
  if (foe.hp > 0) {
    lines.push(`⚔ ${hero(run, seed)} attacks! ${damage} damage to ${foe.name}.`)
    return { run: { ...run, foe }, lines }
  }
  if (foe.isBoss === true) {
    lines.push(`⚔ ${foe.name} reels, but a boss falls only when the PR is merged.`)
    return { run: { ...run, foe: { ...foe, hp: 1 } }, lines }
  }
  const drop = pick(LOOT, `${seed}:${run.kills}`)
  lines.push(isClean ? `✦ LIMIT BREAK! ${hero(run, seed)} slays ${foe.name}!` : `⚔ ${foe.name} falls.`)
  lines.push(`  It drops: ${drop}.`)
  let next: Run = {
    ...run, foe: null, kills: run.kills + 1, streak: run.streak + 1,
    loot: [...run.loot, drop].slice(-12), gil: run.gil + 10 * run.floor,
  }
  next = gainXp(next, 5 + foe.maxHp * 2, lines)
  return { run: next, lines }
}

export function onCommit(run: Run, seed: string): Step {
  const lines: string[] = []
  const drop = pick(LOOT, `chest:${seed}:${run.chests}`)
  const gil = 25 * run.floor
  lines.push(`▣ A treasure chest! Inside: ${drop} and ${gil} gil.`)
  const next = gainXp({ ...run, chests: run.chests + 1, gil: run.gil + gil, loot: [...run.loot, drop].slice(-12) }, 8, lines)
  return { run: next, lines }
}

// A pull request opened: the floor boss steps out. A lesser foe flees before it.
export function onBossAppears(run: Run, seed: string): Step {
  if (run.foe?.isBoss === true) return { run, lines: [`☠ ${run.foe.name} already blocks the stairs.`] }
  const name = pick(BOSSES, `${seed}:${run.floor}`)
  const maxHp = 6 + 2 * Math.min(run.floor, 5)
  const lines = [`☠ FLOOR BOSS: ${name}! The pull request is raised.`]
  if (run.foe !== null) lines.push(`  ${run.foe.name} flees before it.`)
  return { run: { ...run, foe: { name, glyph: 'Ω', hp: maxHp, maxHp, isBoss: true } }, lines }
}

// A pull request merged: the floor is cleared and the stairs open.
export function onFloorCleared(run: Run, seed: string): Step {
  const lines: string[] = []
  const name = run.foe?.isBoss === true ? run.foe.name : pick(BOSSES, `${seed}:${run.floor}`)
  lines.push(`☠ The PR is merged. ${name} is vanquished!`)
  lines.push(`  The stairs open. Floor ${run.floor + 1}.`)
  const next = gainXp(
    { ...run, bosses: run.bosses + 1, floor: run.floor + 1, foe: null, gil: run.gil + 100 * run.floor },
    25 * run.floor,
    lines,
  )
  return { run: next, lines }
}

export function onEdit(run: Run, file: string, seed: string): Step {
  const lines: string[] = []
  const name = file.split('/').pop() ?? file
  const spell = pick(['Refactor', 'Haste', 'Protect', 'Cure', 'Libra', 'Scan', 'Esuna'], seed)
  lines.push(`✧ ${hero(run, seed)} casts ${spell} on ${name}.`)
  return { run: gainXp(run, 1, lines), lines }
}

// Context changed: HP follows it. The first time it runs out the party falls; a
// new party starts at the real HP left and cannot fall again until context frees up.
export function onContext(run: Run, remaining: number, now: number): Step {
  const left = Math.max(0, Math.min(100, remaining))
  const hp = Math.round(left)
  // Right after a bonfire the reading may predate the compaction: never wipe on it.
  if (run.restSkips > 0) return { run: { ...run, restSkips: run.restSkips - 1 }, lines: [] }
  if (left > WIPE_AT) return { run: { ...run, hp, isExhausted: false }, lines: [] }
  if (run.isExhausted) return { run: { ...run, hp }, lines: [] }
  return {
    run: { ...freshRun(now, hp), isExhausted: true },
    lines: [`✝ The party has fallen on floor ${run.floor}. Context exhausted.`, `  A new party gathers at the entrance.`],
    // Like leaving, a wipe joins the hall of fame only if the run did something.
    fame: hasProgress(run) ? fameOf(run, 'wiped out (context exhausted)', now) : undefined,
  }
}

export function onTurn(run: Run): Step {
  const lines: string[] = []
  return { run: gainXp(run, XP_PER_TURN, lines), lines }
}

// A compaction is a rest at a bonfire: HP restored, but the streak is spent.
export function onBonfire(run: Run): Step {
  const lines = [`🔥 The party rests at a bonfire. HP restored.`]
  if (run.streak > 0) lines.push(`  The ${run.streak}-kill streak fades into the embers.`)
  return { run: { ...run, hp: 100, streak: 0, isExhausted: false, restSkips: REST_SKIPS }, lines }
}

export function fameOf(run: Run, fate: string, now: number): Fame {
  return { floor: run.floor, level: run.level, kills: run.kills, chests: run.chests, bosses: run.bosses, fate, at: now }
}

// A finished run joins the lifetime tally and, if it ranks, the hall of fame.
export function record(life: Lifetime, fame: Fame): Lifetime {
  const ranked = [...life.fame, fame].sort((a, b) => b.floor - a.floor || b.level - a.level || b.kills - a.kills).slice(0, 5)
  return {
    runs: life.runs + 1,
    kills: life.kills + fame.kills,
    chests: life.chests + fame.chests,
    bosses: life.bosses + fame.bosses,
    wipes: life.wipes + (fame.fate.startsWith('wiped') ? 1 : 0),
    bestFloor: Math.max(life.bestFloor, fame.floor),
    bestLevel: Math.max(life.bestLevel, fame.level),
    fame: ranked,
  }
}

// The lifetime tally: an old single-key tally (if any) plus every run stored under
// its own key. Each session only ever adds keys, so two sessions ending together
// cannot overwrite each other's runs. Runs are folded oldest first.
export function tally(base: Lifetime | undefined, runs: readonly Fame[]): Lifetime {
  return [...runs].sort((a, b) => a.at - b.at || a.fate.localeCompare(b.fate)).reduce(record, base ?? freshLifetime())
}

// --- Reading shell lines -------------------------------------------------------
// Exit status belongs to whichever command ran last, which only a shell knows for
// a compound line. So the dungeon judges single commands only: a line with
// `&&`, `||`, `;` or `|` outside quotes never attacks and is never excused.

type Parsed = { words: string[]; isCompound: boolean }

// Splits into words, honouring quotes and comments, and notes any operator that
// joins commands: `&&`, `||`, `;`, `|`, a background `&`, command substitution,
// or a second line. Redirections (`2>&1`, `&>`, `>`) stay part of the command.
export function parse(raw: string): Parsed {
  // `cd dir && cmd` is one command run somewhere else.
  const cd = /^\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*&&\s*/.exec(raw)
  const command = cd !== null && !/\$\(|`/.test(cd[1] as string) ? raw.slice(cd[0].length) : raw
  const words: string[] = []
  let word = ''
  let quote: string | null = null
  let isCompound = false
  let hasWord = false
  let pendingLine = false
  const end = () => {
    if (hasWord) words.push(word)
    word = ''
    hasWord = false
  }
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] as string
    if (quote !== null) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < command.length) word += command[(i += 1)]
      else {
        // Inside double quotes a substitution still runs another command.
        if (quote === '"' && (ch === '`' || (ch === '$' && command[i + 1] === '('))) isCompound = true
        word += ch
      }
      continue
    }
    if (pendingLine && !/\s/.test(ch)) {
      isCompound = true
      pendingLine = false
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      hasWord = true
    } else if (ch === '\\' && i + 1 < command.length) {
      if (command[i + 1] !== '\n') word += command[i + 1]
      i += 1
      hasWord = hasWord || command[i] !== '\n'
    } else if (ch === '#' && !hasWord) {
      while (i + 1 < command.length && command[i + 1] !== '\n') i += 1
    } else if (ch === '\n') {
      end()
      if (words.length > 0) pendingLine = true
    } else if (/\s/.test(ch)) {
      end()
    } else if (ch === '&') {
      const prev = command[i - 1]
      const next = command[i + 1]
      if (prev === '>' || next === '>') {
        word += ch
        hasWord = true
      } else {
        isCompound = true
        if (next === '&') i += 1
        end()
      }
    } else if (ch === ';' || ch === '|' || ch === '`' || (ch === '$' && command[i + 1] === '(')) {
      isCompound = true
      end()
    } else {
      word += ch
      hasWord = true
    }
  }
  end()
  // Drop redirections and their targets: `> out.txt`, `2>&1`, `&>log`, `< in`.
  const kept: string[] = []
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] as string
    if (/^(\d*(>>?|<)|&>>?)$/.test(w)) i += 1
    else if (!/^(\d*[<>]|&>)/.test(w)) kept.push(w)
  }
  return { words: kept, isCompound }
}

// Wrappers and the flags they take, peeled off to find the real executable.
const WRAPPERS = new Set(['npx', 'bunx', 'pnpx', 'time', 'sudo', 'env', 'nice', 'exec', 'nohup'])
const VALUED = new Set(['-n', '-u', '-g', '-C', '--prefix', '--filter', '-F', '--workspace', '--dir', '--cwd', '--package', '--cache', '-f', '--file', '--manifest-path', '-Z', '--directory'])
const LAUNCHERS: Record<string, string> = { uv: 'run', poetry: 'run', pipenv: 'run', rye: 'run', hatch: 'run', pdm: 'run', bundle: 'exec' }

function skipFlags(words: string[], from: number): number {
  let i = from
  while (i < words.length && (words[i] as string).startsWith('-')) {
    i += VALUED.has(words[i] as string) ? 2 : 1
  }
  return i
}

export function invocation(words: readonly string[]): { exe: string; args: string[] } {
  const w = [...words]
  let i = 0
  for (;;) {
    while (i < w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i] as string)) i += 1
    const head = w[i]
    if (head === undefined) break
    if (WRAPPERS.has(head)) {
      i = skipFlags(w, i + 1)
      continue
    }
    if ((head === 'pnpm' || head === 'yarn' || head === 'bun' || head === 'npm') && w[skipFlags(w, i + 1)] === 'exec') {
      i = skipFlags(w, skipFlags(w, i + 1) + 1)
      continue
    }
    // Launchers that run another program: `uv run pytest`, `bundle exec rspec`.
    const launched = LAUNCHERS[head]
    if (launched !== undefined && w[skipFlags(w, i + 1)] === launched) {
      i = skipFlags(w, skipFlags(w, i + 1) + 1)
      continue
    }
    break
  }
  const exe = (w[i] ?? '').split('/').pop() ?? ''
  return { exe, args: w.slice(i + 1) }
}

// Flags that make a runner print, list or watch instead of running checks once.
const NOT_A_RUN: Record<string, RegExp> = {
  jest: /^(--listTests|--showConfig|--watch|--watchAll|--init)$/,
  vitest: /^(--watch|-w|list|init|watch|dev)$/,
  mocha: /^(--watch|-w)$/,
  pytest: /^(--collect-only|--co|--fixtures|--markers)$/,
  rspec: /^(--dry-run|--init)$/,
  phpunit: /^(--list-tests|--list-suites)$/,
  tsc: /^(-v|--showConfig|--init|--watch|-w|--listFilesOnly)$/,
  eslint: /^(--fix|--fix-dry-run|--init|--print-config|--inspect-config)$/,
  mypy: /^(--install-types)$/,
  pyright: /^(--watch|-w|--createstub)$/,
}
const RUNNERS = new Set(Object.keys(NOT_A_RUN))

// The subcommand after global flags, toolchain selectors (`+nightly`) and make variables.
function subcommand(args: string[]): { sub: string | undefined; rest: string[] } {
  let i = 0
  while (i < args.length) {
    const a = args[i] as string
    if (a.startsWith('+') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) i += 1
    else if (a.startsWith('-')) i += VALUED.has(a) ? 2 : 1
    else break
  }
  return { sub: args[i], rest: args.slice(i + 1) }
}

// After `--`, `-w` is a watch flag unless a number follows it (Jest's `-w 2` is workers).
// `--watch` / `--watchAll`, alone or with a value that turns it on (`--watch=false` runs once).
const isWatchOn = (a: string) => /^(--watch|--watchAll)(=(?!(false|0|off|no)$).*)?$/i.test(a)
// Flags forwarded after `--` that make the runner list or dry-run instead of running.
const FORWARDED_NOT_A_RUN = /^(--listTests|--list-tests|--list|--collect-only|--co|--dry-run|--showConfig)$/

function passesWatch(args: string[]): boolean {
  const at = args.indexOf('--')
  if (at === -1) return false
  const extra = args.slice(at + 1)
  return extra.some((a, i) => isWatchOn(a) || FORWARDED_NOT_A_RUN.test(a) || (a === '-w' && !/^\d+$/.test(extra[i + 1] ?? '')))
}

function isCheckInvocation(exe: string, args: string[]): boolean {
  if (args.some(a => /^(--version|--help|-h)$/.test(a))) return false
  // Watching never finishes a run, wherever the flag sits.
  if (args.some(isWatchOn) || passesWatch(args)) return false
  if (RUNNERS.has(exe)) return !args.some(a => (NOT_A_RUN[exe] as RegExp).test(a))
  if (exe === 'ruff') return args[0] === 'check' && !args.includes('--fix')
  if (exe === 'biome') return ['check', 'lint', 'ci'].includes(args[0] ?? '') && !args.includes('--write')
  if (exe === 'ktlint') return !args.some(a => a === '-F' || a === '--format')
  if (exe === 'swiftlint') return !['autocorrect', 'version', 'rules'].includes(args[0] ?? '') && !args.includes('--fix')
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(exe)) {
    const { sub, rest } = subcommand(args)
    const task = sub === 'run' || sub === 'run-script' ? subcommand(rest).sub : sub
    return /^(test|tests|typecheck|type-check|tsc|lint|check)(:[\w-]+)?$/.test(task ?? '')
  }
  if (['go', 'cargo', 'swift', 'dotnet', 'deno'].includes(exe)) {
    const { sub, rest } = subcommand(args)
    // Compile-only and list-only modes print names and exit 0 without running anything.
    const listing = rest.some(a => /^(--list|--list-tests|-list(=.*)?|--no-run)$/.test(a) || (exe === 'dotnet' && a === '-t'))
    return sub === 'test' && !(exe === 'go' && rest.includes('-c')) && !listing
  }
  if (exe === 'node') return args.includes('--test') || (args[0] === '--run' && /^(test|tests|lint|typecheck)(:[\w-]+)?$/.test(args[1] ?? ''))
  if (/^python(\d+(\.\d+)?)?$/.test(exe)) {
    if (args[0] !== '-m') return false
    if (args[1] === 'unittest') return true
    return (args[1] === 'pytest' || args[1] === 'mypy') && isCheckInvocation(args[1], args.slice(2))
  }
  if (exe === 'xcodebuild') return args.includes('test') || args.includes('test-without-building')
  if (exe === 'gradle' || exe === 'gradlew') return !args.some(a => a === '--dry-run' || a === '-m') && args.some(a => /^(.*:)?(test|check|lint)([A-Z]\w*)?$/.test(a) && !/Classes$/.test(a))
  if (exe === 'make') {
    // -n / --dry-run / --just-print / --recon print the recipe without running it.
    // A short-option cluster (`-sn`, `-nk`) dry-runs too.
    if (args.some(a => /^(--dry-run|--just-print|--recon|--question)$/.test(a) || /^-[a-zA-Z]*[nq][a-zA-Z]*$/.test(a))) return false
    return /^(test|check|lint)$/.test(subcommand(args).sub ?? '')
  }
  return false
}

// Commands whose non-zero exit is an answer (no match, files differ, false), not an error.
const PREDICATES = new Set(['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'fd', 'diff', 'cmp', 'test', '[', '[[', 'which', 'type', 'pgrep', 'false'])
// A predicate that printed one of these hit a real error, not a negative answer.
// Only the tools' own diagnostic lines count; diff hunks and matches are content.
const DIAGNOSTIC = /^(fatal:|error:|usage:|(rg|grep|egrep|fgrep|diff|cmp|fd|jq|test|\[|which|pgrep)(: | error)|regex parse error)|integer expression expected|unary operator expected|No such file or directory|Permission denied|command not found|: not found$/i
// Diff and match lines are content. A leading space is a diff context line only
// when the output is a diff; otherwise it is an indented diagnostic.
const isDiff = (text: string) => /^(diff --git |@@ |--- |\+\+\+ )/m.test(text)
// A shell's own complaint (`zsh:1: …`, `-bash: …`, `bash: line 0: …`) is always a diagnostic.
const SHELL_DIAGNOSTIC = /^-?(ba|z|k|da|fi)?sh(:\d+)?: /
const isContent = (line: string, diff: boolean) =>
  (diff && /^([+\- ]|@@|diff --git|index )/.test(line)) || /^[^:\s]+:\d+:/.test(line)
const hasDiagnostic = (text: string) => {
  const diff = isDiff(text)
  return text.split('\n').some(line => SHELL_DIAGNOSTIC.test(line) || (!isContent(line, diff) && DIAGNOSTIC.test(line.trim())))
}

function isPredicateInvocation(words: string[], exe: string, args: string[]): boolean {
  if (PREDICATES.has(exe)) return true
  const plain = words.filter(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
  if (plain[0] === 'command' && plain[1] === '-v') return true
  if (exe === 'jq') return args.some(a => a === '-e' || a === '--exit-status')
  if (exe === 'git') {
    let i = 0
    while (i < args.length && (args[i] as string).startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree'].includes(args[i] as string) ? 2 : 1
    const sub = args[i]
    return sub === 'grep' || sub === 'diff' || (sub === 'merge-base' && args.includes('--is-ancestor'))
  }
  return false
}

// A successful single command that ran a test, typecheck or lint.
export function isCheckCommand(command: string): boolean {
  const { words, isCompound } = parse(command)
  if (isCompound) return false
  // `MAKEFLAGS=-n make test` dry-runs: the variable is dropped before the executable is found.
  // Its value is short-option clusters (GNU make allows the first without a dash), or long options.
  const makeflags = words.find(w => w.startsWith('MAKEFLAGS='))
  if (makeflags !== undefined) {
    const flags = makeflags.slice('MAKEFLAGS='.length).split(/\s+/)
    if (flags.some((f, i) => /^--(dry-run|just-print|recon)$/.test(f) || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(f) || (i === 0 && /^[a-zA-Z]*n[a-zA-Z]*$/.test(f)))) return false
  }
  const { exe, args } = invocation(words)
  return isCheckInvocation(exe, args)
}

// A failed command whose exit code is an answer, or a compound line whose failure
// cannot be pinned on a command: neither summons anything.
export function isExcusedFailure(command: string, errorText: string): boolean {
  // An interrupted run was the person stopping it, not the code failing.
  if (/\binterrupted\b|Interrupted by user/i.test(errorText.slice(0, 400))) return true
  const { words, isCompound } = parse(command)
  if (isCompound) return !/\b([A-Z][A-Za-z]*(Error|Exception)|E[A-Z]{3,}[A-Z0-9]*)\b/.test(errorText)
  const { exe, args } = invocation(words)
  return isPredicateInvocation(words, exe, args) && !hasDiagnostic(errorText)
}
