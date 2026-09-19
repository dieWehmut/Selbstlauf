/**
 * The startup-task bridge.
 *
 * The per-user logon task is owned by the watchdog service (it created it and
 * records that ownership in its installation manifest), and the desktop app has
 * no direct handle on it. The main process therefore drives the service's own
 * loopback routes and reads the state back, rather than inventing a second path
 * that could disagree with the service.
 *
 * The service may not be reachable yet — it can still be starting, or the app
 * may have fallen back to the placeholder page — so every call here is total:
 * a failure reports "unknown" instead of throwing.
 */

export interface StartupState {
  /** The service's answer, or null when it could not be reached or understood. */
  readonly installed: boolean | null;
  /** True when the service answered at all; drives whether the item is inert. */
  readonly reachable: boolean;
}

export interface StartupClientOptions {
  /** The loopback origin of the bundled service. */
  readonly origin: string;
  readonly fetchImpl?: typeof fetch;
}

function readInstalled(payload: unknown): boolean | null {
  if (payload === null || typeof payload !== 'object') return null;
  const installed = (payload as { installed?: unknown }).installed;
  return typeof installed === 'boolean' ? installed : null;
}

async function requestStartup(
  options: StartupClientOptions,
  path: string,
  method: 'GET' | 'POST',
): Promise<StartupState> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${options.origin}${path}`, {
      method,
      headers: { origin: options.origin },
    });
    if (!response.ok) return { installed: null, reachable: false };
    return { installed: readInstalled(await response.json()), reachable: true };
  } catch {
    return { installed: null, reachable: false };
  }
}

/** Read the real startup-task state from the service. */
export function readStartupState(options: StartupClientOptions): Promise<StartupState> {
  return requestStartup(options, '/api/startup', 'GET');
}

/**
 * Toggle the startup task, then report what the service says afterwards.
 *
 * The result is read back, never assumed: the checkbox must show reality even
 * when the install silently failed.
 */
export async function setStartupInstalled(
  options: StartupClientOptions,
  installed: boolean,
): Promise<StartupState> {
  const path = installed ? '/api/startup/install' : '/api/startup/uninstall';
  await requestStartup(options, path, 'POST');
  return readStartupState(options);
}