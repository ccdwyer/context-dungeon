import { expect, test } from 'claude-code/testing'

import {
  MAX_FOE_HP, errorKind, fameOf, freshLifetime, freshRun, hasProgress, isCheckCommand, isExcusedFailure, onBonfire,
  onBossAppears, onCommit, onContext, onFailure, onFloorCleared, onPass, onTurn, record, reportsFailures,
} from '../hooks/game'

test('errors name their monsters, never the command', async () => {
  expect(errorKind('TypeError: x is not a function')).toBe('TypeError')
  expect(errorKind('ENOENT: no such file')).toBe('ENOENT')
  expect(errorKind('3 tests failed')).toBe('Red Test')
  expect(errorKind('zsh: command not found: foo')).toBe('Missing Binary')
  const met = onFailure(freshRun(0), 'boom')
  expect(met.lines.join(' ')).not.toMatch(/Bearer|curl/)
})

test('a failure summons a foe, a clean pass slays it and drops loot', async () => {
  const met = onFailure(freshRun(0), 'TypeError: boom')
  expect(met.run.foe?.name).toMatch(/^TypeError /)
  const won = onPass(met.run, 'Tests: 12 passed', 'seed')
  expect(won.run.foe).toBeNull()
  expect(won.run.kills).toBe(1)
  expect(won.run.streak).toBe(1)
  expect(won.lines.join('\n')).toMatch(/LIMIT BREAK/)
})

test('a pass that still reports failures only chips the foe', async () => {
  const met = onFailure(freshRun(0), 'boom')
  for (const text of ['Tests: 2 failed, 10 passed', 'FAIL src/a.test.ts', '  ✕ adds numbers', '===== 1 failed, 3 passed =====']) {
    expect(onPass(met.run, text, 'seed').run.foe?.hp).toBe((met.run.foe?.hp ?? 0) - 1)
  }
})

test('more failures strengthen the foe, up to a cap', async () => {
  let r = onFailure(freshRun(0), 'TypeError: a').run
  const name = r.foe?.name
  for (let i = 0; i < 30; i += 1) r = onFailure(r, 'RangeError: b').run
  expect(r.foe?.name).toBe(name)
  expect(r.foe?.maxHp).toBe(MAX_FOE_HP)
})

test('commits open chests; a PR summons the boss, a merge clears the floor', async () => {
  const chest = onCommit(freshRun(0), 's')
  expect(chest.run.chests).toBe(1)
  const boss = onBossAppears(chest.run, 's')
  expect(boss.run.foe?.isBoss).toBe(true)
  expect(boss.run.floor).toBe(1)
  let fight = boss.run
  for (let i = 0; i < 5; i += 1) fight = onPass(fight, 'all green', 's').run
  expect(fight.foe?.isBoss).toBe(true)
  const cleared = onFloorCleared(fight, 's')
  expect(cleared.run.floor).toBe(2)
  expect(cleared.run.bosses).toBe(1)
  expect(cleared.run.foe).toBeNull()
})

test('running out of context wipes once, then waits for context to free up', async () => {
  const deep = { ...freshRun(0), floor: 3, level: 4, kills: 7, chests: 2 }
  const wipe = onContext(deep, 1.5, 99)
  expect(wipe.fame?.floor).toBe(3)
  expect(wipe.run.floor).toBe(1)
  expect(wipe.run.hp).toBe(2)
  const again = onContext(wipe.run, 1, 100)
  expect(again.fame).toBeUndefined()
  const freed = onContext(again.run, 60, 101)
  expect(freed.run.isExhausted).toBe(false)
  expect(onContext(deep, 2.4, 99).fame).toBeUndefined()
})

test('a bonfire heals, spends the streak, and never wipes on the stale sample after it', async () => {
  const deep = { ...freshRun(0), floor: 3, kills: 4, hp: 40, streak: 4 }
  const rest = onBonfire(deep)
  expect(rest.run.hp).toBe(100)
  expect(rest.run.streak).toBe(0)
  const stale = onContext(rest.run, 1.5, 5)
  expect(stale.fame).toBeUndefined()
  expect(stale.run.floor).toBe(3)
  const real = onContext(stale.run, 41, 7)
  expect(real.run.hp).toBe(41)
  expect(real.run.restSkips).toBe(0)
})

test('passive turns alone are not a run worth remembering', async () => {
  let r = freshRun(0)
  for (let i = 0; i < 10; i += 1) r = onTurn(r).run
  expect(r.level).toBeGreaterThan(1)
  expect(hasProgress(r)).toBe(false)
})

