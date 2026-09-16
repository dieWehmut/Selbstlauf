import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexConfigProfiles } from "../src/codex/profile-store.js";

const SAMPLE = [
  'model = "deepseek-v4.1-flash"',
  'base_url = "https://external-api-platform.hkgai.net/v1"',
  '# base_url = "https://www.sevnx.lol"',
  '',
].join("\n") + "\n";

test("lists the active config plus every parked alternative", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-profiles-"));
  try {
    const configPath = join(root, "config.toml");
    await writeFile(configPath, SAMPLE, "utf8");
    const profiles = new CodexConfigProfiles({ configPath });
    const view = await profiles.describe();
    assert.equal(view.active.model, "deepseek-v4.1-flash");
    assert.equal(view.active.base_url, "https://external-api-platform.hkgai.net/v1");
    assert.deepEqual(view.alternatives.base_url, ["https://www.sevnx.lol"]);
    assert.equal(view.path, configPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applies a field set atomically and leaves a checksummed backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-profiles-apply-"));
  try {
    const configPath = join(root, "config.toml");
    await writeFile(configPath, SAMPLE, "utf8");
    const profiles = new CodexConfigProfiles({ configPath, now: () => 1_700_000_000_000 });
    const result = await profiles.apply([
      { key: "base_url", value: "https://www.sevnx.lol" },
    ]);
    assert.match(result.text, /^base_url = "https:/mu);
    assert.equal(result.text.includes('# base_url = "https://external-api-platform.hkgai.net/v1"'), true);
    assert.equal(await readFile(configPath, "utf8"), result.text);
    assert.equal(result.backupPath?.endsWith(".bak") === true, true);
    assert.equal(result.backupPath !== null && await readFile(result.backupPath, "utf8") === SAMPLE, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to apply into a missing config file", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-profiles-missing-"));
  try {
    const profiles = new CodexConfigProfiles({ configPath: join(root, "config.toml") });
    await assert.rejects(() => profiles.apply([{ key: "model", value: "x" }]), /config.toml/u);
    assert.deepEqual(await profiles.describe().then((view) => ({ exists: view.exists })), { exists: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes concurrent applies so the last write wins cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-profiles-race-"));
  try {
    const configPath = join(root, "config.toml");
    await mkdir(root, { recursive: true });
    await writeFile(configPath, SAMPLE, "utf8");
    const profiles = new CodexConfigProfiles({ configPath });
    await Promise.all([
      profiles.apply([{ key: "model", value: "a" }]),
      profiles.apply([{ key: "model", value: "b" }]),
    ]);
    const final = await profiles.describe();
    assert.equal(final.active.model, "b");
    assert.match(await readFile(configPath, "utf8"), /^model = "b"$/mu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
