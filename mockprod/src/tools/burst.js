/**
 * Start work right now, on top of the scheduled traffic.
 *   npm run burst -- 10                         10 random customer journeys
 *   npm run burst -- 3 online-purchase          3 journeys of one type (online-purchase | dealership-finance | warranty-add-on)
 *   npm run burst -- flows 20                   20 instances of random standalone flows
 *   npm run burst -- flows 5 "Battery Replacement Service"
 *   npm run burst -- all                        one instance of every standalone flow
 */
const port = process.env.ENGINE_PORT || 7000;
const [first, second, third] = process.argv.slice(2);

let path = '/journeys';
let body = { count: Number(first || 5), type: second };
if (first === 'flows') {
  path = '/flows';
  body = { count: Number(second || 5), name: third };
} else if (first === 'all') {
  path = '/flows';
  body = { all: true };
}

fetch(`http://localhost:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then((r) => r.json())
  .then((result) => console.log(result))
  .catch((err) => { console.error(`Engine not reachable on :${port} — is the environment running?`, err.message); process.exit(1); });
