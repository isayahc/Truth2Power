import { writeFile, rename } from "node:fs/promises"
import { join } from "node:path"

export type Task = {
  id: string; hospitalId: string; item: string; owner: string; executor: "agent" | "code"
  dependencies: string[]; status: "pending" | "running" | "succeeded" | "failed" | "blocked"
  sessionID?: string; startedAt?: string; finishedAt?: string; error?: string; result?: unknown
}

export class TaskGraph {
  readonly tasks: Task[] = []
  readonly hospitalId: string
  readonly directory: string
  constructor(hospitalId: string, directory: string) { this.hospitalId = hospitalId; this.directory = directory }

  add(id: string, owner: string, executor: Task["executor"], item: string, dependencies: string[] = []) {
    if (this.tasks.some(t => t.id === id)) throw new Error(`Duplicate task ${id}`)
    if (dependencies.some(id => !this.tasks.some(t => t.id === id))) throw new Error("Unknown task dependency")
    this.tasks.push({ id, hospitalId: this.hospitalId, item, owner, executor, dependencies, status: "pending" })
  }

  async checkpoint() {
    const path = join(this.directory, "tasks.json")
    await writeFile(`${path}.tmp`, JSON.stringify({ hospitalId: this.hospitalId, tasks: this.tasks }, null, 2))
    await rename(`${path}.tmp`, path)
  }

  async run<T>(id: string, action: (task: Task) => Promise<T>, tolerateFailedDependencies = false): Promise<T | undefined> {
    const task = this.tasks.find(t => t.id === id)
    if (!task || task.status !== "pending") throw new Error(`Task is not pending: ${id}`)
    const dependencies = task.dependencies.map(id => this.tasks.find(t => t.id === id)!)
    if (dependencies.some(t => t.status === "pending" || t.status === "running")) throw new Error("Dependencies have not finished")
    if (!tolerateFailedDependencies && dependencies.some(t => t.status !== "succeeded")) {
      task.status = "blocked"; task.error = "Required dependency failed"; task.finishedAt = new Date().toISOString()
      await this.checkpoint(); return undefined
    }
    task.status = "running"; task.startedAt = new Date().toISOString()
    await this.checkpoint()
    try {
      const result = await action(task)
      task.result = result; task.status = "succeeded"
      return result
    } catch (error) {
      task.status = "failed"; task.error = error instanceof Error ? error.message : "Task failed"
      return undefined
    } finally {
      task.finishedAt = new Date().toISOString()
      await this.checkpoint()
      console.log(JSON.stringify({ task: task.id, hospitalId: task.hospitalId, owner: task.owner, status: task.status }))
    }
  }
}
