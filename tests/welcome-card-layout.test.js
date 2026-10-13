import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { readFileSync } from 'node:fs'
import { VisualCardService } from '../dist/services/visual-card-service.js'

test('leave title stays clear of the canvas bottom edge', async () => {
  const png = await VisualCardService.renderWelcomeCard({ type: 'leave', userName: 'Cyrus', groupName: 'Test group' })
  const strip = await sharp(png).extract({ left: 0, top: 601, width: 155, height: 10 }).removeAlpha().raw().toBuffer()
  assert.ok(strip.every(value => value > 200), 'FAREWELL must have a bottom safe margin, not clipped black glyphs')
})

const solidAvatar = () => sharp({ create: {
  width: 400, height: 400, channels: 4, background: '#ff0000',
} }).png().toBuffer()

for (const type of ['welcome', 'leave']) {
  test(`${type} photo fills the tilted slot without covering footer controls`, async () => {
    const png = await VisualCardService.renderWelcomeCard({
      type, userName: 'Cyrus', groupName: 'Test group', avatarBuffer: await solidAvatar(),
    })
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const pixel = (x, y) => Array.from(data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4))
    for (const [x, y] of [[410, 420], [440, 170], [695, 205], [660, 463], [550, 300]]) {
      assert.deepEqual(pixel(x, y), [255, 0, 0, 255], `photo must fill slot at ${x},${y}`)
    }
    const footer = { left: 405, top: 476, width: 95, height: 44 }
    const original = await sharp(readFileSync(`assets/${type}-template.png`)).extract(footer).ensureAlpha().raw().toBuffer()
    const actual = await sharp(png).extract(footer).ensureAlpha().raw().toBuffer()
    assert.ok(actual.equals(original), 'photo must preserve the heart/comment controls')
    assert.equal(info.width, 1024)
    assert.equal(info.height, 611)
  })
}