test('failure counts are read from summaries, not test names', async () => {
  expect(reportsFailures('✓ handles 2 failed payments\nTests: 9 passed')).toBe(false)
  expect(reportsFailures('fail: none\nall good')).toBe(false)
  expect(reportsFailures('Tests: 1 failed, 9 passed')).toBe(true)
  expect(reportsFailures('✓ handles 2 failed tests')).toBe(false)
  expect(reportsFailures('FAILED test_foo.py::test_bar - assert 1 == 2')).toBe(true)
  expect(reportsFailures('\x1b[31mFAIL\x1b[0m src/a.test.ts')).toBe(true)
  expect(reportsFailures('  3 passing\n  1 failing')).toBe(true)
  expect(reportsFailures('FAILED (failures=1)')).toBe(true)
})

test('the hall of fame counts chests', async () => {
  const life = record(freshLifetime(), fameOf({ ...freshRun(0), chests: 3 }, 'retired to the inn', 1))
  expect(life.chests).toBe(3)
  expect(life.runs).toBe(1)
})

test('checks are recognized by their executable, not by mentions', async () => {
  for (const c of [
    'npm test', 'npx tsc --noEmit', 'npx --yes tsc --noEmit', 'pnpm run lint', 'CI=1 vitest run', 'go test ./...',
    'python3.12 -m pytest -q', './gradlew testDebug', 'npm --prefix web test', 'pnpm --filter app test', 'node --test',
    'make -C pkg test', 'npm run test:unit', 'ruff check .', 'sudo -E npm test',
    'npm test 2>&1', 'npm test &> out.txt', 'npm test > out.txt', 'npm test\n', 'npm test # show | head',
    'pytest -v', 'mypy -v src', 'jest -w 2', 'cargo +nightly test', 'cargo --manifest-path app/Cargo.toml test',
    'go -C dir test ./...', 'make -f Makefile test', 'make CFLAGS=-O2 test', 'uv run pytest', 'poetry run pytest',
    'bundle exec rspec', 'node --run test', 'cd app && npm test', 'dotnet test -c Release', 'swift test -c release',
    'node --run test:unit', 'time -p npm test', '> out.txt pytest',
  ]) {
    expect(isCheckCommand(c)).toBe(true)
  }
  for (const c of [
    'cat eslint.config.js', 'rg tsc', 'npm install jest', 'echo pytest', 'git commit -m test', 'tsc --version',
    'pytest --version', 'ruff format .', 'biome format --write src', './gradlew testClasses', './gradlew checkout',
    "echo 'example; npm test'", 'true || npm test', 'npm test || true', 'npm test | tee out.txt', 'rg x || npm test',
    'eslint --fix src', 'jest --listTests', 'pytest --collect-only', 'tsc --showConfig', 'tsc -v', 'go test -c ./pkg',
    'npm test &', 'npm test\nrm -rf x', 'echo $(npm test)', 'echo "$(npm test)"', 'npm test "$(date)"',
    'cd "$(pwd)" && npm test', 'npm > test install', 'python -m pytest --collect-only', 'python -m mypy --install-types',
    'node --run lint-staged', 'node --run testbed', 'npm test -- --watch', 'npm run test -- --watch',
  ]) {
    expect(isCheckCommand(c)).toBe(false)
  }
})

test('failures that are answers, or cannot be pinned on a command, are excused', async () => {
  for (const c of ['rg TODO src', "rg -n '&&' src", "grep -R ' | ' src", 'git -C repo diff --quiet', 'git --no-pager diff', 'fd missing', 'jq -e .ok f.json', 'command -v nope', 'git merge-base --is-ancestor a b']) {
    expect(isExcusedFailure(c, 'exit 1')).toBe(true)
  }
  expect(isExcusedFailure('test -f a.conf && npm test', 'exit 1')).toBe(true)
  expect(isExcusedFailure('npm test && rg TODO', 'TypeError: boom')).toBe(false)
  expect(isExcusedFailure('npm test', 'exit 1')).toBe(false)
  expect(isExcusedFailure("rg '[' src", 'regex parse error: unclosed character class')).toBe(false)
  expect(isExcusedFailure('jq -e . broken.json', 'jq: error (at broken.json:1): Cannot parse')).toBe(false)
  expect(isExcusedFailure('find /missing -name x', 'find: /missing: No such file or directory')).toBe(false)
  expect(isExcusedFailure('FOO=1 command -v nope', 'exit 1')).toBe(true)
  expect(isExcusedFailure('diff -u a b', '--- a\n+++ b\n@@ -1 +1 @@\n-ok\n+error handling')).toBe(true)
  expect(isExcusedFailure('git diff --quiet', 'fatal: not a git repository')).toBe(false)
  expect(isExcusedFailure('test abc -eq 1', 'bash: test: abc: integer expression expected')).toBe(false)
  expect(isExcusedFailure('npm test', 'Interrupted by user')).toBe(true)
})

test('a red report in an empty room earns nothing', async () => {
  const r = onPass(freshRun(0), 'FAIL src/a.test.ts', 's')
  expect(r.run.xp).toBe(0)
})
