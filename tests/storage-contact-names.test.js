import test from "node:test";
import assert from "node:assert/strict";
import { SqliteStorage } from "../dist/storage.js";
import { mkdirSync, rmSync } from "node:fs";

const testDir = "./data/test-storage-names";
rmSync(testDir, { recursive: true, force: true });
mkdirSync(testDir, { recursive: true });

const config = {
  DATABASE_PATH: `${testDir}/test.sqlite`,
  ACCOUNT_ID: "test",
  LOCAL_MESSAGE_CACHE_TTL_MS: 3600000,
  LOCAL_MESSAGE_CACHE_MAX_BYTES: 1048576,
  LOCAL_MESSAGE_CACHE_MAX_ROWS: 1000,
};
const logger = {
  child: () => logger,
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

test("SqliteStorage contact names caching and normalization", () => {
  const storage = new SqliteStorage(config, logger);

  // 1. Save and retrieve
  storage.saveContactName("628123456789:0@s.whatsapp.net", "Cyrus The Great");
  assert.equal(storage.getContactName("628123456789@s.whatsapp.net"), "Cyrus The Great");

  // 2. Reject phone number as display name
  storage.saveContactName("628999999999@s.whatsapp.net", "+62 899-9999-999");
  assert.equal(storage.getContactName("628999999999@s.whatsapp.net"), undefined);

  // 3. Trim and length limit
  storage.saveContactName("628111111111@s.whatsapp.net", "   A very long name ".padEnd(70, "x"));
  const fetched = storage.getContactName("628111111111@s.whatsapp.net");
  assert.ok(fetched);
  assert.ok(fetched.length <= 50);

  storage.close();
  rmSync(testDir, { recursive: true, force: true });
});
