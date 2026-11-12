import { Oidc } from './oidc.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { artifactName, isId, isSha, jobKey, requireValue, validateContext } from './proof.mjs'

const exec = promisify(execFile)
export async function recordCheck(
	context,
	api,
	{ cwd = process.cwd(), temp = process.env.RUNNER_TEMP || tmpdir(), onError = () => {}, oidc = new Oidc() } = {},
) {
	try {
		validateContext(context)
		requireValue(
			context.eventName === 'pull_request' &&
				context.event.pull_request?.head?.repo?.id === context.repositoryId &&
				context.runAttempt === 1 &&
				isId(context.runId),
			'Only first-attempt own PRs can record proof',
		)
		const identity = await oidc.current(context)
		requireValue(context.runnerName, 'Missing runner name')
		const key = jobKey(context.job, context.matrix)
		const git = async (...args) =>
			(await exec('git', args, { cwd, timeout: 10000, maxBuffer: 64 * 1024 })).stdout.trim()
		requireValue((await git('rev-parse', 'HEAD')) === context.sha, 'Checkout HEAD differs from event SHA')
		await git('diff', '--exit-code', 'HEAD', '--')
		const tree = await git('rev-parse', 'HEAD^{tree}')
		requireValue(isSha(tree), 'Invalid checkout tree')
		const base = `/repos/${context.repository}`
		const commit = await api.json(`${base}/git/commits/${context.sha}`)
		requireValue(commit.sha === context.sha && commit.tree?.sha === tree, 'Checkout tree differs from GitHub')
		const result = await api.json(`${base}/actions/runs/${context.runId}/attempts/1/jobs?per_page=100`)
		requireValue(result.total_count <= 100 && Array.isArray(result.jobs), 'Incomplete jobs list')
		const matches = result.jobs.filter((job) => job.runner_name === context.runnerName && job.status === 'in_progress')
		requireValue(
			matches.length === 1 &&
				isId(matches[0].id) &&
				matches[0].run_id === context.runId &&
				matches[0].run_attempt === 1,
			'Ambiguous current job',
		)
		const proof = {
			schema: 1,
			repository_id: context.repositoryId,
			repository: context.repository,
			workflow: context.workflow,
			run_id: context.runId,
			run_attempt: 1,
			job_id: matches[0].id,
			job_key: key,
			checked_commit: context.sha,
			checked_tree: tree,
			workflow_ref: identity.workflowRef,
			oidc_token: identity.token,
		}
		const directory = await mkdtemp(join(temp, 'ci-proof-'))
		const path = join(directory, 'proof.json')
		await writeFile(path, JSON.stringify(proof) + '\n', { mode: 0o600 })
		return { path, artifactName: artifactName(context.runId, 1, key) }
	} catch (error) {
		onError(error)
		return null
	}
}
