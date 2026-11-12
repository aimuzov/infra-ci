import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export const isSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
export const isId = (value) => Number.isSafeInteger(value) && value > 0
export const requireValue = (condition, message) => {
	if (!condition) throw new Error(message)
}

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical)
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonical(value[key])]),
		)
	return value
}
export function jobKey(job, matrix = {}) {
	if (typeof matrix === 'string') matrix = JSON.parse(matrix)
	matrix ??= {}
	requireValue(job && typeof job === 'string' && !/[\r\n]/.test(job), 'Invalid job')
	requireValue(typeof matrix === 'object' && !Array.isArray(matrix), 'Invalid matrix')
	return `${job}:${JSON.stringify(canonical(matrix))}`
}
export function artifactName(runId, attempt, key) {
	return `ci-proof-${runId}-${attempt}-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`
}
export function validateContext(context) {
	requireValue(isId(context.repositoryId), 'Invalid repository ID')
	requireValue(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository), 'Invalid repository')
	requireValue(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(context.workflow), 'Invalid workflow')
	requireValue(isSha(context.sha), 'Invalid commit')
	requireValue(context.event?.repository?.id === context.repositoryId, 'Event repository mismatch')
}

export class GitHub {
	constructor(token, { fetchImpl = fetch, apiUrl = 'https://api.github.com', timeoutMs = 10000, signal } = {}) {
		this.token = token
		this.fetch = fetchImpl
		this.base = new URL(apiUrl)
		this.timeoutMs = timeoutMs
		this.signal = signal
	}
	async request(path, limit, binary) {
		const signal = this.signal
			? AbortSignal.any([this.signal, AbortSignal.timeout(this.timeoutMs)])
			: AbortSignal.timeout(this.timeoutMs)
		try {
			signal.throwIfAborted()
			let url = new URL(path, this.base)
			requireValue(url.origin === this.base.origin && !url.username && !url.password, 'Invalid API URL')
			let response
			for (let redirects = 0; redirects <= 5; redirects++) {
				signal.throwIfAborted()
				const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
				if (url.origin === this.base.origin) headers.Authorization = `Bearer ${this.token}`
				response = await this.fetch(url.href, { headers, redirect: 'manual', signal })
				if (![301, 302, 303, 307, 308].includes(response.status)) break
				requireValue(binary && redirects < 5, 'Unexpected redirect')
				url = new URL(response.headers.get('location'), url)
				requireValue(url.protocol === 'https:' && !url.username && !url.password, 'Unsafe download redirect')
			}
			if (!response.ok) {
				const error = new Error(`GitHub API HTTP ${response.status}`)
				error.status = response.status
				throw error
			}
			const length = response.headers.get('content-length')
			requireValue(length === null || Number(length) <= limit, 'Response too large')
			const chunks = []
			let size = 0
			for await (const chunk of response.body) {
				signal.throwIfAborted()
				size += chunk.length
				requireValue(size <= limit, 'Response too large')
				chunks.push(chunk)
			}
			const bytes = Buffer.concat(chunks)
			signal.throwIfAborted()
			return binary ? bytes : JSON.parse(bytes.toString('utf8'))
		} catch (error) {
			throw Object.assign(new Error(error.status ? `GitHub API HTTP ${error.status}` : 'GitHub API request failed'), {
				apiFailure: true,
				status: error.status,
				name: error.name,
			})
		}
	}
	json(path) {
		return this.request(path, 4 * 1024 * 1024, false)
	}
	download(path, { limit = 128 * 1024 } = {}) {
		return this.request(path, limit, true)
	}
}

export async function readProof(api, repository, artifact) {
	api.signal?.throwIfAborted()
	const bytes = await api.download(`/repos/${repository}/actions/artifacts/${artifact.id}/zip`, { limit: 128 * 1024 })
	requireValue(bytes.length <= 128 * 1024, 'ZIP too large')
	const directory = await mkdtemp(join(tmpdir(), 'ci-proof-'))
	try {
		const file = join(directory, 'artifact.zip')
		await writeFile(file, bytes, { mode: 0o600 })
		const options = { timeout: 5000, maxBuffer: 64 * 1024, signal: api.signal }
		const listing = await exec('unzip', ['-Z1', file], options)
		requireValue(listing.stdout === 'proof.json\n', 'ZIP must contain exactly one proof.json')
		const extracted = await exec('unzip', ['-p', file, 'proof.json'], options)
		requireValue(!extracted.stderr, 'Invalid ZIP')
		api.signal?.throwIfAborted()
		return JSON.parse(extracted.stdout)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
}

export async function readContext(env = process.env) {
	return {
		eventName: env.GITHUB_EVENT_NAME,
		event: JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')),
		ref: env.GITHUB_REF,
		sha: env.GITHUB_SHA,
		repository: env.GITHUB_REPOSITORY,
		repositoryId: Number(env.GITHUB_REPOSITORY_ID),
		workflow: env.INPUT_WORKFLOW,
		job: env.GITHUB_JOB,
		matrix: env.INPUT_MATRIX || '{}',
		runId: Number(env.GITHUB_RUN_ID),
		runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
		runnerName: env.RUNNER_NAME,
		workflowRef: env.GITHUB_WORKFLOW_REF,
	}
}
export async function outputs(values, env = process.env) {
	const lines = Object.entries(values)
		.map(([key, value]) => `${key}=${String(value ?? '').replace(/[\r\n]/g, ' ')}\n`)
		.join('')
	if (env.GITHUB_OUTPUT) {
		const { appendFile } = await import('node:fs/promises')
		await appendFile(env.GITHUB_OUTPUT, lines)
	}
}
export function warning(error) {
	console.log(
		`::warning::${String(error.message || error)
			.replaceAll('%', '%25')
			.replaceAll('\r', '%0D')
			.replaceAll('\n', '%0A')}`,
	)
}
