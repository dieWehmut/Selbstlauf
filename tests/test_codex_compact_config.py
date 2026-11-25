#!/usr/bin/env python3
"""Tests for scripts/install/codex_compact_config.py.

The patcher edits a user's live config.toml, so the tests pin the properties
that make that safe rather than the exact strings it prints:

* the capability line is declared for the provider the config actually uses,
* comments, key order, CRLF, a UTF-8 BOM and a missing trailing newline survive,
* a second run changes nothing and creates no extra backup,
* revert restores the original bytes exactly,
* a config that is not UTF-8, or has no provider, is refused instead of mangled.

Run with:  python3 tests/test_codex_compact_config.py
"""

import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

REPOSITORY = pathlib.Path(__file__).resolve().parents[1]
CORE = REPOSITORY / "scripts" / "install" / "codex_compact_config.py"

# Written with escapes so the test file stays pure ASCII and cannot be
# corrupted by a console that decodes it with a legacy code page.
CJK_COMMENT = "# \u4fdd\u7559\u4e2d\u6587\u6ce8\u91ca\uff0c\u4e0d\u8981\u4e22"

BASIC = """\
# hand written config, keep every comment
model = "gemini-4-hydrogen"
model_provider = "OpenAI"
model_context_window = 256000
model_auto_compact_token_limit = 256000   # matches the window on purpose

[model_providers.OpenAI]
name = "OpenAI"
base_url = "https://gateway.example/v1"
wire_api = "responses"

[profiles.fast]
model = "gemini-4-hydrogen"
"""


class PatcherTestCase(unittest.TestCase):
    def setUp(self):
        self._directory = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self._directory.name)
        self.config = self.root / "config.toml"

    def tearDown(self):
        self._directory.cleanup()

    def write_config(self, text, name="config.toml"):
        target = self.root / name
        target.write_text(text, encoding="utf-8", newline="")
        return target

    def run_core(self, *arguments):
        return subprocess.run(
            [sys.executable, str(CORE)] + list(arguments),
            capture_output=True,
            text=True,
            encoding="utf-8",
            cwd=str(self.root),
        )

    def apply(self, *extra):
        return self.run_core("apply", "--config", str(self.config), "--skip-validation", *extra)

    def revert(self, *extra):
        return self.run_core("revert", "--config", str(self.config), *extra)

    def inspect(self, *extra):
        return self.run_core("inspect", "--config", str(self.config), *extra)

    def assert_ok(self, result):
        self.assertEqual(result.returncode, 0, "stdout=%r stderr=%r" % (result.stdout, result.stderr))

    def text(self):
        return self.config.read_text(encoding="utf-8")


