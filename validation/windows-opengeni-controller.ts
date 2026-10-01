import { strict as assert } from "node:assert";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { CuaComputerBackend } from "../src/cua/backend";
import { ComputerDriver } from "../src/computer-driver";
import { ComputerSupervisor } from "../src/computer-supervisor";
import type { ComputerAction, ComputerObservation } from "@opengeni/contracts";

// Public disposable Windows experiment only. The Mac pilot and both source
// revisions stay unchanged. This transport projects the native MCP envelope;
// it does not certify the packaged UniFFI SDK on Windows.
const evidence = process.env.OG_CUA_EVIDENCE!;
const fixtureBinary = process.env.OG_CUA_FIXTURE!;
const driverBinary = process.env.OG_CUA_DRIVER!;
assert.ok(evidence && fixtureBinary && driverBinary);
const records: unknown[] = [];
async function record(name: string, value: unknown) {
  records.push({ name, at: new Date().toISOString(), value });
  await Bun.write(join(evidence, "controller-proof.json"), JSON.stringify(records, null, 2));
  console.log(JSON.stringify({ stage: name }));
}

class NativeMcpRuntime {
  private readonly process = Bun.spawn([driverBinary], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CUA_DRIVER_RS_TELEMETRY_ENABLED: "false" },
  });
  private sequence = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly errorText = new Response(this.process.stderr).text();
  private readonly reader = this.read();
  targetArgs: Record<string, unknown> = {};
  captureProved = false;
  closed = false;
  private async read() {
    const lines = createInterface({ input: Readable.fromWeb(this.process.stdout as any) });
    try {
      for await (const line of lines) {
        const response = JSON.parse(line);
        if (typeof response.id !== "number") continue;
        const pending = this.pending.get(response.id);
        if (!pending) continue;
        this.pending.delete(response.id);
        if (response.error) pending.reject(new Error(JSON.stringify(response.error)));
        else pending.resolve(response.result);
      }
    } catch (error) {
      for (const pending of this.pending.values()) pending.reject(new Error(String(error)));
    } finally {
      for (const pending of this.pending.values())
        pending.reject(new Error("Owned CUA driver closed"));
      this.pending.clear();
    }
  }
  private request(method: string, params: unknown): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Native MCP request timed out: " + method));
      }, 30_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async initialize() {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "opengeni-public-windows-controller-experiment", version: "1" },
    });
    this.process.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
  }
  rawTool(name: string, args: unknown) {
    return this.request("tools/call", { name, arguments: args });
  }
  async callTool(name: string, argsJson: string): Promise<any> {
    const args = JSON.parse(argsJson);
    if (name === "get_window_state") {
      this.targetArgs = { pid: args.pid, window_id: args.window_id, session: args.session };
    }
    const result = await this.rawTool(name, name === "check_permissions" ? {} : args);
    const data = result.structuredContent;
    assert.ok(data && typeof data === "object", "Native structured result missing");
    if (name === "check_permissions") {
      // Windows uses UIA/PostMessage flags. Capture capability is projected
      // only after a real PNG was proved, not inferred from those input flags.
      await record("native-windows-permissions", data);
      data.accessibility = data.uia === true && data.post_message === true;
      data.screen_recording = this.captureProved;
    } else if (name === "get_window_state" && args.include_accessibility_tree) {
      for (const element of data.elements ?? []) {
        element.role =
          (
            {
              Edit: "AXTextField",
              Button: "AXButton",
              Text: "AXStaticText",
              Slider: "AXSlider",
            } as any
          )[element.role] ?? element.role;
        element.actions = (element.actions ?? []).map((action: string) =>
          action === "invoke" ? "AXPress" : action,
        );
      }
    }
    if (name === "get_window_state" && args.include_screenshot) {
      const images = (result.content ?? []).filter((item: any) => item.type === "image");
      await record("native-windows-capture-envelope", {
        pid: data.pid,
        windowId: data.window_id,
        captureIdPresent: typeof data.capture_id === "string",
        width: data.screenshot_width,
        height: data.screenshot_height,
        nativeFrameValidity: data.screenshot_frame_valid ?? null,
        screenshotError: data.screenshot_error ?? null,
        imageCount: images.length,
      });
      // Windows does not emit the Mac-only screenshot_frame_valid flag.
      // Project validity only after checking the native capture identity,
      // publication and its actual PNG bytes; never invent a capture ID.
      assert.notEqual(result.isError, true);
      assert.equal(data.pid, args.pid);
      assert.equal(data.window_id, args.window_id);
      assert.ok(typeof data.capture_id === "string" && data.capture_id.length > 0);
      assert.equal(data.screenshot_error, undefined);
      assert.equal(images.length, 1);
      assert.equal(images[0].mimeType, "image/png");
      const png = Buffer.from(images[0].data, "base64");
      assert.ok(png.length >= 24);
      assert.equal(png.readUInt32BE(0), 0x89504e47);
      assert.equal(png.readUInt32BE(16), data.screenshot_width);
      assert.equal(png.readUInt32BE(20), data.screenshot_height);
      assert.ok(data.screenshot_width > 0 && data.screenshot_height > 0);
      data.screenshot_frame_valid = true;
    }
    if (["click", "set_value", "press_key", "type_text", "drag", "scroll"].includes(name)) {
      await record("native-" + name, { args, isError: result.isError === true, data });
    }
    return {
      text: (result.content ?? [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n"),
      images: (result.content ?? [])
        .filter((c: any) => c.type === "image")
        .map((c: any) => ({ mimeType: c.mimeType, dataBase64: c.data })),
      structuredJson: JSON.stringify(data),
      isError: result.isError === true,
      errorCode: data.code ?? data.refusal?.code,
      action: data.effect ? data : undefined,
      verification: undefined,
      degraded: data.degraded === true,
      rawJson: JSON.stringify(result),
    };
  }
  async shutdown() {
    this.process.stdin.end();
    const closed = await Promise.race([
      this.process.exited.then(() => true),
      Bun.sleep(3_000).then(() => false),
    ]);
    if (!closed) this.process.kill();
    await this.process.exited;
    await this.reader;
    await Bun.write(join(evidence, "native-driver-stderr.log"), await this.errorText);
    this.closed = true;
  }
}

const runtime = new NativeMcpRuntime();
const fixture = Bun.spawn([fixtureBinary], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
  env: { ...process.env, CUA_E2E_FIXTURE_STATE_PATH: join(evidence, "fixture-state.json") },
});
let supervisor: ComputerSupervisor | undefined;
let stream: Awaited<ReturnType<ComputerSupervisor["subscribeFrames"]>> | undefined;
try {
  await runtime.initialize();
  let window: any;
  for (let attempt = 0; attempt < 40 && !window; attempt++) {
    const result = await runtime.rawTool("list_windows", {});
    assert.notEqual(result.isError, true);
    window = result.structuredContent?.windows?.find(
      (w: any) => w.pid === fixture.pid && w.title === "CuaTestHarness WPF",
    );
    if (!window) await Bun.sleep(250);
  }
  assert.ok(window, "Owned WPF window not found");
  const initial = await runtime.rawTool("get_window_state", {
    pid: fixture.pid,
    window_id: window.window_id,
    include_screenshot: true,
    include_accessibility_tree: false,
  });
  assert.notEqual(initial.isError, true);
  const firstImage = initial.content.find((c: any) => c.type === "image");
  assert.equal(firstImage?.mimeType, "image/png");
  const firstBytes = Buffer.from(firstImage.data, "base64");
  assert.equal(firstBytes.readUInt32BE(0), 0x89504e47);
  runtime.captureProved = true;
  await Bun.write(join(evidence, "native-initial.png"), firstBytes);
  await record("native-window-and-capture", { window, pngBytes: firstBytes.length });

  const reference = {
    computerSessionId: crypto.randomUUID(),
    controllerGeneration: crypto.randomUUID(),
  };
  supervisor = await ComputerSupervisor.open({
    rootDirectory: join(evidence, "controller"),
    // The frozen default allocator supports native Mac/Linux seats. This
    // runner already owns an interactive Windows desktop, verified before
    // fixture launch; supply it through the existing allocator seam rather
    // than changing production platform admission to make an experiment pass.
    environmentAllocator: {
      allocate: async (context) => {
        const proof = await Bun.file(join(evidence, "source-proof.json")).json();
        assert.ok(Number.isInteger(proof.windowsSession) && proof.windowsSession > 0);
        await record("owned-windows-environment", {
          windowsSession: proof.windowsSession,
          productionAllocatorChanged: false,
          rfbPort: null,
        });
        return {
          seatId: `windows-ci:${proof.windowsSession}`,
          displayId: `windows-ci:${proof.windowsSession}`,
          rfbPort: null,
          environment: context.baseEnvironment,
          close: async () => {
            await record("owned-windows-environment-released", {
              windowsSession: proof.windowsSession,
              physicalDesktopTerminated: false,
            });
          },
        };
      },
    },
    createDriver: async (context) =>
      new ComputerDriver({
        computerSessionId: context.computerSessionId,
        controllerGeneration: context.controllerGeneration,
        client: await CuaComputerBackend.open(runtime),
      }),
  });
  const session = await supervisor.createSession(reference);
  await record("normalized-experiment-session", {
    platform: session.platform,
    adapter: session.adapter,
    capabilities: session.capabilities,
  });
  assert.equal(session.platform, "macos", "Frozen production pilot must remain Mac-only");
  const target = session.targets.find(
    (t) => t.id === "cua:window:" + fixture.pid + ":" + window.window_id,
  );
  assert.ok(target);
  const command = (observed: ComputerObservation, action: ComputerAction) => ({
    protocolVersion: 1 as const,
    operationId: crypto.randomUUID(),
    ...reference,
    targetId: target.id,
    expectedTargetGeneration: observed.target.targetGeneration,
    expectedObservationId: observed.observationId,
    expectedFrameId: null,
    actor: { kind: "agent" as const, subjectId: "agent:public-windows-fixture" },
    action,
  });
  let observed = await supervisor.observe(reference, target.id);
  await record("initial-controller-observation", observed);
  const fields = (observed.semantic as any)?.roots?.filter(
    (n: any) => n.role === "textbox" && n.actions.includes("set_value"),
  );
  assert.equal(fields?.length, 2, "Expected both real WPF edit controls");
  const field = fields.find((n: any) => !String(n.name ?? "").includes("deferred")) ?? fields[0];
  assert.ok(field);
  const replacement = "Replacement æøå 🦊";
  const replaced = await supervisor.action(
    command(observed, {
      type: "semantic",
      locator: { kind: "ref", ref: field.ref },
      action: "set_value",
      value: replacement,
    }),
  );
  await record("unicode-replacement-receipt", replaced);
  assert.equal(replaced.state, "completed");
  let readback = await runtime.rawTool("get_window_state", {
    ...runtime.targetArgs,
    include_screenshot: false,
    include_accessibility_tree: true,
  });
  assert.equal(
    readback.structuredContent?.elements?.filter((e: any) => e.value === replacement).length,
    1,
  );
  await record("native-unicode-readback", readback.structuredContent);
  observed = await supervisor.observe(reference, target.id);
  const increment = command(observed, {
    type: "semantic",
    locator: { kind: "role", role: "button", name: "Increment", exact: true },
    action: "invoke",
  });
  const first = await supervisor.action(increment);
  const replay = await supervisor.action(increment);
  assert.equal(first.state, "completed");
  assert.equal(replay.state, "completed");
  await Bun.sleep(250);
  const state = await Bun.file(join(evidence, "fixture-state.json")).json();
  assert.equal(state["lbl-counter"].text, "counter=1");
  await record("durable-replay-native-counter", {
    first,
    replay,
    counter: state["lbl-counter"].text,
  });

  stream = await supervisor.subscribeFrames(reference, target.id, {
    format: "png",
    maxWidth: 560,
    maxHeight: 720,
  });
  const preview = await stream[Symbol.asyncIterator]().next();
  assert.equal(preview.done, false);
  await Bun.write(join(evidence, "live-preview.png"), preview.value!.data);
  observed = await supervisor.observe(reference, target.id);
  const currentField = (observed.semantic as any).roots.find(
    (n: any) => n.role === "textbox" && n.value === replacement,
  );
  assert.ok(currentField);
  await Bun.sleep(400);
  const edit = await supervisor.action(
    command(observed, {
      type: "semantic",
      locator: { kind: "ref", ref: currentField.ref },
      action: "set_value",
      value: "Viewer open æøå 🦊",
    }),
  );
  await record("live-preview-edit-receipt", edit);
  assert.equal(edit.state, "completed");
  readback = await runtime.rawTool("get_window_state", {
    ...runtime.targetArgs,
    include_screenshot: false,
    include_accessibility_tree: true,
  });
  assert.equal(
    readback.structuredContent?.elements?.filter((e: any) => e.value === "Viewer open æøå 🦊")
      .length,
    1,
  );
  const final = await supervisor.capture(reference, target.id, {
    format: "png",
    maxWidth: 560,
    maxHeight: 720,
  });
  await Bun.write(join(evidence, "final.png"), final.data);
  await record("final-capture", {
    width: final.width,
    height: final.height,
    bytes: final.data.length,
  });
  observed = await supervisor.observe(reference, target.id);
  const retained = (observed.semantic as any).roots.find(
    (n: any) => n.role === "textbox" && n.value === "Viewer open æøå 🦊",
  );
  assert.ok(retained);
  await runtime.rawTool("get_window_state", {
    ...runtime.targetArgs,
    include_screenshot: false,
    include_accessibility_tree: true,
  });
  const refused = await supervisor.action(
    command(observed, {
      type: "semantic",
      locator: { kind: "ref", ref: retained.ref },
      action: "set_value",
      value: "Must not replace",
    }),
  );
  await record("genuine-semantic-refresh-refusal", refused);
  assert.equal(refused.state, "failed");
  assert.equal(refused.error?.code, "observation_stale");
  readback = await runtime.rawTool("get_window_state", {
    ...runtime.targetArgs,
    include_screenshot: false,
    include_accessibility_tree: true,
  });
  assert.equal(
    readback.structuredContent?.elements?.filter((e: any) => e.value === "Viewer open æøå 🦊")
      .length,
    1,
  );
  const finalState = await Bun.file(join(evidence, "fixture-state.json")).json();
  assert.equal(finalState["lbl-counter"].text, "counter=1");
  await record("controller-experiment-passed", {
    windowsProductionEnabled: false,
    packagedWindowsSdkAccepted: false,
    nativeCounter: "counter=1",
    previewAttached: true,
  });
} catch (error) {
  await record("experiment-failed", {
    message: String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  throw error;
} finally {
  try {
    try {
      await stream?.close();
    } finally {
      if (supervisor) await supervisor.close();
      else await runtime.shutdown();
    }
  } finally {
    fixture.kill();
    await fixture.exited;
    await record("owned-fixture-cleaned", {
      fixtureExit: true,
      nativeDriverClosed: runtime.closed,
    });
  }
}