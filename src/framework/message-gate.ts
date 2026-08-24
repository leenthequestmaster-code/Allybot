import type { CoreMessage, MessageGate, MessageGateRegistryLike, MessageGateResult } from './contracts.js'

export class MessageGateRegistry implements MessageGateRegistryLike {
  private readonly gates = new Map<string, MessageGate>()

  register(name: string, gate: MessageGate): () => void {
    const normalized = name.trim()
    if (!/^[a-z][a-z0-9_-]{1,63}$/u.test(normalized)) throw new Error(`Invalid message gate name: ${name}`)
    if (this.gates.has(normalized)) throw new Error(`Message gate already registered: ${normalized}`)
    this.gates.set(normalized, gate)
    return () => this.gates.delete(normalized)
  }

  async evaluate(message: CoreMessage): Promise<MessageGateResult> {
    for (const gate of this.gates.values()) {
      try {
        const result = await gate(message)
        if (!result.allowed) return result
      } catch {
        return { allowed: false, reason: 'message_gate_failed' }
      }
    }
    return { allowed: true }
  }

  list(): readonly string[] {
    return [...this.gates.keys()]
  }
}
