import test from 'node:test'
import assert from 'node:assert/strict'
import { crc32 } from 'node:zlib'
import { GitHub, readProof, jobKey } from '../lib/proof.mjs'

function zip(entries) {
	const local = [],
		central = []
	let offset = 0
	for (const [path, text] of entries) {
		const name = Buffer.from(path),
			data = Buffer.from(text),
			checksum = crc32(data)
		const header = Buffer.alloc(30)
		header.writeUInt32LE(0x04034b50)
		header.writeUInt16LE(20, 4)
		header.writeUInt32LE(checksum, 14)
		header.writeUInt32LE(data.length, 18)
		header.writeUInt32LE(data.length, 22)
		header.writeUInt16LE(name.length, 26)
		local.push(header, name, data)
		const directory = Buffer.alloc(46)
		directory.writeUInt32LE(0x02014b50)
		directory.writeUInt16LE(20, 4)
		directory.writeUInt16LE(20, 6)
		directory.writeUInt32LE(checksum, 16)
		directory.writeUInt32LE(data.length, 20)
		directory.writeUInt32LE(data.length, 24)
		directory.writeUInt16LE(name.length, 28)
		directory.writeUInt32LE(offset, 42)
		central.push(directory, name)
		offset += header.length + name.length + data.length
	}
	const index = Buffer.concat(central),
		end = Buffer.alloc(22)
	end.writeUInt32LE(0x06054b50)
	end.writeUInt16LE(entries.length, 8)
	end.writeUInt16LE(entries.length, 10)
	end.writeUInt32LE(index.length, 12)
	end.writeUInt32LE(offset, 16)
	return Buffer.concat([...local, index, end])
}
test('reads a real ZIP fixture containing only proof.json', async () => {
	const bytes = zip([['proof.json', '{"schema":1}']])
	const api = { download: async () => bytes }
	assert.deepEqual(await readProof(api, 'acme/site', { id: 1 }), { schema: 1 })
})
test('rejects traversal paths, duplicate entries, corrupt ZIP, oversized archive and uncompressed JSON', async () => {
	for (const bytes of [
		zip([['../proof.json', '{}']]),
		zip([
			['proof.json', '{}'],
			['proof.json', '{}'],
		]),
		Buffer.from('not zip'),
		Buffer.alloc(131073),
		zip([['proof.json', ' '.repeat(65537)]]),
	]) {
		await assert.rejects(readProof({ download: async () => bytes }, 'acme/site', { id: 1 }))
	}
})
test('download follows signed redirects without sending token to storage host', async () => {
	const api = new GitHub('secret', {
		fetchImpl: async (url, options) => {
			if (new URL(url).hostname === 'api.github.com') {
				assert.equal(options.headers.Authorization, 'Bearer secret')
				assert.equal(options.redirect, 'manual')
				return new Response(null, { status: 302, headers: { location: 'https://storage.example.test/signed.zip' } })
			}
			assert.equal(url, 'https://storage.example.test/signed.zip')
			assert.equal(options.headers.Authorization, undefined)
			return new Response('zip')
		},
	})
	assert.equal((await api.download('/repos/acme/site/actions/artifacts/1/zip')).toString(), 'zip')
})
test('transport rejects HTTP errors, redirect to HTTP and bounded large response', async () => {
	for (const response of [
		new Response('', { status: 403 }),
		new Response(null, { status: 302, headers: { location: 'http://unsafe.test/file' } }),
		new Response('12345'),
	]) {
		const api = new GitHub('secret', { fetchImpl: async () => response })
		await assert.rejects(api.download('/test', { limit: 4 }))
	}
})
test('transport uses an abort signal and surfaces timeout as a failure', async () => {
	const api = new GitHub('secret', {
		timeoutMs: 5,
		fetchImpl: async (_url, { signal }) => {
			await new Promise((resolve, reject) => {
				const timer = setTimeout(resolve, 50)
				signal.addEventListener('abort', () => {
					clearTimeout(timer)
					reject(signal.reason)
				})
			})
			return new Response('{}')
		},
	})
	await assert.rejects(api.json('/test'), { name: 'TimeoutError' })
})
test('matrix canonicalizes nested keys and null but rejects invalid matrix JSON', () => {
	assert.equal(jobKey('check', '{"z":1,"a":{"z":2,"b":3}}'), 'check:{"a":{"b":3,"z":2},"z":1}')
	assert.equal(jobKey('check', 'null'), 'check:{}')
	assert.throws(() => jobKey('check', '[]'))
	assert.throws(() => jobKey('check', '{'))
})
