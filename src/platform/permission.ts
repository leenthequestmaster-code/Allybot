import type { PermissionDecision, PermissionPort, PermissionRequest } from './contracts.js'

export type PermissionRule = (request: PermissionRequest) => PermissionDecision | undefined

export class PolicyPermissionEvaluator implements PermissionPort {
  private readonly rules: PermissionRule[] = []

  addRule(rule: PermissionRule): () => void {
    this.rules.push(rule)
    return () => {
      const index = this.rules.indexOf(rule)
      if (index >= 0) this.rules.splice(index, 1)
    }
  }

  evaluate(request: PermissionRequest): PermissionDecision {
    validatePermissionRequest(request)
    for (const rule of this.rules) {
      const decision = rule(request)
      if (decision !== undefined) return decision
    }
    return { allowed: false, reason: 'No permission policy matched', policy: 'default-deny' }
  }
}

function validatePermissionRequest(request: PermissionRequest): void {
  if (!request.subjectJid.trim()) throw new Error('Permission subjectJid must not be empty')
  if (!request.action.trim()) throw new Error('Permission action must not be empty')
  if (request.resourceJid !== undefined && !request.resourceJid.trim()) throw new Error('Permission resourceJid must not be empty')
}
