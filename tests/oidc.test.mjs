import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { Oidc } from '../lib/oidc.mjs'
import { claims, token, oidcOptions } from './oidc-fixtures.mjs'
const expected = {
	repository: 'acme/site',
	repositoryId: 7,
	runId: 20,
	runAttempt: 1,
	eventName: 'push',
	sha: 'a'.repeat(40),
	ref: 'refs/heads/main',
	workflow: '.github/workflows/check.yml',
}

test('verifies the actual RSA signature and current OIDC workflow identity', async () => {
	const oidc = new Oidc(oidcOptions())
	const identity = await oidc.current(expected)
	assert.equal(identity?.workflowRef, 'acme/site/.github/workflows/check.yml@refs/heads/main')
	assert.equal(identity?.token.split('.').length, 3)
})
test('uses authoritative reusable workflow identity instead of caller workflow', async () => {
	const payload = claims({
		workflow_ref: 'acme/site/.github/workflows/deploy.yml@refs/heads/main',
		job_workflow_ref: 'acme/site/.github/workflows/check.yml@refs/heads/main',
		job_workflow_sha: expected.sha,
	})
	assert.ok(await new Oidc(oidcOptions(payload)).current(expected))
})
test('rejects wrong signer, alg, audience, issuer, repository, run, workflow, SHA and expiry', async () => {
	const wrongKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
	const bad = [
		token(claims(), wrongKey),
		token(claims(), undefined, { alg: 'HS256' }),
		...[
			{ aud: 'other' },
			{ iss: 'https://evil.test' },
			{ repository_id: '8' },
			{ run_id: '10' },
			{ run_attempt: '2' },
			{ workflow_ref: 'acme/site/.github/workflows/deploy.yml@refs/heads/main' },
			{ sha: 'b'.repeat(40) },
			{ exp: 1 },
			{ workflow_ref: undefined },
			{ event_name: 'pull_request' },
			{ ref: 'refs/heads/other' },
			{ nbf: 0 },
			{ exp: Math.floor(Date.now() / 1000) + 7200 },
			{ job_workflow_ref: 'acme/site/.github/workflows/check.yml@refs/heads/main', job_workflow_sha: 'b'.repeat(40) },
		].map((change) => token(claims(change))),
	]
	for (const value of bad) {
		const options = oidcOptions()
		const fetchOriginal = options.fetchImpl
		options.fetchImpl = async (url) =>
			url.startsWith('https://token.actions.githubusercontent.com/')
				? fetchOriginal(url)
				: new Response(JSON.stringify({ value }))
		await assert.rejects(new Oidc(options).current(expected))
	}
})
test('historical signed JWT can be expired now but must have been issued during the source run', async () => {
	const iat = 1700000000
	const payload = claims({
		run_id: '10',
		event_name: 'pull_request',
		sha: 'c'.repeat(40),
		ref: 'refs/pull/1/merge',
		workflow_ref: 'acme/site/.github/workflows/check.yml@refs/pull/1/merge',
		iat,
		nbf: iat - 5,
		exp: iat + 300,
	})
	const run = {
		id: 10,
		run_attempt: 1,
		created_at: new Date((iat - 10) * 1000).toISOString(),
		updated_at: new Date((iat + 30) * 1000).toISOString(),
	}
	const proof = { checked_commit: payload.sha, workflow_ref: payload.workflow_ref }
	const oidc = new Oidc(oidcOptions())
	assert.ok(await oidc.historical(token(payload), expected, proof, run))
	await assert.rejects(
		oidc.historical(token({ ...payload, iat: iat + 100, nbf: iat + 100, exp: iat + 400 }), expected, proof, run),
	)
})
test('missing OIDC capability and unknown key fail closed', async () => {
	await assert.rejects(new Oidc({ env: {} }).current(expected))
	const options = oidcOptions()
	const fetchOriginal = options.fetchImpl
	options.fetchImpl = async (url) =>
		url.startsWith('https://token.actions.githubusercontent.com/')
			? new Response(JSON.stringify({ keys: [] }))
			: fetchOriginal(url)
	await assert.rejects(new Oidc(options).current(expected))
})
test('OIDC audience and request credentials are sent only to the GitHub OIDC endpoint', async () => {
	const options = oidcOptions(),
		fetchOriginal = options.fetchImpl
	options.fetchImpl = async (url, request) => {
		if (url.startsWith('https://pipelines.actions.githubusercontent.com/')) {
			assert.equal(new URL(url).searchParams.get('audience'), 'aimuzov/infra-ci:verified-tree:v1')
			assert.equal(request.headers.Authorization, 'Bearer oidc-request-secret')
		} else assert.equal(request.headers?.Authorization, undefined)
		return fetchOriginal(url)
	}
	assert.ok(await new Oidc(options).current(expected))
})

test('rejects oversized JWT and never loads keys from untrusted JWT header URLs', async () => {
	const oversized = oidcOptions(),
		fetchOriginal = oversized.fetchImpl
	oversized.fetchImpl = async (url) =>
		url.startsWith('https://token.actions.githubusercontent.com/')
			? fetchOriginal(url)
			: new Response(JSON.stringify({ value: 'x'.repeat(32769) }))
	await assert.rejects(new Oidc(oversized).current(expected))
	const options = oidcOptions(),
		original = options.fetchImpl
	options.fetchImpl = async (url) => {
		assert.ok(
			url.startsWith('https://token.actions.githubusercontent.com/') ||
				url.startsWith('https://pipelines.actions.githubusercontent.com/'),
		)
		return url.startsWith('https://token.actions.githubusercontent.com/')
			? original(url)
			: new Response(JSON.stringify({ value: token(claims(), undefined, { jku: 'https://evil.test/jwks' }) }))
	}
	assert.ok(await new Oidc(options).current(expected))
})

test('reports only safe static OIDC validation reasons and redacts malformed token content', async () => {
	const oidc = new Oidc(oidcOptions())
	const sensitive = 'token-secret-do-not-log'
	await assert.rejects(
		oidc.validate(token(claims({ aud: sensitive })), expected),
		(error) =>
			error.message === 'OIDC verification failed: Invalid issuer or audience' && !error.message.includes(sensitive),
	)
	const malformed = Buffer.from('{"secret":"' + sensitive + '" invalid}').toString('base64url')
	await assert.rejects(
		oidc.validate(malformed + '.' + malformed + '.abc', expected),
		(error) => error.message === 'OIDC verification failed' && !error.message.includes(sensitive),
	)
})

test('accepts GitHub backdated not-before while rejecting not-before after issuance', async () => {
	const payload = claims()
	assert.ok(await new Oidc(oidcOptions({ ...payload, nbf: payload.iat - 300 })).current(expected))
	await assert.rejects(new Oidc(oidcOptions({ ...payload, nbf: payload.iat + 1 })).current(expected))
})
