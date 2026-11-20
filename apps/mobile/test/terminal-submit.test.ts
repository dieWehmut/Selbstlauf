import { describe, expect, it, vi } from "vitest";
import { createTerminalSubmitter } from "../src/components/terminal-submit";

describe("terminal submission", () => {
  it("retries Enter without pasting input that the terminal already accepted", async () => {
    const writes: string[] = [];
    const paste = vi.fn(async (text: string) => { writes.push(text); });
    const enter = vi.fn(async () => {
      writes.push("\r");
      if (enter.mock.calls.length === 1) throw new Error("connection lost before Enter was accepted");
    });
    const submit = createTerminalSubmitter(paste, enter);

    await expect(submit("echo ok")).resolves.toBe(false);
    await expect(submit("echo ok")).resolves.toBe(true);

    expect(writes).toEqual(["echo ok", "\r", "\r"]);
    expect(paste).toHaveBeenCalledTimes(1);
  });

  it("finishes a previously pasted command before sending a changed draft", async () => {
    const writes: string[] = [];
    const paste = vi.fn(async (text: string) => { writes.push(text); });
    const enter = vi.fn(async () => {
      writes.push("\r");
      if (enter.mock.calls.length === 1) throw new Error("connection lost before Enter was accepted");
    });
    const submit = createTerminalSubmitter(paste, enter);

    await expect(submit("first command")).resolves.toBe(false);
    await expect(submit("second command")).resolves.toBe(true);

    expect(writes).toEqual(["first command", "\r", "\r", "second command", "\r"]);
    expect(paste.mock.calls.map(([text]) => text)).toEqual(["first command", "second command"]);
  });

  it("resumes after an accepted prefix when a later payload chunk fails", async () => {
    const writes: string[] = [];
    const paste = vi.fn(async (text: string, offset: number, onAccepted: (count: number) => void) => {
      if (paste.mock.calls.length === 1) {
        const prefix = text.slice(offset, offset + 4);
        writes.push(prefix);
        onAccepted(prefix.length);
        throw new Error("connection lost after an accepted chunk");
      }
      const suffix = text.slice(offset);
      writes.push(suffix);
      onAccepted(suffix.length);
    });
    const enter = vi.fn(async () => { writes.push("\r"); });
    const submit = createTerminalSubmitter(paste, enter);

    await expect(submit("echo ok")).resolves.toBe(false);
    await expect(submit("echo ok")).resolves.toBe(true);

    expect(writes).toEqual(["echo", " ok", "\r"]);
    expect(paste.mock.calls.map(([, offset]) => offset)).toEqual([0, 4]);
  });
});
