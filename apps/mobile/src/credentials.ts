import { Capacitor, registerPlugin } from "@capacitor/core";

export interface CredentialStore {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

const native = registerPlugin<CredentialStore>("Credentials");
const memory = new Map<string, string>();

export const credentials: CredentialStore = {
  async get(options) {
    return Capacitor.isNativePlatform()
      ? native.get(options)
      : { value: memory.get(options.key) ?? null };
  },
  async set(options) {
    if (Capacitor.isNativePlatform()) await native.set(options);
    else memory.set(options.key, options.value);
  },
  async remove(options) {
    if (Capacitor.isNativePlatform()) await native.remove(options);
    else memory.delete(options.key);
  },
};
