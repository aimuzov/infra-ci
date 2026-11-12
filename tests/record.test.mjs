import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { recordCheck } from '../lib/record.mjs'
import { Oidc } from '../lib/oidc.mjs'
import { claims, oidcOptions } from './oidc-fixtures.mjs'

async function fixture(t) {
	const cwd = await mkdtemp(join(tmpdir(), 'record-test-'))
	t.after(() => rm(cwd, { recursive: true, force: true }))
	const git = (...args) =>
		execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
	git('init', '-q')
	git('config', 'commit.gpgsign', 'false')
	git('config', 'core.hooksPath', '/dev/null')
	git('config', 'user.name', 'Test')
	git('config', 'user.email', 'test@example.test')
	await writeFile(join(cwd, 'source.txt'), 'source')
	git('add', 'source.txt')
	git('commit', '-qm', 'test')
	const sha = git('rev-parse', 'HEAD'),
		tree = git('rev-parse', 'HEAD^{tree}')
	const context = {
		eventName: 'pull_request',
		event: { repository: { id: 7 }, pull_request: { head: { repo: { id: 7 } } } },
		repository: 'acme/site',
		repositoryId: 7,
		sha,
		ref: 'refs/pull/1/merge',
		workflow: '.github/workflows/check.yml',
		workflowRef: 'acme/site/.github/workflows/check.yml@refs/pull/1/merge',
		job: 'check',
		matrix: '{"os":"linux"}',
		runId: 10,
		runAttempt: 1,
		runnerName: 'runner-1',
	}
	const oidc = new Oidc(
		oidcOptions(
			claims({
				sha,
				event_name: 'pull_request',
				run_id: '10',
				ref: 'refs/pull/1/merge',
				workflow_ref: 'acme/site/.github/workflows/check.yml@refs/pull/1/merge',
			}),
		),
	)
	const jobs = [{ id: 11, run_id: 10, run_attempt: 1, runner_name: 'runner-1', status: 'in_progress' }]
	const api = {
		async json(path) {
			if (path === '/repos/acme/site/actions/runs/10/attempts/1/jobs?per_page=100')
				return { total_count: jobs.length, jobs }
			if (path === '/repos/acme/site/git/commits/' + sha) return { sha, tree: { sha: tree } }
			throw new Error('Unexpected API path: ' + path)
		},
	}
	return {
		cwd,
		git,
		context,
		jobs,
		api,
		sha,
		tree,
		oidc,
		check: () => recordCheck(context, api, { cwd, temp: cwd, oidc }),
	}
}
test('records actual git checkout, job and canonical matrix, allowing untracked build output', async (t) => {
	const f = await fixture(t)
	await writeFile(join(f.cwd, 'build-output'), 'generated')
	const result = await f.check()
	assert.ok(result?.path)
	const proof = JSON.parse(await readFile(result.path, 'utf8'))
	assert.equal(proof.checked_commit, f.sha)
	assert.equal(proof.checked_tree, f.tree)
	assert.equal(proof.job_id, 11)
	assert.equal(proof.job_key, 'check:{"os":"linux"}')
	assert.equal(proof.oidc_token.split('.').length, 3)
	assert.equal(proof.workflow_ref, 'acme/site/.github/workflows/check.yml@refs/pull/1/merge')
	assert.equal(proof.repository_id, 7)
	assert.equal(proof.workflow, '.github/workflows/check.yml')
	assert.match(result.artifactName, /^ci-proof-10-1-[a-f0-9]{24}$/)
})
test('refuses changed tracked files and different checkout HEAD', async (t) => {
	const f = await fixture(t)
	await writeFile(join(f.cwd, 'source.txt'), 'changed')
	assert.equal(await f.check(), null)
	f.git('add', 'source.txt')
	f.git('commit', '-qm', 'other')
	assert.equal(await f.check(), null)
})
test('refuses fork, rerun, wrong workflow-ref and non-PR events', async (t) => {
	const f = await fixture(t)
	for (const overrides of [
		{ runAttempt: 2 },
		{ eventName: 'push' },
		{ workflow: '.github/workflows/other.yml' },
		{ event: { repository: { id: 7 }, pull_request: { head: { repo: { id: 8 } } } } },
	]) {
		assert.equal(
			await recordCheck({ ...f.context, ...overrides }, f.api, { cwd: f.cwd, temp: f.cwd, oidc: f.oidc }),
			null,
		)
	}
})
test('refuses ambiguous runner jobs and API failures', async (t) => {
	const f = await fixture(t)
	f.jobs.push({ ...f.jobs[0], id: 12 })
	assert.equal(await f.check(), null)
	f.api.json = async () => {
		throw Error('API failure')
	}
	assert.equal(await f.check(), null)
})