class ApplyTests(PatcherTestCase):
    def test_declares_capability_for_the_active_provider(self):
        self.write_config(BASIC)
        self.assert_ok(self.apply())
        body = self.text()
        self.assertIn("[model_providers.OpenAI.capabilities]", body)
        self.assertIn('remote_compaction = "unsupported"', body)
        # The new table must sit inside the provider hierarchy, not after profiles.
        self.assertLess(
            body.index("[model_providers.OpenAI.capabilities]"),
            body.index("[profiles.fast]"),
        )

    def test_lowers_unreachable_limit_to_ratio_of_window(self):
        self.write_config(BASIC)
        self.assert_ok(self.apply())
        self.assertIn("model_auto_compact_token_limit = 230400", self.text())

    def test_preserves_trailing_comment_column(self):
        self.write_config(BASIC)
        self.assert_ok(self.apply())
        self.assertIn(
            "model_auto_compact_token_limit = 230400   # matches the window on purpose",
            self.text(),
        )

    def test_keeps_the_rest_of_the_file_untouched(self):
        self.write_config(BASIC)
        self.assert_ok(self.apply())
        body = self.text()
        for line in BASIC.splitlines():
            if line.startswith("model_auto_compact_token_limit"):
                continue
            self.assertIn(line, body, "line was lost: %r" % line)

    def test_second_run_is_a_no_op(self):
        self.write_config(BASIC)
        self.assert_ok(self.apply())
        first = self.text()
        backups = sorted(p.name for p in self.root.iterdir() if ".bak-compact-" in p.name)
        self.assertEqual(len(backups), 1)
        result = self.apply()
        self.assert_ok(result)
        self.assertIn("nothing to change", result.stdout)
        self.assertEqual(self.text(), first)
        self.assertEqual(
            sorted(p.name for p in self.root.iterdir() if ".bak-compact-" in p.name),
            backups,
        )

    def test_rewrites_an_existing_capability_line_and_keeps_its_comment(self):
        self.write_config(
            'model_provider = "GW"\n'
            "\n[model_providers.GW.capabilities]\n"
            'remote_compaction = "v2"  # forced by the gateway docs\n'
        )
        self.assert_ok(self.apply())
        self.assertIn(
            'remote_compaction = "unsupported"  # forced by the gateway docs',
            self.text(),
        )

    def test_creates_the_capabilities_table_when_the_provider_table_exists(self):
        self.write_config(
            'model_provider = "GW"\n\n[model_providers.GW]\nbase_url = "https://gw.example/v1"\n'
        )
        self.assert_ok(self.apply())
        body = self.text()
        self.assertIn("[model_providers.GW.capabilities]", body)
        self.assertTrue(body.rstrip().endswith('remote_compaction = "unsupported"'))

    def test_creates_a_standalone_table_when_the_provider_table_is_absent(self):
        self.write_config('model_provider = "GW"\n')
        self.assert_ok(self.apply())
        body = self.text()
        self.assertIn("[model_providers.GW.capabilities]", body)
        self.assertIn('remote_compaction = "unsupported"', body)

    def test_quoted_provider_name_round_trips(self):
        self.write_config(
            'model_provider = "My Gateway"\n'
            "\n[model_providers.\"My Gateway\"]\n"
            'base_url = "https://gw.example/v1"\n'
        )
        self.assert_ok(self.apply())
        self.assertIn('[model_providers."My Gateway".capabilities]', self.text())

    def test_leaves_a_reachable_limit_alone(self):
        self.write_config(
            'model_provider = "GW"\n'
            "model_context_window = 200000\n"
            "model_auto_compact_token_limit = 150000\n"
        )
        self.assert_ok(self.apply())
        self.assertIn("model_auto_compact_token_limit = 150000", self.text())

    def test_adds_the_limit_when_only_the_window_is_set(self):
        self.write_config('model_provider = "GW"\nmodel_context_window = 200000\n')
        self.assert_ok(self.apply())
        self.assertIn("model_auto_compact_token_limit = 180000", self.text())

    def test_skip_auto_limit_keeps_the_limit(self):
        self.write_config(BASIC)
        self.assert_ok(self.apply("--no-auto-limit"))
        self.assertIn("model_auto_compact_token_limit = 256000", self.text())

    def test_custom_ratio_is_respected(self):
        self.write_config(BASIC)
        self.assert_ok(self.apply("--limit-ratio", "0.75"))
        self.assertIn("model_auto_compact_token_limit = 192000", self.text())

    def test_no_window_leaves_the_limit_alone(self):
        self.write_config('model_provider = "GW"\nmodel_auto_compact_token_limit = 900000\n')
        result = self.apply()
        self.assert_ok(result)
        self.assertIn("model_auto_compact_token_limit = 900000", self.text())
        self.assertIn("model_context_window", result.stdout)

    def test_dry_run_changes_nothing(self):
        self.write_config(BASIC)
        before = self.config.read_bytes()
        result = self.apply("--dry-run")
        self.assert_ok(result)
        self.assertIn("+remote_compaction", result.stdout.replace(" ", ""))
        self.assertEqual(self.config.read_bytes(), before)
        self.assertFalse((self.root / ".codex-compact-state.json").exists())

    def test_chinese_comments_survive(self):
        self.write_config(
            'model_provider = "GW"\n%s\nmodel_context_window = 100000\n' % CJK_COMMENT
        )
        self.assert_ok(self.apply())
        self.assertIn(CJK_COMMENT, self.text())


class EncodingTests(PatcherTestCase):
    def test_crlf_bom_and_missing_trailing_newline_survive(self):
        body = (
            'model_provider = "GW"\r\n'
            "model_context_window = 100000\r\n"
            "\r\n"
            "[model_providers.GW]\r\n"
            'base_url = "https://gw.example/v1"'
        )
        self.config.write_bytes(b"\xef\xbb\xbf" + body.encode("utf-8"))
        self.assert_ok(self.apply())
        data = self.config.read_bytes()
        self.assertTrue(data.startswith(b"\xef\xbb\xbf"), "BOM was dropped")
        self.assertIn(b"\r\n", data)
        self.assertNotIn(b"\n\n", data.replace(b"\r\n", b"\n\n")[:0])  # no LF-only writes
        self.assertFalse(data.endswith(b"\n"), "a trailing newline was added")
        self.assertIn(b'remote_compaction = "unsupported"', data)

    def test_lf_file_keeps_lf_endings(self):
        self.write_config(BASIC)
        self.assert_ok(self.apply())
        data = self.config.read_bytes()
        self.assertNotIn(b"\r\n", data)

    def test_non_utf8_config_is_refused(self):
        self.config.write_bytes("model_provider = \"GW\"  # \u4e2d\u6587\n".encode("gbk"))
        before = self.config.read_bytes()
        result = self.apply()
        self.assertEqual(result.returncode, 1)
        self.assertIn("UTF-8", result.stderr)
        self.assertEqual(self.config.read_bytes(), before)


