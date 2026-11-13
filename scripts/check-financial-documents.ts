import { loadEnvFile } from "node:process"
import { fileURLToPath } from "node:url"

const projectDirectory = fileURLToPath(new URL("../", import.meta.url))
loadEnvFile(new URL("../.env", import.meta.url))

if (!process.env.AWS_BEARER_TOKEN_BEDROCK?.trim()) {
  throw new Error("AWS_BEARER_TOKEN_BEDROCK is required in the environment or project .env")
}

// Initialize the SDK only after the Bedrock token is available.
const { OpenCode } = await import("@opencode/sdk")

await using opencode = await OpenCode.create()
const session = await opencode.sessions.create({
  location: { directory: projectDirectory },
  model: {
    providerID: "amazon-bedrock",
    id: "us.amazon.nova-lite-v1:0",
  },
})

await opencode.sessions.prompt({
  sessionID: session.id,
  text: "Review the current changes",
})

// prompt() queues the request; wait for execution before reading the response.
await opencode.experimental.session.wait({ sessionID: session.id })

const messages = await opencode.sessions.context({ sessionID: session.id })
const replies = messages.filter(message => message.type === "assistant")
const output = replies
  .flatMap(message => message.content)
  .filter(part => part.type === "text")
  .map(part => part.text)
  .join("\n\n")

console.log(JSON.stringify({ sessionID: session.id, replies: replies.length, outputCharacters: output.length }))
// Inspect output and replies in VS Code without logging full model responses.
debugger
