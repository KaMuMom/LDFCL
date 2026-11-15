const fs = require("node:fs/promises");
const assert = require("node:assert/strict");

// Pause the unmodified portable program before its main module runs. Redirect
// only Electron's known desktop folder, so startup shortcut maintenance is real
// but cannot touch the user's desktop. A failure leaves startup paused.
exports.isolateDesktop = async function isolateDesktop(port, directory) {
  await fs.mkdir(directory, { recursive: true });
  let endpoint;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(800),
      });
      endpoint = (await response.json())[0]?.webSocketDebuggerUrl;
      if (endpoint) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 120));
  }
  assert(endpoint, "Isolated portable main inspector was not available");
  const ws = new WebSocket(endpoint),
    pending = new Map();
  let id = 0,
    resolvePaused;
  const paused = new Promise((resolve) => {
    resolvePaused = resolve;
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const item = pending.get(message.id);
      if (item) {
        pending.delete(message.id);
        clearTimeout(item.timer);
        message.error
          ? item.reject(Error(message.error.message))
          : item.resolve(message.result);
      }
    }
    if (message.method === "Debugger.paused") resolvePaused(message.params);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const number = ++id,
        timer = setTimeout(() => {
          pending.delete(number);
          reject(Error("Inspector timeout: " + method));
        }, 10000);
      pending.set(number, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: number, method, params }));
    });
  try {
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    await send("Debugger.enable");
    await send("Runtime.runIfWaitingForDebugger");
    let timeout;
    const frame = await Promise.race([
      paused,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(Error("Portable did not pause before startup")),
          10000,
        );
      }),
    ]).finally(() => clearTimeout(timeout));
    const expression = `(() => { const app = require('electron').app; if (app.isReady()) throw Error('Desktop isolation was too late'); app.setPath('desktop', ${JSON.stringify(directory)}); return app.getPath('desktop'); })()`;
    const result = await send("Debugger.evaluateOnCallFrame", {
      callFrameId: frame.callFrames[0].callFrameId,
      expression,
      returnByValue: true,
    });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    assert.equal(result.result.value, directory);
    await send("Debugger.resume");
    return directory;
  } finally {
    for (const item of pending.values()) clearTimeout(item.timer);
    ws.close();
  }
};
