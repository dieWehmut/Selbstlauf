#!/usr/bin/env python3
"""Patch Codex `config.toml` so auto-compaction also works with non-GPT models.

Why this exists
---------------
Codex picks a compaction strategy from the model provider it is about to talk
to. A custom provider whose display name is "OpenAI" is treated as the OpenAI
backend, so Codex asks the gateway for OpenAI-only remote compaction v2: it
sends a `compaction_trigger` and expects exactly one opaque `compaction` output
item. Third-party gateways merely proxy ordinary chat models, so they answer
with normal message items and the turn dies with:

    remote compaction v2 expected exactly one compaction output item,
    got 0 from 1 output items

Declaring `remote_compaction = "unsupported"` for that provider moves the work
back into Codex's local summariser, which is model agnostic. Any model (Gemini,
Claude, DeepSeek, ...) can then compact.

The same config also pins `model_auto_compact_token_limit`. When the limit is
set to the full context window it can never be reached before the hard limit,
so auto-compaction never triggers. This tool lowers it to a ratio of the window
(default 90%) only when the configured limit is not reachable.

Design notes
------------
* Single source of truth for the change: the PowerShell and POSIX installers
  are thin wrappers that call this file.
* The file is edited line by line instead of being re-serialised, so comments,
  key order, quoting and formatting survive untouched.
* Byte level details are preserved: UTF-8 BOM, CRLF versus LF, and the presence
  or absence of a trailing newline.
* Every mutation is recorded in `<codex home>/.codex-compact-state.json`, which
  is what `revert` uses to undo exactly the lines this tool inserted.
* A timestamped byte-for-byte backup is written before the first change.
* The edited file is validated before it is kept; if validation regresses the
  original bytes are restored and the tool exits non-zero.

Usage
-----
    python3 codex_compact_config.py inspect [--config PATH]
    python3 codex_compact_config.py apply   [--config PATH] [--dry-run]
    python3 codex_compact_config.py revert  [--config PATH] [--dry-run]

Exit codes: 0 success, 1 failure, 2 invalid usage or unsupported config.
"""

from __future__ import annotations

import argparse
import datetime
import difflib
import json
import os
import re
import shutil
import subprocess
import sys

SCHEMA_VERSION = 1
STATE_FILE = ".codex-compact-state.json"
DEFAULT_LIMIT_RATIO = 0.9
CAPABILITY_KEY = "remote_compaction"
CAPABILITY_VALUE = "unsupported"
LIMIT_KEY = "model_auto_compact_token_limit"
WINDOW_KEY = "model_context_window"
PROVIDER_KEY = "model_provider"
# Providers that ship inside Codex. Their tables must never be fabricated.
BUILTIN_PROVIDERS = ("openai",)

BARE_KEY = re.compile(r"^[A-Za-z0-9_-]+$")
TABLE_HEADER = re.compile(r"^[ \t]*\[([^\[\]]*)\][ \t]*(?:#.*)?$")
INTEGER = re.compile(r"^[+-]?[0-9]+$")


class ConfigError(Exception):
    """A config problem that the user has to resolve; message is user facing."""


def expand_home(value):
    """Expand `~` the way the shells do, without touching every other path."""
    if value is None:
        return None
    if value == "~" or value.startswith("~/") or value.startswith("~\\"):
        home = os.path.expanduser("~")
        return home + value[1:]
    return value


def codex_home():
    """CODEX_HOME, or `~/.codex` like Codex itself resolves it."""
    configured = os.environ.get("CODEX_HOME")
    if configured and configured.strip():
        return expand_home(configured.strip())
    return os.path.join(os.path.expanduser("~"), ".codex")


def resolve_config_path(explicit):
    if explicit and explicit.strip():
        return os.path.abspath(expand_home(explicit.strip()))
    return os.path.join(codex_home(), "config.toml")


