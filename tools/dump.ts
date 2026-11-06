/**
 * Prints what each fixture does when the real `pollRound` runs on it.
 *
 *     node --experimental-transform-types --import ./tools/bootstrap.ts tools/dump.ts [fixture…]
 *
 * Useful when a test fails: it shows every Trigger, every health line and every request the Source made.
 */
import { harness, loadFixture } from '../src/harness/context.ts'

const names = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['01-issue-mention', '02-inline-review', '03-review-approval', '04-ci-failure-recovery', '05-issue-gone-410', '06-pagination-etag']

for (const name of names) {
  const fixture = await loadFixture(name)
  const h = await harness(fixture)
  console.log(`\n=== ${fixture.name} — ${fixture.description}\n`)
  for (let round = 0; round < (fixture.rounds?.length ?? 1); round += 1) {
    const result = await h.poll(round)
    console.log(`round ${round}: ${result.error ? `error: ${result.error}` : `interval ${result.interval}s`}, ${result.received.length} trigger(s)`)
    for (const trigger of result.received) {
      console.log(`  id=${trigger.id}`)
      console.log(`  threads=${JSON.stringify(trigger.threads)} actor=${trigger.actor.id} human=${trigger.human} addressed=${trigger.addressed ?? '-'}`)
      console.log(`  meta=${JSON.stringify(trigger.meta)}`)
      console.log(`  text=${JSON.stringify(trigger.text.slice(0, 120))}`)
    }
    console.log(`  health=${JSON.stringify(h.health.at(-1))}`)
  }
  console.log(`  requests: ${h.requests().length}`)
  for (const request of h.requests()) console.log(`    ${request.status} ${request.method} ${request.url.slice(0, 130)}`)
  await h.close()
}
