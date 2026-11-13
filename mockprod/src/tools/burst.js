/**
 * Start journeys right now, on top of the scheduled traffic.
 *   npm run burst -- 10                 10 random journeys
 *   npm run burst -- 3 online-purchase  3 of one type (online-purchase | dealership-finance | warranty-add-on)
 */
const port = process.env.ENGINE_PORT || 7000;
const count = Number(process.argv[2] || 5);
const type = process.argv[3];
fetch(`http://localhost:${port}/journeys`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count, type }) })
  .then((r) => r.json())
  .then((body) => console.log(body))
  .catch((err) => { console.error(`Engine not reachable on :${port} — is the environment running?`, err.message); process.exit(1); });