def parse_dotted_key(text):
    """Split `a."b c".d` into ('a', 'b c', 'd') using TOML key rules."""
    keys = []
    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        if char in " \t":
            index += 1
            continue
        if char == ".":
            index += 1
            continue
        if char == '"':
            index += 1
            buffer = []
            while index < length:
                char = text[index]
                if char == "\\":
                    if index + 1 >= length:
                        raise ConfigError("unterminated escape in a quoted key")
                    escape = text[index + 1]
                    simple = {
                        "b": "\b",
                        "t": "\t",
                        "n": "\n",
                        "f": "\f",
                        "r": "\r",
                        '"': '"',
                        "\\": "\\",
                    }
                    if escape in simple:
                        buffer.append(simple[escape])
                        index += 2
                        continue
                    if escape in "uU":
                        size = 4 if escape == "u" else 8
                        digits = text[index + 2:index + 2 + size]
                        if len(digits) != size or not re.fullmatch(
                            r"[0-9A-Fa-f]{%d}" % size, digits
                        ):
                            raise ConfigError("invalid unicode escape in a quoted key")
                        buffer.append(chr(int(digits, 16)))
                        index += 2 + size
                        continue
                    raise ConfigError("unsupported escape in a quoted key")
                if char == '"':
                    index += 1
                    break
                buffer.append(char)
                index += 1
            else:
                raise ConfigError("unterminated quoted key")
            keys.append("".join(buffer))
            continue
        if char == "'":
            end = text.find("'", index + 1)
            if end < 0:
                raise ConfigError("unterminated literal key")
            keys.append(text[index + 1:end])
            index = end + 1
            continue
        start = index
        while index < length and text[index] not in " \t.":
            index += 1
        keys.append(text[start:index])
    if not keys:
        raise ConfigError("empty table name")
    return tuple(keys)


def format_key(key):
    if BARE_KEY.match(key):
        return key
    return json.dumps(key, ensure_ascii=False)


def format_header(keys):
    return "[" + ".".join(format_key(key) for key in keys) + "]"


def split_comment(line):
    """Return (payload, comment) with the comment including its leading `#`."""
    mode = None
    index = 0
    length = len(line)
    while index < length:
        char = line[index]
        if mode is None:
            if char == "#":
                return line[:index], line[index:]
            if char == '"':
                mode = '"'
            elif char == "'":
                mode = "'"
            index += 1
            continue
        if mode == '"':
            if char == "\\":
                index += 2
                continue
            if char == '"':
                mode = None
            index += 1
            continue
        if char == "'":
            mode = None
        index += 1
    return line, ""


def parse_assignment(line):
    """Return (key, value, comment) for a single-line `key = value`, else None."""
    payload, comment = split_comment(line)
    if "=" not in payload:
        return None
    name, _, value = payload.partition("=")
    name = name.strip()
    if not name:
        return None
    try:
        keys = parse_dotted_key(name)
    except ConfigError:
        return None
    if len(keys) != 1:
        # Dotted assignments at the root are legal TOML but never what Codex
        # writes for the keys this tool touches, so they are treated as opaque.
        return None
    return keys[0], value.strip(), comment


