import { Plugin } from "@opencode/plugin"
import { OpenCode } from "@opencode/sdk"

export type Model = { providerID: string; id: string }
export type AgentRuntime = Awaited<ReturnType<typeof createAgentRuntime>>

export async function createAgentRuntime(directory: string, model: Model, instructions: Record<string, string>) {
  const host = await OpenCode.create({ plugins: [Plugin.define({
    id: "hospital-criterion-runtime",
    async setup(ctx) {
      await ctx.agent.transform(editor => {
        for (const [id, system] of Object.entries(instructions)) {
          // An explicit value is required: undefined falls back to the project's
          // steps: 1, which injects a maximum-steps summary on the first call.
          editor.update(id, agent => { agent.system = system; agent.steps = 2 })
        }
      })
      await ctx.session.hook("title", event => { event.result = "Hospital criterion task" })
      await ctx.session.hook("context", event => {
        const instruction = instructions[event.agent]
        if (!instruction) return
        event.system.splice(0, event.system.length, { type: "text", text: instruction })
        for (const name of Object.keys(event.tools)) delete event.tools[name]
        event.options.maxTokens = 2048
        event.options.temperature = 0
      })
    },
  })] })
  return {
    async ask(agent: string, text: string, onSession: (id: string) => Promise<void>) {
      if (!instructions[agent]) throw new Error("Agent is not registered for this run")
      const session = await host.sessions.create({ agent, model, location: { directory } })
      await onSession(session.id)
      await host.sessions.prompt({ sessionID: session.id, text })
      await host.experimental.session.wait({ sessionID: session.id })
      const answer = (await host.sessions.context({ sessionID: session.id })).filter(m => m.type === "assistant").at(-1)
      if (answer?.error) throw new Error(`${answer.error.type}: ${answer.error.message}`)
      const output = (answer?.content ?? []).filter(p => p.type === "text").map(p => p.text).join("\n")
      if (!output.trim()) throw new Error("Agent returned no text")
      return output
    },
    async [Symbol.asyncDispose]() { await host.close() },
  }
}
