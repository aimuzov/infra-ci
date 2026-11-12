import { Oidc } from './oidc.mjs'
import { artifactName, isId, isSha, jobKey, readProof, requireValue, validateContext } from './proof.mjs'

async function runJobs(api, base, runId) {
	const result = await api.json(`${base}/actions/runs/${runId}/attempts/1/jobs?per_page=100`)
	requireValue(
		Number.isSafeInteger(result.total_count) &&
			result.total_count <= 100 &&
			Array.isArray(result.jobs) &&
			result.jobs.length === result.total_count,
		'Incomplete jobs list',
	)
	return result.jobs
}

async function resolveRef(api, repository, ref) {
	if (isSha(ref)) return ref
	let result, expected
	if (ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')) {
		const [, type, ...name] = ref.split('/')
		result = await api.json(`/repos/${repository}/git/ref/${type}/${encodeURIComponent(name.join('/'))}`)
		expected = ref
	} else {
		try {
			result = await api.json(`/repos/${repository}/git/ref/tags/${encodeURIComponent(ref)}`)
			expected = `refs/tags/${ref}`
		} catch (error) {
			if (error.status !== 404) throw error
			result = await api.json(`/repos/${repository}/git/ref/heads/${encodeURIComponent(ref)}`)
			expected = `refs/heads/${ref}`
		}
	}
	requireValue(result.ref === expected, 'Ref mismatch')
	let object = result.object
	for (let depth = 0; object?.type === 'tag' && depth < 8; depth++) {
		requireValue(isSha(object.sha), 'Invalid tag SHA')
		object = (await api.json(`/repos/${repository}/git/tags/${object.sha}`)).object
	}
	requireValue(object?.type === 'commit' && isSha(object.sha), 'Unresolved ref')
	return object.sha
}

async function dependenciesMatch(api, repository, jobId, workflows, resolutions, checkedCommit) {
	const logs = (
		await api.download(`/repos/${repository}/actions/jobs/${jobId}/logs`, { limit: 8 * 1024 * 1024 })
	).toString('utf8')
	const lines = logs.split('\n'),
		checked = new Set()
	for (let index = 0; index < lines.length; index++) {
		api.signal?.throwIfAborted()
		if (!/\[command\].*\bgit(?:\.exe)?["']?\s+log\s+-1\s+--format=(?:%H|["']%H["'])\s*$/.test(lines[index])) continue
		let found
		for (let next = index + 1; next < lines.length && !lines[next].includes('[command]'); next++) {
			const match = lines[next].match(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z\s+([a-f0-9]{40})\s*$/)
			if (match) {
				found = match[1]
				break
			}
		}
		requireValue(found, 'Missing checkout SHA output')
		checked.add(found)
	}
	requireValue(checked.size === 1 && checked.has(checkedCommit), 'Source job checkout differs from signed commit')
	const downloads = lines.filter((line) => line.includes('Download action repository'))
	requireValue(downloads.length > 0, 'No reliable action download log')
	const dependencies = new Map()
	function add(repository, ref, sha) {
		requireValue(isSha(sha), 'Invalid dependency SHA')
		const key = `${repository}@${ref}`
		requireValue(!dependencies.has(key) || dependencies.get(key).sha === sha, 'Ambiguous dependency ref')
		dependencies.set(key, { repository, ref, sha })
	}
	for (const line of downloads) {
		api.signal?.throwIfAborted()
		const match = line.match(
			/Download action repository '([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\/[^'@\s]+)?@([^'\s]+)' \(SHA:([a-f0-9]{40})\)/,
		)
		requireValue(match, 'Malformed action download log')
		add(match[1], match[2], match[3])
	}
	for (const workflow of workflows || []) {
		const match = workflow.path?.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/\.github\/workflows\/[^@]+@(.+)$/)
		requireValue(match, 'Unresolved reusable workflow')
		add(match[1], match[2], workflow.sha)
	}
	for (const [key, dependency] of dependencies) {
		api.signal?.throwIfAborted()
		if (!resolutions.has(key)) resolutions.set(key, await resolveRef(api, dependency.repository, dependency.ref))
		requireValue(resolutions.get(key) === dependency.sha, 'Action or workflow ref changed')
	}
}

