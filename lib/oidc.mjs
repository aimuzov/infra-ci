import { createPublicKey, verify } from 'node:crypto'
import { isSha, requireValue } from './proof.mjs'

const ISSUER = 'https://token.actions.githubusercontent.com'
const AUDIENCE = 'aimuzov/infra-ci:verified-tree:v1'
const SAFE_FAILURES = new Set([
	'Invalid token',
	'Invalid JWT',
	'Unsupported JWT header',
	'Unknown signing key',
	'Invalid JWT signature',
	'Invalid issuer or audience',
	'Invalid repository claim',
	'Invalid repository ID claim',
	'Invalid run ID claim',
	'Invalid run attempt claim',
	'Invalid event claim',
	'Invalid commit claim',
	'Invalid workflow identity',
	'Reusable workflow commit differs',
	'Invalid token timestamps',
	'Token not-before differs from issuance',
	'Invalid token expiry',
	'Token was not issued during the PR run',
	'Token was not issued during the job',
	'Token is not current',
])

export class Oidc {
	constructor({ env = process.env, fetchImpl = fetch, signal, now = Date.now } = {}) {
		this.env = env
		this.fetch = fetchImpl
		this.signal = signal
		this.now = now
	}
	async json(url, headers = {}) {
		const signal = this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000)
		try {
			signal.throwIfAborted()
			const response = await this.fetch(url, { headers, redirect: 'error', signal })
			requireValue(response.ok, 'OIDC endpoint unavailable')
			const chunks = []
			let size = 0
			for await (const chunk of response.body) {
				signal.throwIfAborted()
				size += chunk.length
				requireValue(size <= 256 * 1024, 'OIDC response too large')
				chunks.push(chunk)
			}
			return JSON.parse(Buffer.concat(chunks).toString('utf8'))
		} catch {
			throw Object.assign(new Error('OIDC endpoint unavailable'), { apiFailure: true })
		}
	}
	async current(context) {
		requireValue(
			this.env.ACTIONS_ID_TOKEN_REQUEST_URL && this.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
			'OIDC is unavailable',
		)
		const url = new URL(this.env.ACTIONS_ID_TOKEN_REQUEST_URL)
		requireValue(
			url.protocol === 'https:' &&
				url.hostname.endsWith('.actions.githubusercontent.com') &&
				!url.username &&
				!url.password,
			'Unsafe OIDC endpoint',
		)
		url.searchParams.set('audience', AUDIENCE)
		const result = await this.json(url.href, { Authorization: `Bearer ${this.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` })
		const identity = await this.validate(result.value, context)
		return { token: result.value, ...identity }
	}
	async historical(token, context, proof, run, job) {
		const identity = await this.validate(
			token,
			{
				...context,
				sha: proof.checked_commit,
				runId: run.id,
				runAttempt: 1,
				eventName: 'pull_request',
				ref: undefined,
			},
			{ run, job },
		)
		requireValue(proof.workflow_ref === identity.workflowRef, 'Proof workflow identity mismatch')
		return identity
	}
	async validate(token, expected, historical) {
		try {
			this.signal?.throwIfAborted()
			requireValue(typeof token === 'string' && Buffer.byteLength(token) <= 32 * 1024, 'Invalid token')
			const parts = token.split('.')
			requireValue(parts.length === 3 && parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part)), 'Invalid JWT')
			const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
			const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
			requireValue(
				header.alg === 'RS256' && typeof header.kid === 'string' && header.kid.length <= 128 && !header.crit,
				'Unsupported JWT header',
			)
			this.keys ??= await this.json(ISSUER + '/.well-known/jwks')
			const matches = this.keys.keys?.filter(
				(key) =>
					key.kid === header.kid &&
					key.kty === 'RSA' &&
					(!key.alg || key.alg === 'RS256') &&
					(!key.use || key.use === 'sig') &&
					(!key.key_ops || key.key_ops.includes('verify')),
			)
			requireValue(matches?.length === 1, 'Unknown signing key')
			const key = createPublicKey({ key: matches[0], format: 'jwk' })
			requireValue(
				key.asymmetricKeyDetails.modulusLength >= 2048 &&
					verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url')),
				'Invalid JWT signature',
			)
			requireValue(claims.iss === ISSUER && claims.aud === AUDIENCE, 'Invalid issuer or audience')
			requireValue(claims.repository === expected.repository, 'Invalid repository claim')
			requireValue(claims.repository_id === String(expected.repositoryId), 'Invalid repository ID claim')
			requireValue(claims.run_id === String(expected.runId), 'Invalid run ID claim')
			requireValue(claims.run_attempt === String(expected.runAttempt), 'Invalid run attempt claim')
			requireValue(claims.event_name === expected.eventName, 'Invalid event claim')
			requireValue(isSha(claims.sha) && claims.sha === expected.sha, 'Invalid commit claim')

			const workflowRef = claims.job_workflow_ref ?? claims.workflow_ref
			requireValue(
				typeof workflowRef === 'string' &&
					workflowRef.startsWith(`${expected.repository}/${expected.workflow}@`) &&
					workflowRef.length > `${expected.repository}/${expected.workflow}@`.length,
				'Invalid workflow identity',
			)
			if (claims.job_workflow_ref !== undefined)
				requireValue(claims.job_workflow_sha === expected.sha, 'Reusable workflow commit differs')
			requireValue(
				[claims.iat, claims.nbf, claims.exp].every((value) => Number.isSafeInteger(value) && value > 0),
				'Invalid token timestamps',
			)
			requireValue(claims.nbf <= claims.iat, 'Token not-before differs from issuance')
			requireValue(claims.exp > claims.iat && claims.exp - claims.iat <= 3600, 'Invalid token expiry')

			if (historical) {
				const start = Date.parse(historical.run.created_at) / 1000,
					end = Date.parse(historical.run.updated_at) / 1000
				requireValue(
					Number.isFinite(start) &&
						Number.isFinite(end) &&
						start <= claims.iat &&
						claims.iat <= end &&
						/^refs\/pull\/[1-9][0-9]*\/merge$/.test(claims.ref),
					'Token was not issued during the PR run',
				)
				if (historical.job) {
					const started = Date.parse(historical.job.started_at) / 1000,
						completed = Date.parse(historical.job.completed_at) / 1000
					requireValue(
						Number.isFinite(started) && Number.isFinite(completed) && started <= claims.iat && claims.iat <= completed,
						'Token was not issued during the job',
					)
				}
			} else {
				const now = this.now() / 1000
				requireValue(
					claims.iat <= now + 30 && claims.nbf <= now + 30 && claims.exp > now && claims.ref === expected.ref,
					'Token is not current',
				)
			}
			this.signal?.throwIfAborted()
			return { claims, workflowRef }
		} catch (error) {
			if (error.apiFailure) throw error
			throw new Error(
				SAFE_FAILURES.has(error.message) ? 'OIDC verification failed: ' + error.message : 'OIDC verification failed',
			)
		}
	}
}
