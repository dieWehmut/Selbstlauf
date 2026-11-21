type StorageArea = 'localStorage' | 'sessionStorage';

/** Browser persistence must not prevent an agent operation or hide its result. */
export function readStoredString(area: StorageArea, key: string): { value: string | null; ok: boolean } {
  try {
    return { value: window[area].getItem(key), ok: true };
  } catch {
    return { value: null, ok: false };
  }
}

export function storeString(area: StorageArea, key: string, value: string | null): boolean {
  try {
    if (value === null) window[area].removeItem(key);
    else window[area].setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
