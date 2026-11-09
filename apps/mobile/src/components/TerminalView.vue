<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import type { Terminal, ITheme } from "@xterm/xterm";
import type { AgentOutput, AgentSession } from "../client";
import "@xterm/xterm/css/xterm.css";

const props = defineProps<{
  session: AgentSession;
  output: AgentOutput | null;
  history: string;
  enabled: boolean;
  write: (data: string) => Promise<boolean>;
  resize: (cols: number, rows: number) => Promise<boolean>;
}>();

const surface = ref<HTMLDivElement>();
const error = ref("");
let terminal: Terminal | undefined;
let active = true;
let cursor = 0;
let inputFailure: unknown = null;
let inputTail: Promise<void> = Promise.resolve();
let outputTail: Promise<void> = Promise.resolve();
let resizeTail: Promise<void> = Promise.resolve();
let cleanup: (() => void) | undefined;

function report(cause: unknown) {
  if (active) error.value = cause instanceof Error ? cause.message : "终端操作失败，请重试";
}

function canInput() {
  return active && props.enabled && props.session.status === "running";
}

function queueInput(data: string): Promise<void> {
  const operation = inputTail.then(async () => {
    if (!canInput()) throw new Error("终端尚未连接或已结束");
    if (inputFailure !== null) throw inputFailure;
    try {
      for (let start = 0; start < data.length;) {
        if (!canInput()) throw new Error("终端连接已中断");
        let end = Math.min(start + 8192, data.length);
        if (end < data.length && /[\uD800-\uDBFF]/u.test(data[end - 1]!)) end -= 1;
        if (!await props.write(data.slice(start, end))) throw new Error("输入未能发送，请检查连接后重试");
        start = end;
      }
    } catch (cause) {
      inputFailure = cause;
      throw cause;
    }
  });
  inputTail = operation.catch(() => undefined);
  return operation;
}

function terminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: token("--bg", "#1b110e"), foreground: token("--text", "#f4e0d7"),
    cursor: token("--primary", "#ffb79a"), selectionBackground: "#7f9ca455",
    black: "#20262e", red: "#e57474", green: "#84c596", yellow: "#d8b476",
    blue: "#79a9d6", magenta: "#be94da", cyan: "#78bcc0", white: "#cfd7df",
    brightBlack: "#77818b", brightRed: "#f29393", brightGreen: "#a4deaf", brightYellow: "#edcc96",
    brightBlue: "#9ac5e9", brightMagenta: "#d2b0e8", brightCyan: "#9fd4d6", brightWhite: "#f4f7fa",
  };
}

function render(data: string): Promise<void> {
  return new Promise((resolve) => {
    if (!active || !terminal || !data) { resolve(); return; }
    terminal.write(data, resolve);
  });
}

function receive(page: AgentOutput | null) {
  if (!page || !terminal || page.session.id !== props.session.id) return;
  outputTail = outputTail.then(async () => {
    if (!active || !terminal) return;
    if (!page.reset && page.offset <= cursor) return;
    if (page.reset || page.fromOffset > cursor) {
      terminal.reset();
      cursor = page.fromOffset;
    }
    const data = page.data.slice(Math.max(0, cursor - page.fromOffset));
    await render(data);
    if (!active) return;
    cursor = page.offset;
    if (surface.value) surface.value.dataset.outputOffset = String(cursor);
  }).catch(report);
}

watch(() => props.output, receive);
watch(() => props.enabled && props.session.status === "running", () => {
  if (terminal) terminal.options.disableStdin = !canInput();
  if (canInput()) inputFailure = null;
});

onMounted(async () => {
  try {
    const [xterm, addon] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
    if (!active || !surface.value) return;
    const element = surface.value;
    xterm.Terminal.strings.promptLabel = "终端键盘输入";
    xterm.Terminal.strings.tooMuchOutput = "终端输出较多，请逐行浏览";
    const term = new xterm.Terminal({
      cols: props.session.cols, rows: props.session.rows, fontSize: 13, lineHeight: 1.25,
      fontFamily: '"Cascadia Mono", Consolas, monospace', cursorBlink: true,
      scrollback: 5000, screenReaderMode: true, disableStdin: !canInput(), theme: terminalTheme(),
    });
    terminal = term;
    const fit = new addon.FitAddon();
    term.loadAddon(fit);
    term.open(element);
    element.querySelector("textarea")?.setAttribute("aria-label", "终端键盘输入");
    const input = term.onData((data) => {
      if (canInput()) void queueInput(data).catch(report);
    });
    term.attachCustomKeyEventHandler((event) => !(event.ctrlKey && event.key.toLowerCase() === "c" && term.hasSelection()));
    const resized = term.onResize(({ cols, rows }) => {
      resizeTail = resizeTail.then(async () => {
        if (!canInput()) return;
        if (!await props.resize(cols, rows)) throw new Error("电脑终端尺寸未能更新，请检查连接");
      }).catch(report);
    });
    const refit = () => { if (active && element.clientWidth > 0) fit.fit(); };
    const sizeObserver = new ResizeObserver(refit);
    sizeObserver.observe(element);
    const themeObserver = new MutationObserver(() => { term.options.theme = terminalTheme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme"] });
    cleanup = () => {
      input.dispose(); resized.dispose(); sizeObserver.disconnect(); themeObserver.disconnect(); term.dispose();
    };
    const history = props.history;
    const offset = props.output?.offset ?? history.length;
    outputTail = render(history).then(() => {
      if (!active) return;
      cursor = offset;
      element.dataset.outputOffset = String(cursor);
    });
    refit();
    void document.fonts?.ready.then(refit);
    // Focus is user initiated so opening output on a phone does not summon the keyboard.
  } catch (cause) { report(cause); }
});

onUnmounted(() => {
  active = false;
  cleanup?.();
  terminal = undefined;
});

async function send(data: string): Promise<boolean> {
  if (!canInput() || !terminal || !data) return false;
  error.value = "";
  inputFailure = null;
  try {
    // paste() follows the process's bracketed paste mode for multiline prompts.
    terminal.paste(data);
    await queueInput("\r");
    return true;
  } catch (cause) { report(cause); return false; }
}

defineExpose({ send, focus: () => terminal?.focus() });
</script>

<template>
  <section class="terminal-view">
    <div ref="surface" class="terminal-output" role="region" aria-label="终端输出" :data-agent-id="session.id" @pointerdown="error = ''" />
    <p v-if="error" class="error-note" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.terminal-output { height: clamp(320px, 52dvh, 620px); max-height: none; overflow: hidden; background: var(--bg); padding: 12px; }
.terminal-output :deep(.xterm) { height: 100%; }
</style>
