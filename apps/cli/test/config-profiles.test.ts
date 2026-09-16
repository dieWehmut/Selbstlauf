import test from "node:test";
import assert from "node:assert/strict";

import {
  applyProfile,
  captureActiveProfile,
  readConfigSummary,
} from "../src/codex/config-profiles.js";

const SAMPLE = [
  '# model = "gpt-6-astra"',
  '# review_model = "gpt-6-astra"',
  '# model_reasoning_effort = "ultra"',
  'model = "deepseek-v4.1-flash"',
  'review_model = "deepseek-v4.1-flash"',
  'model_reasoning_effort = "max"',
  '# experimental_bearer_token = "sk-xx" # https://www.sevnx.lol',
  '# experimental_bearer_token = "sk-xx" # dieWehmut agentrouter',
  'experimental_bearer_token = "sk-xx" # https://external-api-platform.hkgai.net/v1',
  '# base_url = "https://www.sevnx.lol"',
  '# base_url = "https://agentrouter.org/v1"',
  'base_url = "https://external-api-platform.hkgai.net/v1"',
  "",
  '[projects."D:\\work"]',
  'trust_level = "trusted"',
].join("\n");

test("reads active assignments and parked alternatives from config.toml", () => {
  const summary = readConfigSummary(SAMPLE);
  assert.equal(summary.active.model, "deepseek-v4.1-flash");
  assert.equal(summary.active.base_url, "https://external-api-platform.hkgai.net/v1");
  assert.deepEqual(summary.commented.base_url, ["https://www.sevnx.lol", "https://agentrouter.org/v1"]);
  assert.equal(summary.commented.model_reasoning_effort?.[0], "ultra");
  assert.equal(summary.active.trust_level, undefined);
});

test("applies a profile in place and parks the replaced value as a comment", () => {
  const result = applyProfile(SAMPLE, [
    { key: "model", value: "gpt-6-astra" },
    { key: "review_model", value: "gpt-6-astra" },
    { key: "model_reasoning_effort", value: "ultra" },
    { key: "base_url", value: "https://www.sevnx.lol" },
    { key: "experimental_bearer_token", value: "sk-new" },
  ]);
  assert.match(result.text, /^model = "gpt-6-astra"$/mu);
  assert.match(result.text, /^base_url = "https:\/\/www\.sevnx\.lol"$/mu);
  assert.match(result.text, /^experimental_bearer_token = "sk-new"$/mu);
  assert.equal(result.text.includes('# model = "gpt-6-astra"'), false);
  assert.match(result.text, /^# model = "deepseek-v4\.1-flash"$/mu);
  assert.match(result.text, /^# base_url = "https:\/\/external-api-platform\.hkgai\.net\/v1"$/mu);
  assert.equal(result.text.includes('[projects."D:\\work"]'), true);
  assert.equal(result.text.includes('trust_level = "trusted"'), true);
  assert.deepEqual(result.changes.map((change) => `${change.action}:${change.key}`), [
    "uncommented:model",
    "uncommented:review_model",
    "uncommented:model_reasoning_effort",
    'uncommented:base_url',
    'set:experimental_bearer_token',
  ]);
});

test("appends keys that are absent and keeps the original line endings", () => {
  const crlf = 'model = "a"\r\n';
  const result = applyProfile(crlf, [{ key: "base_url", value: "https://example.test/v1" }]);
  assert.equal(result.text, 'model = "a"\r\nbase_url = "https://example.test/v1"\r\n');
  assert.deepEqual(result.changes, [{ key: "base_url", action: "added", value: "https://example.test/v1" }]);
});

test("rejects unsupported keys and multiline values", () => {
  assert.throws(() => applyProfile(SAMPLE, [{ key: "approval_policy", value: "never" }]), /unsupported Codex config key/u);
  assert.throws(() => applyProfile(SAMPLE, [{ key: "model", value: "a\nb" }]), /invalid value/u);
  assert.throws(() => applyProfile(SAMPLE, [{ key: "model", value: "  " }]), /invalid value/u);
});

test("captures the active configuration as a named profile", () => {
  const profile = captureActiveProfile(SAMPLE);
  assert.equal(profile.name, "external-api-platform.hkgai.net");
  assert.deepEqual(profile.fields, [
    { key: "model", value: "deepseek-v4.1-flash" },
    { key: "review_model", value: "deepseek-v4.1-flash" },
    { key: "model_reasoning_effort", value: "max" },
    { key: "experimental_bearer_token", value: "sk-xx" },
    { key: "base_url", value: "https://external-api-platform.hkgai.net/v1" },
  ]);
});

test("does not duplicate a parked comment that already exists", () => {
  const result = applyProfile(SAMPLE, [{ key: "base_url", value: "https://www.sevnx.lol" }]);
  const parked = result.text.split("\n").filter((line: string) => line === '# base_url = "https://external-api-platform.hkgai.net/v1"');
  const active = result.text.split("\n").filter((line: string) => line === 'base_url = "https://www.sevnx.lol"');
  assert.equal(parked.length, 1);
  assert.equal(active.length, 1);
});

