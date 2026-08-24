import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const entrypoint = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

test('bootstrap keeps Economy and removes retired category plugin registrations', () => {
  assert.match(entrypoint, /framework\.registerPlugin\(economyPlugin\)/)
  assert.match(entrypoint, /framework\.registerPlugin\(createGroupContextPlugin\(whatsapp\)\)/)
  assert.match(entrypoint, /framework\.registerPlugin\(createCharacterGuidePlugin\(whatsapp\)\)/)
  assert.doesNotMatch(entrypoint, /createCollaborationPlugin|createEventPlugin|createAnnouncementPlugin/)
  assert.doesNotMatch(entrypoint, /framework\.registerPlugin\(onboardingPlugin\)/)
  assert.doesNotMatch(entrypoint, /framework\.registerPlugin\(createKnowledgePlugin\)/)
  assert.doesNotMatch(entrypoint, /framework\.registerPlugin\(createScenePlugin\)/)
  assert.doesNotMatch(entrypoint, /framework\.registerPlugin\(createCharacterPlugin\)/)
  assert.doesNotMatch(entrypoint, /framework\.registerPlugin\(createCanonPlugin\)/)
})

test('bootstrap preserves services required by the active Economy and Suggestion Relay paths', () => {
  assert.match(entrypoint, /new EconomyService\(/)
  assert.match(entrypoint, /new GroupContextService\(/)
  assert.match(entrypoint, /new CharacterGuideService\(/)
  assert.match(entrypoint, /new KnowledgeService\(/)
  assert.match(entrypoint, /new SceneService\(/)
  assert.match(entrypoint, /new SuggestionRelayService\(/)
  assert.doesNotMatch(entrypoint, /new CollaborationService\(/)
  assert.doesNotMatch(entrypoint, /new EventService\(/)
  assert.doesNotMatch(entrypoint, /new AnnouncementService\(/)
  assert.doesNotMatch(entrypoint, /new OnboardingService\(/)
  assert.doesNotMatch(entrypoint, /new CharacterService\(/)
  assert.doesNotMatch(entrypoint, /new CanonService\(/)
})
