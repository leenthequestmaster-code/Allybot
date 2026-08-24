export function createFakeWhatsapp(overrides = {}) {
  const whatsapp = {
    isConnected: true,
    userJid: 'bot@s.whatsapp.net',
    sent: [],
    onMessage() { return () => {} },
    onGroupParticipantUpdate() { return () => {} },
    onConnectionState() { return () => {} },
    async sendText(remoteJid, text) { this.sent.push({ remoteJid, text }) },
    async start() {},
    async close() {},
    ...overrides,
  }
  return whatsapp
}
