import { generateKeyPairSync, sign } from 'node:crypto'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
export const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' }
export const audience = 'aimuzov/infra-ci:verified-tree:v1'
export function claims(overrides = {}) {
	const now = Math.floor(Date.now() / 1000)
	return {
		iss: 'https://token.actions.githubusercontent.com',
		aud: audience,
		iat: now - 5,
		nbf: now - 5,
		exp: now + 300,
		repository_id: '7',
		repository: 'acme/site',
		run_id: '20',
		run_attempt: '1',
		event_name: 'push',
		sha: 'a'.repeat(40),
		ref: 'refs/heads/main',
		workflow_ref: 'acme/site/.github/workflows/check.yml@refs/heads/main',
		...overrides,
	}
}
export function token(payload = claims(), key = privateKey, header = {}) {
	const first = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture-key', typ: 'JWT', ...header })).toString(
		'base64url',
	)
	const second = Buffer.from(JSON.stringify(payload)).toString('base64url')
	const signature = sign('RSA-SHA256', Buffer.from(first + '.' + second), key).toString('base64url')
	return first + '.' + second + '.' + signature
}
export function oidcOptions(payload = claims(), overrides = {}) {
	return {
		env: {
			ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/token?api-version=2',
			ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-request-secret',
		},
		fetchImpl: async (url) =>
			url.startsWith('https://token.actions.githubusercontent.com/')
				? new Response(JSON.stringify({ keys: [jwk] }))
				: new Response(JSON.stringify({ value: token(payload) })),
		...overrides,
	}
}
