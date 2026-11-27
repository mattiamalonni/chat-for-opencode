import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/client/http";
import { setSdkBridge, type SdkBridge } from "../../src/sdk/loader";
import type { SdkHost } from "../../src/sdk/bridge";
import { describeServerError, ExternalServer, ManagedServer, type ServerState } from "../../src/server/server";

function host(version = "2.4.1"): SdkHost {
  return {
    server: { info: vi.fn().mockResolvedValue({ version }) },
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as SdkHost;
}

function bridge(api: SdkHost = host(), failure?: unknown): SdkBridge {
  return {
    createHost: failure ? vi.fn().mockRejectedValue(failure) : vi.fn().mockResolvedValue(api),
    makeNetworkApi: vi.fn().mockReturnValue(api),
  };
}

afterEach(() => setSdkBridge(undefined));

describe("ManagedServer (embedded SDK)", () => {
  it("creates one in-process host, is idempotent and closes it on stop", async () => {
    const api = host();
    const sdk = bridge(api);
    setSdkBridge(sdk);
    const logs: string[] = [];
    const server = new ManagedServer({ folder: "/work", log: (l) => logs.push(l) });
    const conn = await server.ensure();
    expect(conn.embedded).toBe(true);
    expect(conn.baseUrl).toBe("in-process");
    expect(conn.directory).toBe("/work");
    expect(server.state.status).toBe("running");
    expect(await server.ensure()).toBe(conn);
    expect(sdk.createHost).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).not.toContain("password");
    await server.stop();
    expect(api.close).toHaveBeenCalledTimes(1);
    expect(server.state.status).toBe("stopped");
  });

  it("closes a host whose startup was still running when stop() was called", async () => {
    const api = host();
    let resolveHost!: (value: SdkHost) => void;
    setSdkBridge({
      createHost: vi.fn(() => new Promise<SdkHost>((resolve) => (resolveHost = resolve))),
      makeNetworkApi: vi.fn(),
    });
    const server = new ManagedServer({ folder: "/work", log: () => {} });
    const starting = server.ensure();
    await Promise.resolve();
    const stopping = server.stop();
    resolveHost(api);
    await starting;
    await stopping;
    expect(api.close).toHaveBeenCalledTimes(1);
    expect(server.state.status).toBe("stopped");
  });

  it("closes the host when its first info() call fails", async () => {
    const api = host();
    (api.server.info as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    setSdkBridge(bridge(api));
    const server = new ManagedServer({ folder: "/work", log: () => {} });
    await expect(server.ensure()).rejects.toMatchObject({ kind: "startFailed" });
    expect(api.close).toHaveBeenCalledTimes(1);
  });

  it("reports a host startup failure as startFailed", async () => {
    setSdkBridge(bridge(host(), new Error("boom")));
    const server = new ManagedServer({ folder: "/work", log: () => {} });
    const err = await server.ensure().catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "startFailed" });
    expect(server.state.status).toBe("failed");
  });

  it("restart creates a fresh host", async () => {
    const first = host();
    setSdkBridge(bridge(first));
    const server = new ManagedServer({ folder: "/work", log: () => {} });
    const conn1 = await server.ensure();
    const next = host("2.4.2");
    setSdkBridge(bridge(next));
    const conn2 = await server.restart();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(conn2).not.toBe(conn1);
    await server.dispose();
  });

  it("publishes state transitions", async () => {
    setSdkBridge(bridge());
    const server = new ManagedServer({ folder: "/work", log: () => {} });
    const states: ServerState["status"][] = [];
    server.onDidChange((s) => states.push(s.status));
    await server.ensure();
    await server.stop();
    expect(states).toEqual(["starting", "running", "stopped"]);
  });
});

describe("server error diagnostics", () => {
  it("keeps the HTTP status and tag in error details", () => {
    expect(describeServerError(new ApiError("boom", 503, "Unavailable"))).toBe("HTTP 503 (Unavailable): boom");
    expect(describeServerError(new Error("oops"))).toBe("Error: oops");
  });
});
describe("ExternalServer", () => {
  it("passes the stored password to the generated network client", async () => {
    const sdk = bridge(host("2.4.0"));
    setSdkBridge(sdk);
    const server = new ExternalServer({ folder: "/", endpoint: "http://127.0.0.1:9", getPassword: async () => "pw", log: () => {} });
    const conn = await server.ensure();
    expect(conn.password).toBe("pw");
    expect(conn.embedded).toBe(false);
    expect(sdk.makeNetworkApi).toHaveBeenCalledWith("http://127.0.0.1:9", "pw");
  });

  it("keys the connection by a password digest, never the password itself", async () => {
    setSdkBridge(bridge());
    const make = (password: string) =>
      new ExternalServer({ folder: "/work", endpoint: "http://h:1", getPassword: async () => password, log: () => {} });
    const a = await make("s3cret").ensure();
    const b = await make("other").ensure();
    expect(a.key).not.toContain("s3cret");
    expect(a.key).not.toBe(b.key);
    expect((await make("s3cret").ensure()).key).toBe(a.key);
  });

  it("maps 401 to unauthorized and other failures to unreachable", async () => {
    setSdkBridge(bridge({ server: { info: vi.fn().mockRejectedValue(new ApiError("no", 401)) } } as unknown as SdkHost));
    const bad = new ExternalServer({ folder: "/", endpoint: "http://127.0.0.1:9", getPassword: async () => "pw", log: () => {} });
    await expect(bad.ensure()).rejects.toMatchObject({ kind: "unauthorized" });

    setSdkBridge(bridge({ server: { info: vi.fn().mockRejectedValue(new Error("offline")) } } as unknown as SdkHost));
    const offline = new ExternalServer({ folder: "/", endpoint: "http://127.0.0.1:9", getPassword: async () => "x", log: () => {} });
    await expect(offline.ensure()).rejects.toMatchObject({ kind: "unreachable" });
  });
});
