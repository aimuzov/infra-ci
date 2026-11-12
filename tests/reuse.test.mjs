import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { reuseCheck } from '../lib/reuse.mjs'
import { Oidc } from '../lib/oidc.mjs'
import { GitHub } from '../lib/proof.mjs'
import { claims, token, oidcOptions } from './oidc-fixtures.mjs'

const sha = 'a'.repeat(40),
	tree = 'b'.repeat(40),
	old = 'c'.repeat(40),
	dep = 'd'.repeat(40)
const context = {
	eventName: 'push',
	ref: 'refs/heads/main',
	sha,
	repository: 'acme/site',
	repositoryId: 7,
	workflow: '.github/workflows/check.yml',
	job: 'check',
	matrix: {},
	runId: 20,
	runAttempt: 1,
	runnerName: 'current-runner',
	event: { repository: { id: 7, default_branch: 'main' } },
}
function fixture() {
	const proof = {
		schema: 1,
		repository_id: 7,
		repository: 'acme/site',
		workflow: '.github/workflows/check.yml',
		run_id: 10,
		run_attempt: 1,
		job_id: 11,
		job_key: 'check:{}',
		checked_commit: old,
		checked_tree: tree,
	}
	const historicalClaims = claims({
		run_id: '10',
		event_name: 'pull_request',
		sha: old,
		ref: 'refs/pull/1/merge',
		workflow_ref: 'acme/site/.github/workflows/check.yml@refs/pull/1/merge',
	})
	proof.oidc_token = token(historicalClaims)
	proof.workflow_ref = historicalClaims.workflow_ref
	const oidc = new Oidc(oidcOptions())
	const started = new Date(Date.now() - 60000).toISOString(),
		completed = new Date(Date.now() + 60000).toISOString()
	const run = {
		created_at: started,
		updated_at: completed,
		id: 10,
		run_attempt: 1,
		workflow_id: 5,
		repository: { id: 7 },
		head_repository: { id: 7 },
		path: '.github/workflows/check.yml',
		event: 'pull_request',
		status: 'completed',
		conclusion: 'success',
		html_url: 'https://github.com/acme/site/actions/runs/10',
		referenced_workflows: [],
	}
	const artifact = {
		id: 12,
		name: 'ci-proof-10-1-' + createHash('sha256').update('check:{}').digest('hex').slice(0, 24),
		expired: false,
		size_in_bytes: 900,
		workflow_run: { id: 10, repository_id: 7, head_repository_id: 7 },
	}
	const job = {
		name: 'check',
		started_at: started,
		completed_at: completed,
		id: 11,
		run_id: 10,
		run_attempt: 1,
		status: 'completed',
		conclusion: 'success',
	}
	const currentJobs = [
		{ id: 21, run_id: 20, run_attempt: 1, name: 'check', runner_name: 'current-runner', status: 'in_progress' },
	]
	const sourceJobs = [job]
	const checkout = `2026-11-12T00:00:01Z [command]/usr/bin/git log -1 --format=%H
2026-11-12T00:00:02Z ${old}`
	let log = `2026-11-12T00:00:00Z Download action repository 'actions/checkout@v4' (SHA:${dep})
${checkout}`
	const calls = []
	const api = {
		async json(path) {
			calls.push(path)
			if (path === '/repos/acme/site/actions/runs/20/attempts/1/jobs?per_page=100')
				return { total_count: currentJobs.length, jobs: currentJobs }
			if (path === '/repos/acme/site/actions/runs/10/attempts/1/jobs?per_page=100')
				return { total_count: sourceJobs.length, jobs: sourceJobs }
			if (path.endsWith('/actions/workflows/check.yml')) return { id: 5, path: context.workflow }
			if (path.includes('/actions/workflows/5/runs?')) return { workflow_runs: [run] }
			if (path === '/repos/acme/site/git/commits/' + sha || path === '/repos/acme/site/git/commits/' + old)
				return { sha: path.endsWith(sha) ? sha : old, tree: { sha: tree } }
			if (path.includes('/actions/runs/10/artifacts?')) return { total_count: 1, artifacts: [artifact] }
			if (path === '/repos/acme/site/actions/jobs/11') return job
			if (path === '/repos/acme/site/actions/runs/10') return run
			if (path === '/repos/actions/checkout/git/ref/tags/v4')
				return { ref: 'refs/tags/v4', object: { type: 'commit', sha: dep } }
			throw new Error('Unexpected API path: ' + path)
		},
		async download(path) {
			if (path.endsWith('/actions/jobs/11/logs')) return Buffer.from(log)
			throw new Error('Unexpected download: ' + path)
		},
	}
	return {
		proof,
		run,
		artifact,
		job,
		api,
		calls,
		oidc,
		historicalClaims,
		currentJobs,
		sourceJobs,
		checkout,
		setLog(value) {
			log = value + '\n' + checkout
		},
		setRawLog(value) {
			log = value
		},
		async check(overrides = {}) {
			return reuseCheck({ ...context, ...overrides }, api, { readProof: async () => proof, oidc })
		},
	}
}

