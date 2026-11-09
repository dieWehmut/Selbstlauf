import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteClient, normalizeAddress } from "../src/client";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: vi.fn(() => false) },
  CapacitorHttp: { request: vi.fn() },
}));

afterEach(() => {
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
  vi.mocked(CapacitorHttp.request).mockReset();
  vi.unstubAllGlobals();
});

describe("normalizeAddress", () => {
  it("adds the Selbstlauf remote port to plain hosts", () => {
    expect(normalizeAddress("192.168.1.20")).toBe("http://192.168.1.20:48921");
    expect(normalizeAddress("example.local:49000")).toBe("http://example.local:49000");
    expect(normalizeAddress("[::1]")).toBe("http://[::1]:48921");
  });

  it("preserves complete origins and rejects paths or embedded credentials", () => {
    expect(normalizeAddress("https://remote.example")).toBe("https://remote.example");
    expect(normalizeAddress("host:80")).toBe("http://host");
    expect(() => normalizeAddress("http://host/path")).toThrow(/不要包含路径/u);
    expect(() => normalizeAddress("http://user:pass@host")).toThrow(/凭据/u);
  });
});

describe("RemoteClient", () => {
  it("retains the browser global receiver when calling the default fetch function", async () => {
    const fetcher = vi.fn(function (this: unknown) {
      expect(this).toBe(globalThis);
      return Promise.resolve(new Response(JSON.stringify({ name: "Workstation" }), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetcher);
    const client = new RemoteClient("http://host:48921", "token");
    expect(await client.request("/info")).toEqual({ name: "Workstation" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("pairs without a token, then sends the bearer token in headers", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "secret", device_id: "phone", expires_at: 10 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [] }), { status: 200 }));
    const client = new RemoteClient("http://host:48921", "", fetcher as typeof fetch);
    await client.pair("123456", "Android");
    await client.request("/sessions");
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://host:48921/remote/v1/pair");
    expect((fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>).Authorization).toBeUndefined();
    expect((fetcher.mock.calls[1]?.[1]?.headers as Record<string, string>).Authorization).toBe("Bearer secret");
  });

  it("maps expired credentials to a re-pairing message", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    const client = new RemoteClient("http://host:48921", "expired", fetcher as typeof fetch);
    await expect(client.request("/info")).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining("重新配对"),
    });
  });

  it("surfaces safe server errors without accepting non-JSON success pages", async () => {
    const conflict = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "窗口仍在运行" }), { status: 409 }));
    await expect(new RemoteClient("http://host:48921", "token", conflict as typeof fetch).request("/agents/a", "DELETE"))
      .rejects.toThrow("窗口仍在运行");
    const html = vi.fn().mockResolvedValue(new Response("<html>proxy</html>", { status: 200 }));
    await expect(new RemoteClient("http://host:48921", "token", html as typeof fetch).request("/info"))
      .rejects.toThrow(/无法识别/u);
  });

  it("uses the Android native HTTP bridge with header credentials, bounded timeouts and disabled redirects", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(CapacitorHttp.request).mockResolvedValue({ status: 200, data: { ok: true }, headers: {}, url: "http://host:48921/remote/v1/watchdog/start" });
    const fetcher = vi.fn();
    const client = new RemoteClient("http://host:48921", "secret", fetcher as typeof fetch);
    expect(await client.request("/watchdog/start", "POST", {})).toEqual({ ok: true });
    expect(fetcher).not.toHaveBeenCalled();
    expect(CapacitorHttp.request).toHaveBeenCalledWith({
      url: "http://host:48921/remote/v1/watchdog/start",
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
      data: {}, responseType: "json", connectTimeout: 10000, readTimeout: 20000, disableRedirects: true,
    });
  });

  it("refuses incomplete pairing responses before retaining an unusable token", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: "secret" }), { status: 200 }));
    const client = new RemoteClient("http://host:48921", "", fetcher as typeof fetch);
    await expect(client.pair("123456", "Android")).rejects.toThrow("无效配对凭据");
    fetcher.mockResolvedValue(new Response(JSON.stringify({ sessions: [] }), { status: 200 }));
    await client.request("/sessions");
    expect((fetcher.mock.calls[1]?.[1]?.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