export async function reuseCheck(
	context,
	api,
	{ readProof: loadProof = readProof, oidc, budgetMs = 20000, signal: externalSignal } = {},
) {
	const deadline = AbortSignal.timeout(budgetMs)
	const signal = externalSignal ? AbortSignal.any([externalSignal, deadline]) : deadline
	api.signal = signal
	oidc ??= new Oidc()
	oidc.signal = signal
	try {
		signal.throwIfAborted()
		validateContext(context)
		requireValue(
			context.eventName === 'push' && context.ref === `refs/heads/${context.event.repository.default_branch}`,
			'Only default branch pushes can reuse CI',
		)
		requireValue(context.runAttempt === 1, 'Reruns require full CI')
		const currentIdentity = await oidc.current(context)
		const key = jobKey(context.job, context.matrix),
			base = `/repos/${context.repository}`
		const currentJobs = await runJobs(api, base, context.runId)
		const currentMatches = currentJobs.filter(
			(job) => job.status === 'in_progress' && job.runner_name === context.runnerName,
		)
		requireValue(context.runnerName && currentMatches.length === 1, 'Ambiguous current runner job')
		const currentJob = currentMatches[0]
		requireValue(
			isId(currentJob.id) &&
				currentJob.run_id === context.runId &&
				currentJob.run_attempt === 1 &&
				typeof currentJob.name === 'string' &&
				currentJob.name.length > 0,
			'Invalid current job metadata',
		)
		const workflow = await api.json(
			`${base}/actions/workflows/${encodeURIComponent(context.workflow.split('/').at(-1))}`,
		)
		requireValue(isId(workflow.id) && workflow.path === context.workflow, 'Workflow mismatch')
		const current = await api.json(`${base}/git/commits/${context.sha}`)
		requireValue(current.sha === context.sha && isSha(current.tree?.sha), 'Invalid current commit tree')
		const { workflow_runs: runs } = await api.json(
			`${base}/actions/workflows/${workflow.id}/runs?event=pull_request&status=success&per_page=20`,
		)
		requireValue(Array.isArray(runs), 'Invalid workflow runs')
		const resolutions = new Map()
		for (const run of runs.slice(0, 20)) {
			signal.throwIfAborted()
			if (
				run.event !== 'pull_request' ||
				run.status !== 'completed' ||
				run.conclusion !== 'success' ||
				run.run_attempt !== 1 ||
				run.workflow_id !== workflow.id ||
				run.path !== context.workflow ||
				run.repository?.id !== context.repositoryId ||
				run.head_repository?.id !== context.repositoryId ||
				!isId(run.id)
			)
				continue
			try {
				const artifacts = await api.json(`${base}/actions/runs/${run.id}/artifacts?per_page=100`)
				requireValue(artifacts.total_count <= 100 && Array.isArray(artifacts.artifacts), 'Incomplete artifact list')
				const matching = artifacts.artifacts.filter((item) => item.name === artifactName(run.id, 1, key))
				requireValue(matching.length === 1, 'Missing or duplicate proof artifact')
				const artifact = matching[0]
				requireValue(
					isId(artifact.id) &&
						artifact.expired === false &&
						artifact.size_in_bytes > 0 &&
						artifact.size_in_bytes <= 128 * 1024,
					'Expired or oversized proof',
				)
				requireValue(
					artifact.workflow_run?.id === run.id &&
						artifact.workflow_run.repository_id === context.repositoryId &&
						artifact.workflow_run.head_repository_id === context.repositoryId,
					'Artifact repository/run mismatch',
				)
				const proof = await loadProof(api, context.repository, artifact)
				requireValue(
					proof.schema === 1 &&
						proof.repository_id === context.repositoryId &&
						proof.repository === context.repository &&
						proof.workflow === context.workflow &&
						proof.run_id === run.id &&
						proof.run_attempt === 1 &&
						proof.job_key === key &&
						isId(proof.job_id) &&
						isSha(proof.checked_commit) &&
						proof.checked_tree === current.tree.sha,
					'Proof context mismatch',
				)
				const commit = await api.json(`${base}/git/commits/${proof.checked_commit}`)
				requireValue(
					commit.sha === proof.checked_commit && commit.tree?.sha === proof.checked_tree,
					'Proof tree mismatch',
				)
				const sourceJobs = await runJobs(api, base, run.id)
				const sourceMatches = sourceJobs.filter(
					(job) =>
						typeof job.name === 'string' &&
						job.name.length > 0 &&
						(currentJob.name === job.name || currentJob.name.endsWith(' / ' + job.name)),
				)
				requireValue(sourceMatches.length === 1, 'Ambiguous source job role')
				const job = sourceMatches[0]
				requireValue(
					job.id === proof.job_id &&
						job.run_id === run.id &&
						job.run_attempt === 1 &&
						job.status === 'completed' &&
						job.conclusion === 'success',
					'Source job did not succeed',
				)
				const latestRun = await api.json(`${base}/actions/runs/${run.id}`)
				requireValue(
					latestRun.id === run.id &&
						latestRun.run_attempt === 1 &&
						latestRun.status === 'completed' &&
						latestRun.conclusion === 'success' &&
						latestRun.event === 'pull_request' &&
						latestRun.workflow_id === workflow.id &&
						latestRun.path === context.workflow &&
						latestRun.repository?.id === context.repositoryId &&
						latestRun.head_repository?.id === context.repositoryId,
					'Source run changed or was rerun',
				)
				const sourceIdentity = await oidc.historical(proof.oidc_token, context, proof, latestRun, job)
				requireValue(
					sourceIdentity.workflowRef.split('@')[0] === currentIdentity.workflowRef.split('@')[0],
					'Current/source workflow identities differ',
				)
				await dependenciesMatch(
					api,
					context.repository,
					job.id,
					latestRun.referenced_workflows,
					resolutions,
					proof.checked_commit,
				)
				signal.throwIfAborted()
				requireValue(
					run.html_url === `https://github.com/${context.repository}/actions/runs/${run.id}`,
					'Invalid run URL',
				)
				return { reused: true, runUrl: run.html_url, reason: 'Matching verified tree and action refs' }
			} catch (error) {
				if (error.apiFailure || signal.aborted) throw error
			}
		}
		return { reused: false, reason: 'No matching verified PR proof' }
	} catch (error) {
		return { reused: false, reason: error.message }
	}
}
