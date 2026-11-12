import { loadEnvFile } from "node:process"
import { fileURLToPath } from "node:url"

const projectDirectory = fileURLToPath(new URL("../", import.meta.url))
loadEnvFile(new URL("../.env", import.meta.url))

if (!process.env.OPENROUTER_API_KEY?.trim()) {
  throw new Error("OPENROUTER_API_KEY is required in the environment or project .env")
}

// Initialize the SDK only after the OpenRouter key is available.
const { OpenCode } = await import("@opencode/sdk")

await using opencode = await OpenCode.create()
const session = await opencode.sessions.create({
  location: { directory: projectDirectory },
  model: {
    providerID: "openrouter",
    id: "amazon/nova-lite-v1",
  },
})

await opencode.sessions.prompt({
  sessionID: session.id,
  text: 'Do not use tools or inspect any files. What is 2 + 2? Reply with only the digit 4.',
})

await opencode.experimental.session.wait({ sessionID: session.id })

const messages = await opencode.sessions.context({ sessionID: session.id })
const replies = messages.filter(message => message.type === "assistant")
const output = replies
  .flatMap(message => message.content)
  .filter(part => part.type === "text")
  .map(part => part.text)
  .join("\n\n")

const passed = output.trim() === "4"
console.log(JSON.stringify({ sessionID: session.id, passed, replies: replies.length, outputCharacters: output.length }))
if (!passed) process.exitCode = 1

// Inspect output and replies in VS Code without logging full model responses.
debugger