test('reuses a successful PR with identical tree at a different commit', async () => {
	const f = fixture()
	const result = await f.check()
	assert.equal(result.reused, true)
	assert.equal(result.runUrl, 'https://github.com/acme/site/actions/runs/10')
	assert.ok(f.calls.includes('/repos/acme/site/git/commits/' + sha))
	assert.ok(!f.calls.some((path) => path.includes('/commits/main')))
})

for (const [field, value] of [
	['repository_id', 8],
	['repository', 'fork/site'],
	['workflow', '.github/workflows/other.yml'],
	['job_key', 'build:{}'],
	['job_key', 'check:{"os":"linux"}'],
	['run_attempt', 2],
	['run_id', 20],
	['job_id', 99],
	['schema', 2],
	['checked_tree', 'e'.repeat(40)],
	['checked_commit', 'invalid'],
]) {
	test('rejects proof with mismatching ' + field + '=' + value, async () => {
		const f = fixture()
		f.proof[field] = value
		assert.equal((await f.check()).reused, false)
	})
}
for (const [field, value] of [
	['conclusion', 'failure'],
	['conclusion', 'cancelled'],
	['status', 'in_progress'],
	['run_attempt', 2],
	['head_repository', { id: 8 }],
	['event', 'workflow_dispatch'],
	['workflow_id', 6],
	['path', '.github/workflows/other.yml'],
]) {
	test('rejects source run with ' + field + '=' + JSON.stringify(value), async () => {
		const f = fixture()
		f.run[field] = value
		assert.equal((await f.check()).reused, false)
	})
}
for (const [field, value] of [
	['expired', true],
	['size_in_bytes', 131073],
	['workflow_run', { id: 20, repository_id: 7, head_repository_id: 7 }],
]) {
	test('rejects unsafe artifact ' + field, async () => {
		const f = fixture()
		f.artifact[field] = value
		assert.equal((await f.check()).reused, false)
	})
}
test('rejects absent and unreadable proofs', async () => {
	const f = fixture()
	const original = f.api.json
	f.api.json = async (path) => (path.includes('/artifacts?') ? { total_count: 0, artifacts: [] } : original(path))
	assert.equal((await f.check()).reused, false)
	assert.equal(
		(
			await reuseCheck(context, fixture().api, {
				readProof: async () => {
					throw Error('broken ZIP')
				},
			})
		).reused,
		false,
	)
})
test('rejects changed current tree while default branch may have moved', async () => {
	const f = fixture(),
		original = f.api.json
	f.api.json = async (path) =>
		path.endsWith('/git/commits/' + sha) ? { sha, tree: { sha: 'e'.repeat(40) } } : original(path)
	assert.equal((await f.check()).reused, false)
})
test('rejects moved mutable action refs and accepts unchanged composite dependencies', async () => {
	const f = fixture()
	f.setLog(`Download action repository 'actions/checkout@v4' (SHA:${'e'.repeat(40)})`)
	assert.equal((await f.check()).reused, false)
	f.setLog(
		`Download action repository 'actions/checkout@v4' (SHA:${dep})\nDownload action repository 'acme/composite/sub@${dep}' (SHA:${dep})`,
	)
	assert.equal((await f.check()).reused, true)
})
test('rejects missing, malformed and ambiguous dependency logs', async () => {
	for (const log of [
		'',
		'Download action repository malformed',
		`Download action repository 'actions/checkout@v4' (SHA:${dep})\nDownload action repository 'actions/checkout@v4' (SHA:${old})`,
	]) {
		const f = fixture()
		f.setLog(log)
		assert.equal((await f.check()).reused, false)
	}
})
test('rejects source job failure and API failures', async () => {
	const f = fixture()
	f.job.conclusion = 'failure'
	assert.equal((await f.check()).reused, false)
	f.api.json = async () => {
		throw new Error('timeout')
	}
	assert.equal((await f.check()).reused, false)
})
test('only permits default-branch push events', async () => {
	for (const overrides of [
		{ eventName: 'pull_request' },
		{ eventName: 'workflow_dispatch' },
		{ ref: 'refs/heads/other' },
		{ runAttempt: 2 },
	]) {
		assert.equal((await fixture().check(overrides)).reused, false)
	}
})
test('resolves annotated tags, branches and full refs in reusable workflows', async () => {
	const f = fixture(),
		original = f.api.json
	f.run.referenced_workflows = [{ path: 'acme/shared/.github/workflows/ci.yml@refs/heads/main', sha: dep }]
	f.api.json = async (path) => {
		if (path === '/repos/actions/checkout/git/ref/tags/v4')
			return { ref: 'refs/tags/v4', object: { type: 'tag', sha: old } }
		if (path === '/repos/actions/checkout/git/tags/' + old) return { object: { type: 'commit', sha: dep } }
		if (path === '/repos/acme/shared/git/ref/heads/main')
			return { ref: 'refs/heads/main', object: { type: 'commit', sha: dep } }
		return original(path)
	}
	assert.equal((await f.check()).reused, true)
	f.run.referenced_workflows[0].sha = old
	assert.equal((await f.check()).reused, false)
})
test('falls back from absent tag to branch and rejects failed lookups', async () => {
	const f = fixture(),
		original = f.api.json
	f.api.json = async (path) => {
		if (path === '/repos/actions/checkout/git/ref/tags/v4') throw Object.assign(Error('missing'), { status: 404 })
		if (path === '/repos/actions/checkout/git/ref/heads/v4')
			return { ref: 'refs/heads/v4', object: { type: 'commit', sha: dep } }
		return original(path)
	}
	assert.equal((await f.check()).reused, true)
	f.api.json = async (path) => {
		if (path.includes('/git/ref/')) throw Object.assign(Error('denied'), { status: 403 })
		return original(path)
	}
	assert.equal((await f.check()).reused, false)
})
test('rejects duplicate artifact names and rerun job metadata', async () => {
	const f = fixture(),
		original = f.api.json
	f.api.json = async (path) =>
		path.includes('/artifacts?')
			? { total_count: 2, artifacts: [f.artifact, { ...f.artifact, id: 20 }] }
			: original(path)
	assert.equal((await f.check()).reused, false)
	f.api.json = original
	f.job.run_attempt = 2
	assert.equal((await f.check()).reused, false)
})

