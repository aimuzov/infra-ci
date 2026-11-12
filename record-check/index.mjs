import { GitHub, outputs, readContext, warning } from '../lib/proof.mjs'
import { recordCheck } from '../lib/record.mjs'

let result
try {
	result = await recordCheck(
		await readContext(),
		new GitHub(process.env.INPUT_TOKEN, { apiUrl: process.env.GITHUB_API_URL }),
		{ onError: warning },
	)
} catch (error) {
	warning(error)
}
await outputs({ path: result?.path || '', 'artifact-name': result?.artifactName || '' })
