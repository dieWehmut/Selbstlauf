export function createTerminalSubmitter(
  paste: (text: string, offset: number, onAccepted: (count: number) => void) => Promise<void>,
  pressEnter: () => Promise<void>,
): (text: string) => Promise<boolean> {
  let pendingPaste: { text: string; accepted: number } | null = null;
  let pendingEnterFor: string | null = null;
  let tail: Promise<void> = Promise.resolve();

  const finishPendingPaste = async () => {
    if (pendingPaste === null) return;
    const pending = pendingPaste;
    await paste(pending.text, pending.accepted, (count) => { pending.accepted += count; });
    pendingPaste = null;
    pendingEnterFor = pending.text;
  };

  const submit = async (text: string): Promise<boolean> => {
    try {
      await finishPendingPaste();
    } catch {
      return false;
    }

    if (pendingEnterFor !== null) {
      const pending = pendingEnterFor;
      try {
        await pressEnter();
        pendingEnterFor = null;
      } catch {
        return false;
      }
      if (pending === text) return true;
    }

    pendingPaste = { text, accepted: 0 };
    try {
      await finishPendingPaste();
    } catch {
      return false;
    }
    try {
      await pressEnter();
      pendingEnterFor = null;
      return true;
    } catch {
      return false;
    }
  };

  return (text) => {
    const operation = tail.then(() => submit(text));
    tail = operation.then(() => undefined, () => undefined);
    return operation;
  };
}