test('rejects a partial rerun that starts after listing successful runs', async () => {
	const f = fixture(),
		original = f.api.json
	f.api.json = async (path) =>
		path === '/repos/acme/site/actions/runs/10' ? { ...f.run, run_attempt: 2 } : original(path)
	assert.equal((await f.check()).reused, false)
})

test('rejects forged checked tree/commit when signed run SHA belongs to a different tree', async () => {
	const f = fixture()
	f.proof.oidc_token = token({ ...f.historicalClaims, sha: 'e'.repeat(40) })
	assert.equal((await f.check()).reused, false)
})
test('rejects proof without signed provenance and current job without OIDC workflow identity', async () => {
	const f = fixture()
	delete f.proof.oidc_token
	assert.equal((await f.check()).reused, false)
	const other = fixture()
	assert.equal(
		(await reuseCheck(context, other.api, { readProof: async () => other.proof, oidc: new Oidc({ env: {} }) })).reused,
		false,
	)
})
test('aborts the active request at the shared gate deadline without leaving background work', async () => {
	const f = fixture()
	let active = 0
	const api = new GitHub('secret', {
		fetchImpl: async (_url, { signal }) => {
			active++
			try {
				await new Promise((resolve, reject) => {
					const timer = setTimeout(resolve, 1000)
					signal.addEventListener(
						'abort',
						() => {
							clearTimeout(timer)
							reject(signal.reason)
						},
						{ once: true },
					)
				})
				return new Response('{}')
			} finally {
				active--
			}
		},
	})
	const start = Date.now()
	const result = await reuseCheck(context, api, { oidc: f.oidc, budgetMs: 15 })
	assert.equal(result.reused, false)
	assert.equal(active, 0)
	assert.ok(Date.now() - start < 250)
})

