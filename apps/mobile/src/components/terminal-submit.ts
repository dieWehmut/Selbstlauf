export function createTerminalSubmitter(
  paste: (text: string) => Promise<void>,
  pressEnter: () => Promise<void>,
): (text: string) => Promise<boolean> {
  let pendingEnterFor: string | null = null;
  let tail: Promise<void> = Promise.resolve();

  const submit = async (text: string): Promise<boolean> => {
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

    await paste(text);
    pendingEnterFor = text;
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
