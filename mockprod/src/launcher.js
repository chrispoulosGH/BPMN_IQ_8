/**
 * Starts the mock production environment: one Node process per catalog
 * application (each its own OpenTelemetry service), then the process engine
 * once every application answers /healthz. Crashed processes are restarted.
 *
 *   npm start                     (OTLP → http://localhost:4318 by default)
 */
const path = require('path');
const { fork } = require('child_process');
const { catalog, appIds, appUrl, ENGINE_PORT, SERVICE_HOST } = require('./catalog');

const children = new Map();
let stopping = false;

function start(name, script, env) {
  const child = fork(path.join(__dirname, script), [], { env: { ...process.env, ...env }, stdio: 'inherit' });
  children.set(name, child);
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (stopping) return;
    console.error(`[launcher] ${name} exited (${signal || code}); restarting in 3s`);
    setTimeout(() => start(name, script, env), 3000);
  });
}

async function waitHealthy(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  console.log(`[launcher] ${appIds.length} applications, ${catalog.flows.length} flows; OTLP → ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318'}`);
  for (const id of appIds) start(catalog.applications[id].acronym, 'appService.js', { APP_ID: id });
  const results = await Promise.all(appIds.map((id) => waitHealthy(appUrl(id))));
  const down = appIds.filter((_, i) => !results[i]);
  if (down.length) console.error(`[launcher] not healthy: ${down.join(', ')}`);
  start('bpmn-process-engine', 'processEngine.js', {});
  if (await waitHealthy(`http://${SERVICE_HOST}:${ENGINE_PORT}`)) console.log(`[launcher] ready — engine control API on http://localhost:${ENGINE_PORT}/status`);
}

const stop = () => {
  stopping = true;
  for (const child of children.values()) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