test('source JWT remains valid as historical provenance after expiration', async () => {
	const f = fixture(),
		iat = 1700000000
	f.proof.oidc_token = token({ ...f.historicalClaims, iat, nbf: iat - 5, exp: iat + 300 })
	f.run.created_at = f.job.started_at = new Date((iat - 10) * 1000).toISOString()
	f.run.updated_at = f.job.completed_at = new Date((iat + 30) * 1000).toISOString()
	assert.equal((await f.check()).reused, true)
})
test('all signed source provenance mismatches reject reuse', async () => {
	for (const change of [
		{ aud: 'wrong' },
		{ repository_id: '8' },
		{ repository: 'fork/site' },
		{ run_id: '99' },
		{ run_attempt: '2' },
		{ event_name: 'push' },
		{ workflow_ref: 'acme/site/.github/workflows/other.yml@refs/pull/1/merge' },
	]) {
		const f = fixture()
		f.proof.oidc_token = token({ ...f.historicalClaims, ...change })
		assert.equal((await f.check()).reused, false)
	}
})

test('rejects Linux proof forged as the desired Windows job', async () => {
	const f = fixture()
	f.currentJobs[0].name = 'check (windows-latest)'
	f.job.name = 'check (ubuntu-latest)'
	assert.equal((await f.check()).reused, false)
})
test('rejects skipped desired source job even if another matrix job succeeded', async () => {
	const f = fixture()
	f.currentJobs[0].name = 'check (windows-latest)'
	f.job.name = 'check (ubuntu-latest)'
	f.sourceJobs.push({ ...f.job, id: 12, name: 'check (windows-latest)', conclusion: 'skipped' })
	assert.equal((await f.check()).reused, false)
})
test('rejects duplicate source job custom names including skipped jobs', async () => {
	const f = fixture()
	f.sourceJobs.push({ ...f.job, id: 12, conclusion: 'skipped' })
	assert.equal((await f.check()).reused, false)
})
test('accepts reusable caller prefixes with a unique source job role', async () => {
	const f = fixture()
	f.currentJobs[0].name = 'deploy-app / check / check'
	assert.equal((await f.check()).reused, true)
})
test('rejects ambiguous current runner but permits other current jobs with the same display name', async () => {
	const f = fixture()
	f.currentJobs.push({ ...f.currentJobs[0], id: 22, runner_name: 'other-runner' })
	assert.equal((await f.check()).reused, true)
	f.currentJobs[1].runner_name = 'current-runner'
	assert.equal((await f.check()).reused, false)
})
test('requires actual checkout SHA in the desired source job log to match the signed SHA', async () => {
	const action = `Download action repository 'actions/checkout@v4' (SHA:${dep})`
	for (const checkout of [
		'',
		`2026-11-12T00:00:01Z [command]/usr/bin/git log -1 --format=%H
2026-11-12T00:00:02Z ${sha}`,
	]) {
		const f = fixture()
		f.setRawLog(action + '\n' + checkout)
		assert.equal((await f.check()).reused, false)
	}
	const f = fixture()
	f.setRawLog(
		action +
			'\n' +
			f.checkout +
			'\n' +
			`2026-11-12T00:00:03Z [command]/usr/bin/git log -1 --format=%H
2026-11-12T00:00:04Z ${sha}`,
	)
	assert.equal((await f.check()).reused, false)
})
