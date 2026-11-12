import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('both action entrypoints fail open with explicit outputs when event is unreadable', async (t) => {
	const temp = await mkdtemp(join(tmpdir(), 'entry-test-'))
	t.after(() => rm(temp, { recursive: true, force: true }))
	for (const name of ['reuse-check', 'record-check']) {
		const output = join(temp, name)
		execFileSync(process.execPath, [new URL(`../${name}/index.mjs`, import.meta.url).pathname], {
			env: { ...process.env, GITHUB_EVENT_PATH: join(temp, 'missing-event'), GITHUB_OUTPUT: output },
			stdio: 'pipe',
		})
		const values = await readFile(output, 'utf8')
		if (name === 'reuse-check') assert.match(values, /reused=false\nrun-url=\nreason=/)
		else assert.equal(values, 'path=\nartifact-name=\n')
	}
})