def unquote(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return None


def parse_integer(value):
    text = value.strip().replace("_", "")
    if INTEGER.match(text):
        return int(text)
    return None


def with_comment(previous, assignment):
    """Reuse a trailing comment, padded to its original column when it still fits."""
    payload, comment = split_comment(previous)
    if not comment.strip():
        return assignment
    gap = max(2, len(payload) - len(assignment))
    return assignment + " " * gap + comment


def indent_of(line):
    return line[: len(line) - len(line.lstrip(" \t"))]

class Document:
    """A line oriented TOML document that keeps the original formatting."""

    def __init__(self, lines, newline="\n", bom=False, trailing_newline=True):
        self.lines = lines
        self.newline = newline
        self.bom = bom
        self.trailing_newline = trailing_newline

    @classmethod
    def read(cls, path):
        if not os.path.exists(path):
            raise ConfigError(
                "config file not found: %s\n"
                "Start Codex once so it creates the file, or pass --config." % path
            )
        with open(path, "rb") as stream:
            raw = stream.read()
        bom = raw.startswith(b"\xef\xbb\xbf")
        body = raw[3:] if bom else raw
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ConfigError(
                "%s is not valid UTF-8 (%s).\n"
                "Codex config files must be UTF-8; re-save the file as UTF-8 first." % (path, error)
            )
        newline = "\r\n" if "\r\n" in text else "\n"
        trailing_newline = text.endswith("\n")
        lines = text.replace("\r\n", "\n").split("\n")
        if lines and lines[-1] == "":
            lines.pop()
        return cls(lines, newline, bom, trailing_newline)

    def clone(self):
        return Document(list(self.lines), self.newline, self.bom, self.trailing_newline)

    def text(self):
        return self.newline.join(self.lines) + (self.newline if self.trailing_newline else "")

    def to_bytes(self):
        data = self.text().encode("utf-8")
        return (b"\xef\xbb\xbf" + data) if self.bom else data

    def write(self, path):
        """Replace the file atomically so a crash cannot leave it truncated."""
        temp = path + ".compact-tmp"
        with open(temp, "wb") as stream:
            stream.write(self.to_bytes())
        try:
            shutil.copymode(path, temp)
        except OSError:
            pass
        os.replace(temp, path)

    def headers(self):
        found = []
        for index, line in enumerate(self.lines):
            match = TABLE_HEADER.match(line)
            if not match:
                continue
            try:
                keys = parse_dotted_key(match.group(1))
            except ConfigError:
                continue
            found.append((index, keys))
        return found

    def block(self, keys):
        """Return (header index, end index) for a table, or None."""
        entries = self.headers()
        for position, (index, found) in enumerate(entries):
            if found == keys:
                end = entries[position + 1][0] if position + 1 < len(entries) else len(self.lines)
                return index, end
        return None

    def root_block(self):
        """Return (0, end index) for the implicit document root table."""
        entries = self.headers()
        return 0, (entries[0][0] if entries else len(self.lines))

    def find_key(self, scope, key):
        start, end = scope
        header_rows = set(index for index, _ in self.headers())
        for index in range(start, end):
            if index in header_rows:
                continue
            parsed = parse_assignment(self.lines[index])
            if parsed and parsed[0] == key:
                return index
        return None

    def last_content_index(self, scope):
        """Index of the last non blank line inside a table scope."""
        start, end = scope
        for index in range(end - 1, start, -1):
            if self.lines[index].strip():
                return index
        return start


def state_path(config_path):
    return os.path.join(os.path.dirname(os.path.abspath(config_path)), STATE_FILE)


def read_state(config_path):
    path = state_path(config_path)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as stream:
            return json.load(stream)
    except (OSError, ValueError) as error:
        raise ConfigError("cannot read compact state %s: %s" % (path, error))


def write_state(config_path, state):
    path = state_path(config_path)
    with open(path, "w", encoding="utf-8", newline="\n") as stream:
        json.dump(state, stream, ensure_ascii=False, indent=2, sort_keys=True)
        stream.write("\n")


def drop_state(config_path):
    path = state_path(config_path)
    if os.path.exists(path):
        os.remove(path)


def make_backup(config_path, label="bak-compact"):
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    candidate = "%s.%s-%s" % (config_path, label, stamp)
    counter = 1
    while os.path.exists(candidate):
        candidate = "%s.%s-%s-%d" % (config_path, label, stamp, counter)
        counter += 1
    shutil.copy2(config_path, candidate)
    return candidate


def detect_provider(doc, override):
    if override and override.strip():
        return override.strip()
    index = doc.find_key(doc.root_block(), PROVIDER_KEY)
    if index is None:
        raise ConfigError(
            "the config has no top level `%s`, so there is no provider to patch.\n"
            "Add `%s = \"<name>\"` to the file, or pass --provider <name>." % (PROVIDER_KEY, PROVIDER_KEY)
        )
    parsed = parse_assignment(doc.lines[index])
    name = unquote(parsed[1]) if parsed else None
    if not name:
        raise ConfigError(
            "`%s` is not a quoted string, so the provider cannot be resolved." % PROVIDER_KEY
        )
    return name


def apply_capability(doc, provider):
    """Ensure [model_providers.<provider>.capabilities] declares local compaction."""
    capability_keys = ("model_providers", provider, "capabilities")
    provider_keys = ("model_providers", provider)
    header = format_header(capability_keys)
    applied_line = '%s = "%s"' % (CAPABILITY_KEY, CAPABILITY_VALUE)
    edit = {
        "kind": "capability",
        "header": header,
        "createdTable": False,
        "previousLine": None,
        "appliedLine": applied_line,
    }

    scope = doc.block(capability_keys)
    if scope is not None:
        index = doc.find_key(scope, CAPABILITY_KEY)
        if index is not None:
            previous = doc.lines[index]
            replacement = with_comment(previous, indent_of(previous) + applied_line)
            if replacement == previous:
                return None, "already set"
            doc.lines[index] = replacement
            edit["previousLine"] = previous
            edit["appliedLine"] = replacement
            return edit, "rewrote the existing %s line" % CAPABILITY_KEY
        position = doc.last_content_index(scope) + 1
        doc.lines.insert(position, applied_line)
        return edit, "added %s to the existing capabilities table" % CAPABILITY_KEY

    provider_scope = doc.block(provider_keys)
    if provider_scope is not None:
        position = doc.last_content_index(provider_scope) + 1
        doc.lines[position:position] = ["", header, applied_line]
        edit["createdTable"] = True
        return edit, "added the capabilities table to the existing provider table"

    if provider.strip().lower() in BUILTIN_PROVIDERS:
        raise ConfigError(
            "provider %r is built into Codex and already supports compaction, so it has no\n"
            "provider table to patch. Point `%s` at your gateway provider instead."
            % (provider, PROVIDER_KEY)
        )

    while doc.lines and not doc.lines[-1].strip():
        doc.lines.pop()
    if doc.lines:
        doc.lines.append("")
    doc.lines.extend([header, applied_line])
    edit["createdTable"] = True
    return edit, "created a standalone capabilities table"


def apply_auto_limit(doc, ratio):
    """Make sure the auto-compact threshold can actually be reached."""
    window_index = doc.find_key(doc.root_block(), WINDOW_KEY)
    if window_index is None:
        return None, "no top level %s, so the auto-compact limit was left alone" % WINDOW_KEY
    window = parse_integer(parse_assignment(doc.lines[window_index])[1])
    if not window or window <= 0:
        return None, "%s is not a positive integer, so the auto-compact limit was left alone" % WINDOW_KEY
    target = max(1, int(window * ratio))
    edit = {"kind": "limit", "previousLine": None, "appliedLine": None}

    limit_index = doc.find_key(doc.root_block(), LIMIT_KEY)
    if limit_index is None:
        line = "%s = %d" % (LIMIT_KEY, target)
        doc.lines.insert(window_index + 1, line)
        edit["appliedLine"] = line
        return edit, "added %s = %d (%d%% of the %d token window)" % (
            LIMIT_KEY, target, int(round(ratio * 100)), window)

    previous = doc.lines[limit_index]
    current = parse_integer(parse_assignment(previous)[1])
    if current is None:
        return None, "%s is not an integer, so it was left alone" % LIMIT_KEY
    if current < window:
        return None, "%s = %d is already below the %d token window, so it was left alone" % (
            LIMIT_KEY, current, window)
    replacement = with_comment(previous, indent_of(previous) + ("%s = %d" % (LIMIT_KEY, target)))
    doc.lines[limit_index] = replacement
    edit["previousLine"] = previous
    edit["appliedLine"] = replacement
    return edit, "lowered %s from %d to %d (%d%% of the %d token window)" % (
        LIMIT_KEY, current, target, int(round(ratio * 100)), window)

def validate_with_tomllib(text):
    """Return True/False when the running Python ships tomllib, else None."""
    try:
        import tomllib
    except ImportError:
        return None
    try:
        tomllib.loads(text)
    except Exception:
        return False
    return True


def check_with_codex(config_path):
    """Ask Codex itself to parse the file. None means the check was unavailable."""
    if os.path.basename(config_path) != "config.toml":
        return None
    executable = shutil.which("codex")
    if not executable:
        return None
    command = [executable, "app-server", "--print-startup-config"]
    if os.name == "nt" and executable.lower().endswith((".cmd", ".bat")):
        command = ["cmd", "/c"] + command
    environment = dict(os.environ)
    environment["CODEX_HOME"] = os.path.dirname(os.path.abspath(config_path))
    environment["NO_PROXY"] = ",".join(
        item for item in (environment.get("NO_PROXY"), "127.0.0.1", "localhost") if item
    )
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, timeout=180, env=environment
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode == 0:
        return True
    output = ((result.stdout or "") + (result.stderr or "")).lower()
    if "toml" in output or "parse error" in output or "failed to parse" in output:
        return False
    return None


def validate_text(text, config_path):
    parsed = validate_with_tomllib(text)
    if parsed is not None:
        return parsed
    return check_with_codex(config_path)


def locate_line(doc, scope, applied):
    """Find the exact line this tool wrote. None when the user changed it."""
    start, end = scope
    header_rows = set(index for index, _ in doc.headers())
    for index in range(start, end):
        if index in header_rows:
            continue
        if doc.lines[index].strip() == applied.strip():
            return index
    return None


def remove_header(doc, scope):
    """Delete a table header plus the blank separator that introduced it.

    apply_capability always inserts exactly one blank line above a table it
    creates (unless the file was empty), so that blank line belongs to this
    tool and has to go when the table goes. Never consult the line below the
    header: a config that puts the next section straight after the provider
    table has no blank line there, and treating that as "keep the separator"
    left a stray blank behind, so revert was not byte exact.
    """
    header_index = scope[0]
    del doc.lines[header_index]
    previous = header_index - 1
    if previous >= 0 and not doc.lines[previous].strip():
        del doc.lines[previous]


def undo_edits(doc, state):
    notes = []
    for edit in reversed(list(state.get("edits", []))):
        kind = edit.get("kind")
        applied = edit.get("appliedLine")
        previous = edit.get("previousLine")
        if not applied:
            continue
        if kind == "limit":
            scope = doc.root_block()
        elif kind == "capability":
            match = TABLE_HEADER.match(str(edit.get("header", "")))
            if not match:
                notes.append("ignored a malformed capability header in the state file")
                continue
            keys = parse_dotted_key(match.group(1))
            scope = doc.block(keys)
            if scope is None:
                notes.append("table %s is already gone, skipped" % edit.get("header"))
                continue
        else:
            continue
        index = locate_line(doc, scope, applied)
        if index is None:
            notes.append("line %r was changed after installation, skipped" % applied)
            continue
        if previous:
            doc.lines[index] = previous
        else:
            del doc.lines[index]
        if kind == "capability" and edit.get("createdTable"):
            match = TABLE_HEADER.match(str(edit.get("header", "")))
            scope = doc.block(parse_dotted_key(match.group(1)))
            if scope is not None:
                empty = not any(doc.lines[i].strip() for i in range(scope[0] + 1, scope[1]))
                if empty:
                    remove_header(doc, scope)
                    notes.append("removed the empty %s table" % edit.get("header"))
    return notes


def print_notes(notes):
    for note in notes:
        if note:
            print("  - " + note)


def cmd_inspect(args):
    config = resolve_config_path(args.config)
    print("config:   %s" % config)
    if not os.path.exists(config):
        print("status:   missing (start Codex once, or pass --config)")
        return 1
    doc = Document.read(config)
    documented = read_state(config)

    try:
        provider = detect_provider(doc, None)
    except ConfigError:
        provider = None
    print("provider: %s" % (provider if provider else "(no top level model_provider)"))

    root = doc.root_block()

    def root_value(key):
        index = doc.find_key(root, key)
        if index is None:
            return None
        return parse_assignment(doc.lines[index])[1]

    if provider:
        provider_scope = doc.block(("model_providers", provider))
        if provider_scope is not None:
            for key in ("name", "base_url", "wire_api"):
                index = doc.find_key(provider_scope, key)
                if index is not None:
                    print("  %-8s %s" % (key + ":", unquote(parse_assignment(doc.lines[index])[1]) or ""))

    window = parse_integer(root_value(WINDOW_KEY) or "")
    limit = parse_integer(root_value(LIMIT_KEY) or "")
    print("window:   %s" % (window if window else "(not set)"))
    if limit:
        reachable = "reachable" if (not window or limit < window) else "NOT reachable before the hard limit"
        print("limit:    %d (%s)" % (limit, reachable))
    else:
        print("limit:    (not set)")

    capability = "(not set)"
    if provider:
        scope = doc.block(("model_providers", provider, "capabilities"))
        if scope is not None:
            index = doc.find_key(scope, CAPABILITY_KEY)
            if index is not None:
                capability = unquote(parse_assignment(doc.lines[index])[1]) or "(unparsed)"
    print("compact:  remote_compaction = %s" % capability)

    if documented:
        print("state:    applied %s by %s" % (
            documented.get("appliedAt", "?"), os.path.basename(state_path(config))))
        if documented.get("backupPath"):
            print("backup:   %s" % documented.get("backupPath"))
    else:
        print("state:    no compact state file (nothing applied by this tool)")
    return 0


def cmd_apply(args):
    config = resolve_config_path(args.config)
    ratio = float(args.limit_ratio)
    if ratio < 0.5 or ratio > 1.0:
        raise ConfigError("--limit-ratio must be between 0.5 and 1.0 (got %s)" % args.limit_ratio)

    original = Document.read(config)
    provider = detect_provider(original, args.provider)
    working = original.clone()
    edits = []
    notes = []

    if not args.no_auto_limit:
        edit, note = apply_auto_limit(working, ratio)
        notes.append(note)
        if edit is not None:
            edits.append(edit)
    else:
        notes.append("--no-auto-limit was given, so the auto-compact limit was left alone")

    capability_edit, note = apply_capability(working, provider)
    notes.append(note)
    if capability_edit is not None:
        edits.append(capability_edit)

    if not edits:
        print("nothing to change for provider %r in %s" % (provider, config))
        print_notes(notes)
        return 0

    diff = "".join(difflib.unified_diff(
        [line + working.newline for line in original.lines],
        [line + working.newline for line in working.lines],
        fromfile=config + " (before)",
        tofile=config + " (after)",
        n=3,
    ))
    if args.dry_run:
        print(diff)
        print("dry run: %s was not modified" % config)
        return 0

    before_ok = None if args.skip_validation else validate_text(original.text(), config)
    backup = make_backup(config)
    working.write(config)
    if not args.skip_validation:
        after_ok = validate_text(working.text(), config)
        if after_ok is False and before_ok is not False:
            shutil.copy2(backup, config)
            raise ConfigError(
                "the edited config failed validation, so the original was restored from\n%s" % backup
            )

    write_state(config, {
        "schemaVersion": SCHEMA_VERSION,
        "configPath": os.path.abspath(config),
        "provider": provider,
        "limitRatio": ratio,
        "appliedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "backupPath": os.path.abspath(backup),
        "edits": edits,
    })
    print("patched %s" % config)
    print_notes(notes)
    print("  - backup: %s" % backup)
    print("  - state:  %s" % state_path(config))
    print("  - restart Codex for the new settings to take effect.")
    return 0


def cmd_revert(args):
    config = resolve_config_path(args.config)
    state = read_state(config)
    if state is None:
        raise ConfigError(
            "no compact state file at %s, so there is nothing to revert." % state_path(config)
        )
    recorded = state.get("configPath")
    if recorded and os.path.abspath(recorded) != os.path.abspath(config):
        if args.config:
            raise ConfigError("the recorded state belongs to %s" % recorded)
        config = recorded

    doc = Document.read(config)
    before = list(doc.lines)
    notes = undo_edits(doc, state)
    if doc.lines == before:
        print("nothing to revert in %s" % config)
        print_notes(notes)
        return 0

    diff = "".join(difflib.unified_diff(
        [line + doc.newline for line in before],
        [line + doc.newline for line in doc.lines],
        fromfile=config + " (before revert)",
        tofile=config + " (after revert)",
        n=3,
    ))
    if args.dry_run:
        print(diff)
        print("dry run: %s was not modified" % config)
        return 0

    doc.write(config)
    drop_state(config)
    print("reverted %s" % config)
    print_notes(notes)
    if state.get("backupPath"):
        print("  - the pre-install backup is kept at %s" % state.get("backupPath"))
    print("  - restart Codex for the change to take effect.")
    return 0


def build_parser():
    parser = argparse.ArgumentParser(
        prog="codex_compact_config.py",
        description="Make Codex auto-compaction work for non-GPT models by patching config.toml.",
    )
    subparsers = parser.add_subparsers(dest="command")
    for name, summary in (
        ("apply", "declare local compaction for the active provider"),
        ("revert", "undo exactly the lines applied earlier"),
        ("inspect", "show the provider, window, limit and compact settings"),
    ):
        sub = subparsers.add_parser(name, help=summary, description=summary)
        sub.add_argument("--config", help="config.toml to edit (default: $CODEX_HOME/config.toml)")
        if name == "apply":
            sub.add_argument("--provider", help="provider name to patch (default: top level model_provider)")
            sub.add_argument(
                "--limit-ratio",
                type=float,
                default=DEFAULT_LIMIT_RATIO,
                help="auto-compact threshold as a share of the context window (default: 0.9)",
            )
            sub.add_argument("--no-auto-limit", action="store_true", help="only touch the provider capability")
        if name in ("apply", "revert"):
            sub.add_argument("--dry-run", action="store_true", help="print the diff and change nothing")
            sub.add_argument("--skip-validation", action="store_true", help="do not validate the result")
    subparsers.required = True
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    handlers = {"apply": cmd_apply, "revert": cmd_revert, "inspect": cmd_inspect}
    try:
        return handlers[args.command](args)
    except ConfigError as error:
        sys.stderr.write("error: %s\n" % error)
        return 1


if __name__ == "__main__":
    sys.exit(main())