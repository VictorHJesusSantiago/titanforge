/**
 * Generates the minimal client-side HMR runtime as a plain JS source string, meant to be
 * injected into the served HTML page. It connects to the HMR WebSocket and reacts to
 * `HmrMessage`s.
 *
 * Honest, documented scope: on an `update` message, it calls `window.__titanforge_applyUpdate`
 * if the page defines one (the app's own re-render hook), and falls back to a full
 * `location.reload()` otherwise. It does **not** implement fiber-level patching like React Fast
 * Refresh — component-local state is not preserved across a hot swap; the affected route is
 * simply re-rendered (or, absent an app-provided hook, the page fully reloads). That's a
 * deliberate, stated boundary rather than a partially-working implementation of state
 * preservation.
 */
export function generateHmrClientScript(wsUrl: string): string {
  return `(function () {
  var socket = new WebSocket(${JSON.stringify(wsUrl)});
  socket.addEventListener('message', function (event) {
    var msg = JSON.parse(event.data);
    if (msg.type === 'update') {
      if (typeof window.__titanforge_applyUpdate === 'function') {
        window.__titanforge_applyUpdate(msg.filePath, msg.code);
      } else {
        window.location.reload();
      }
    } else if (msg.type === 'full-reload') {
      window.location.reload();
    }
  });
})();
`;
}