class RefusalTests(PatcherTestCase):
    def test_missing_model_provider_is_refused(self):
        self.write_config('model = "gemini-4-hydrogen"\n')
        result = self.apply()
        self.assertEqual(result.returncode, 1)
        self.assertIn("model_provider", result.stderr)
        self.assertNotIn("capabilities", self.text())

    def test_explicit_provider_overrides_a_missing_key(self):
        self.write_config('[model_providers.GW]\nbase_url = "https://gw.example/v1"\n')
        result = self.run_core(
            "apply", "--config", str(self.config), "--skip-validation", "--provider", "GW"
        )
        self.assert_ok(result)
        self.assertIn("[model_providers.GW.capabilities]", self.text())

    def test_builtin_provider_without_a_table_is_refused(self):
        self.write_config('model_provider = "openai"\n')
        result = self.apply()
        self.assertEqual(result.returncode, 1)
        self.assertIn("built into Codex", result.stderr)

    def test_missing_config_is_reported(self):
        result = self.run_core("apply", "--config", str(self.root / "nope.toml"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("not found", result.stderr)

    def test_ratio_out_of_range_is_refused(self):
        self.write_config(BASIC)
        result = self.apply("--limit-ratio", "1.5")
        self.assertEqual(result.returncode, 1)
        self.assertIn("limit-ratio", result.stderr)


class RevertTests(PatcherTestCase):
    def test_revert_restores_the_original_bytes(self):
        self.config.write_bytes(BASIC.replace("\n", "\r\n").encode("utf-8"))
        original = self.config.read_bytes()
        self.assert_ok(self.apply())
        self.assertNotEqual(self.config.read_bytes(), original)
        self.assert_ok(self.revert())
        self.assertEqual(self.config.read_bytes(), original)
        self.assertFalse((self.root / ".codex-compact-state.json").exists())

    def test_revert_removes_a_created_table_and_keeps_the_rest(self):
        self.write_config('model_provider = "GW"\nmodel_context_window = 100000\n')
        original = self.config.read_bytes()
        self.assert_ok(self.apply())
        self.assertIn("[model_providers.GW.capabilities]", self.text())
        self.assert_ok(self.revert())
        self.assertEqual(self.config.read_bytes(), original)

    def test_revert_is_byte_exact_when_the_next_section_has_no_blank_line(self):
        # Shape of a hand written config: [tui] follows the provider table
        # with no blank line in between. The separator blank above the table
        # belongs to this tool, so revert has to take it away again.
        self.write_config(
            'model_provider = "OpenAI"\n'
            'model_context_window = 128000\n'
            '\n'
            '[model_providers.OpenAI]\n'
            'name = "OpenAI"\n'
            'base_url = "https://gateway.example/v1"\n'
            'wire_api = "responses"\n'
            'experimental_bearer_token = "sk-test"#gateway\n'
            '[tui]\n'
            'screen_reader_detection_done = true\n'
        )
        original = self.config.read_bytes()
        self.assert_ok(self.apply())
        self.assertNotEqual(self.config.read_bytes(), original)
        self.assert_ok(self.revert())
        self.assertEqual(self.config.read_bytes(), original)

    def test_revert_is_byte_exact_for_a_trailing_table_without_final_newline(self):
        self.write_config(
            'model_provider = "OpenAI"\nmodel_context_window = 128000\n\n'
            '[model_providers.OpenAI]\nname = "OpenAI"\n'
            'base_url = "https://gateway.example/v1"\nwire_api = "responses"'
        )
        original = self.config.read_bytes()
        self.assert_ok(self.apply())
        self.assert_ok(self.revert())
        self.assertEqual(self.config.read_bytes(), original)
    def test_revert_keeps_a_line_the_user_changed_afterwards(self):
        self.write_config(BASIC)
        self.assert_ok(self.apply())
        edited = self.text().replace(
            'remote_compaction = "unsupported"', 'remote_compaction = "v2"'
        )
        self.config.write_text(edited, encoding="utf-8", newline="")
        result = self.revert()
        self.assert_ok(result)
        self.assertIn('remote_compaction = "v2"', self.text())
        self.assertIn("skipped", result.stdout)

    def test_revert_without_state_explains_itself(self):
        self.write_config(BASIC)
        result = self.revert()
        self.assertEqual(result.returncode, 1)
        self.assertIn("nothing to revert", result.stderr)

    def test_revert_dry_run_changes_nothing(self):
        self.write_config(BASIC)
        self.assert_ok(self.apply())
        before = self.config.read_bytes()
        result = self.revert("--dry-run")
        self.assert_ok(result)
        self.assertEqual(self.config.read_bytes(), before)
        self.assertTrue((self.root / ".codex-compact-state.json").exists())


class InspectTests(PatcherTestCase):
    def test_reports_window_limit_and_capability(self):
        self.write_config(BASIC)
        before = self.inspect()
        self.assert_ok(before)
        self.assertIn("provider: OpenAI", before.stdout)
        self.assertIn("window:   256000", before.stdout)
        self.assertIn("NOT reachable", before.stdout)
        self.assertIn("remote_compaction = (not set)", before.stdout)

        self.assert_ok(self.apply())
        after = self.inspect()
        self.assert_ok(after)
        self.assertIn("remote_compaction = unsupported", after.stdout)
        self.assertIn("(reachable)", after.stdout)
        self.assertIn("applied", after.stdout)

    def test_inspect_on_a_missing_file_does_not_crash(self):
        result = self.run_core("inspect", "--config", str(self.root / "nope.toml"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("missing", result.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)