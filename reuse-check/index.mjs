import { GitHub, outputs, readContext, warning } from '../lib/proof.mjs'
import { reuseCheck } from '../lib/reuse.mjs'

let result = { reused: false, reason: 'Could not evaluate CI proof' }
try {
	result = await reuseCheck(
		await readContext(),
		new GitHub(process.env.INPUT_TOKEN, { apiUrl: process.env.GITHUB_API_URL }),
	)
} catch (error) {
	warning(error)
}
await outputs({ reused: String(result.reused), 'run-url': result.runUrl || '', reason: result.reason })
console.log(`CI reuse: ${result.reused ? 'yes' : 'no'} (${result.reason})`)
