import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import pino from "pino";
import { ApplicationFramework } from "../dist/framework/application.js";
import { menuPlugin } from "../dist/framework/plugins/menu.js";
import { groupPlugin } from "../dist/framework/plugins/group.js";
import { createGroupContextPlugin } from "../dist/framework/plugins/group-context.js";
import { createWelcomeLeavePlugin } from "../dist/framework/plugins/welcome-leave.js";
import { GroupContextService } from "../dist/services/group-context-service.js";
import { GroupConfigurationService } from "../dist/services/group-configuration-service.js";

const logger = pino({ level: "silent" });
const groupJid = "120363000000000000@g.us";

class MockCore {
  isConnected = true;
  userJid = "bot@s.whatsapp.net";
  sentMedia = [];
  participants = new Set();
  messages = new Set();
  connections = new Set();
  mode = "ooc";
  displayNames = new Map();

  onMessage(l) { this.messages.add(l); return () => this.messages.delete(l); }
  onGroupParticipantUpdate(l) { this.participants.add(l); return () => this.participants.delete(l); }
  onConnectionState(l) { this.connections.add(l); return () => this.connections.delete(l); }
  async sendText() {}
  async sendMedia(remoteJid, payload) { this.sentMedia.push({ remoteJid, payload }); }
  async getGroupMetadata(jid) { return { jid, subject: "Context Test", participants: [] }; }
  getDisplayName(jid) { return this.displayNames.get(jid); }
  async start() {}
  async close() {}
  async emitParticipants(event) { for (const l of [...this.participants]) await l(event); }
}

function createApp(core, databasePath) {
  const groupContext = new GroupContextService(logger, {
    env: { GROUP_CONTEXT_ENABLED: "false" },
  });
  const app = new ApplicationFramework({ commandPrefix: "!", defaultCooldownMs: 0 }, logger, core);
  app.registerService(new GroupConfigurationService(databasePath, logger));
  app.registerService(groupContext);
  app.registerPlugin(menuPlugin);
  app.registerPlugin(groupPlugin);
  app.registerPlugin(createGroupContextPlugin(core));
  app.registerPlugin(createWelcomeLeavePlugin(core));
  return app;
}

test("welcome card resolves cached display name from whatsapp.getDisplayName", async () => {
  const directory = mkdtempSync(join(tmpdir(), "allybot-welcome-names-"));
  const core = new MockCore();
  core.displayNames.set("628123456789@s.whatsapp.net", "Aria Moonlight");

  const app = createApp(core, join(directory, "core.sqlite"));
  try {
    await app.start();
    await core.emitParticipants({
      groupJid,
      groupName: "Allyssea RP",
      participantJids: ["628123456789@s.whatsapp.net"],
      action: "add",
      at: Date.now(),
    });

    assert.equal(core.sentMedia.length, 1);
    assert.equal(core.sentMedia[0].remoteJid, groupJid);
    assert.equal(core.sentMedia[0].payload.kind, "image");
    assert.ok(core.sentMedia[0].payload.data.length > 1000);
  } finally {
    await app.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
