# BPMN IQ mock production environment

Simulated applications that run three business flows end to end in real time,
instrumented with OpenTelemetry and exported through an OpenTelemetry Collector
to Observe. Every span carries the business flow, task, lane and application.
That's enough to rebuild each flow's BPMN 2.0 XML from the traces alone.

The three flows form one car-purchase journey:

| Flow | Tasks | Lanes | Applications |
|---|---|---|---|
| Digital Retailing Journey | 10 | Customer, System | DIGITAL-RETAIL, SALES-CONFIG, CREDIT-DECIDE, REMARKETING-SYS, FINANCE-HUB |
| Customer Credit Application | 10 | F&I Manager, System, Customer | CREDIT-DECIDE, DEALER-NET |
| Warranty Contract Execution | 11 | Warranty Salesman, Customer, Manager | WARRANTY-SALES, DEALER-NET, CREDIT-DECIDE, VSC-ADMIN, DIGITAL-RETAIL, FINANCE-HUB |

### Every business flow (111)

The catalog exports **every BPMN IQ diagram**, so all 110 modeled flows run, plus the undocumented upsell flow below.

- **Customer journeys:** online, in-store and fleet purchases run as journeys (`DAILY_JOURNEYS`); see *Vehicles sold* below.
- **The other 107 flows run standalone**, each on its domain's clock:

  | Profile | Domains | Hours | Per flow per day |
  |---|---|---|---|
  | dealership | Sales, F&I, Warranty, After-Sales, Marketing | dealership hours, busy Saturdays | ~24 |
  | office | Corporate, Dealer Network, Engineering | weekdays 08–18 | ~6 |
  | plant | Manufacturing & Supply Chain | three shifts, 24/7 | ~30 |
  | always-on | Connected Vehicle & Mobility | 24/7, evening peak | ~36 |

  - **Adjustments by flow name:** annual, strategic and budget flows run about 0.5 a day. Programs, audits, launches, campaigns and planning are ×0.4; recalls ×0.5.
  - **Total:** about 2,000 standalone instances on an average day. `STANDALONE_DAILY_SCALE` scales it (0 = off).
- **55 application services:** the 40 catalogued apps the flows use, plus 15 **uncatalogued** apps that diagrams name but the Applications catalog doesn't have (PLM-CORE, QMS-CENTRAL, PARTS-INVENTORY, HR-CENTRAL…). These host the 131 APIs that have no provider in the catalog, and carry `app.catalogued=false` and `api.provider.source="uncatalogued"`.
  - 7 more provider-less APIs are hosted on the task's catalogued diagram app (`api.provider.source="diagram"`).
  - Memory is about 2 GB for the simulator container.
- **Shared routes:** 19 routes are shared by several APIs (flow variants). Each is registered once, and the engine's `x-api-id` header selects the API.
- **Task application:** `bpmn.task.application.*` is the task's application(s) from its diagram (a string array). It can differ from `api.provider.app_id`, the app that provides the API the task calls.
- **Burst commands:** `npm run burst -- all` starts one instance of every standalone flow. `npm run burst -- flows 5 "Battery Replacement Service"` starts instances of one flow.
- **Verified** with one instance per flow:
  - 108/111 flows rebuild from traces matching their source diagram on every check.
  - The other 3 had only an abandoned instance, so their later tasks weren't observed yet.
  - Discovery: 110 matched by diagram id, and only the upsell flow is discovered.

### Vehicles sold

A vehicle counts as **sold when it changes hands**, once per deal, however many flows the deal went through:

| Sale event (task that completes it) | Condition | Channel | Units |
|---|---|---|---|
| New Vehicle Delivery Experience (*Sign Delivery Confirmation*) | new | online / in-store, from the journey | 1 |
| Fleet Order Fulfillment (*Complete Fleet Delivery*) | new | fleet | the order's size (5–60) |
| Wholesale Vehicle Disposition (*Complete Wholesale Sale*) | used | wholesale | 1 |

Contracts, financing, warranty, GAP and the upsell add to a sale but are not one.

- **Journeys:**
  - `online-purchase`: Digital Retailing → [upsell] → [credit] → [warranty] → delivery.
  - `dealership-purchase`: Sales Contract Finalization → [upsell] → [credit] → [warranty] → delivery.
  - `fleet-purchase`: Fleet Customer Sales Process → Fleet Order Fulfillment.
  - `warranty-add-on`: warranty only (not a vehicle sale).
- **Every span of a deal** carries `business.deal.id`, `business.vehicle.vin` and `business.sale.channel` (baggage).
- **The completing task span** carries a `business.vehicle.sold` event (deal, VIN, model, channel, condition, units, price) and `business.sale.completed=true`.
- **Metrics:** `business.vehicles.sold` and `business.sales.revenue` (USD) counters, labelled channel × condition × flow. Every series is created at 0 at startup so Prometheus sees each one's first sale.
- **Where to see it:**
  - the **Vehicles sold** row on the Grafana dashboard;
  - the **Vehicles sold** tile on BPMN IQ's Dashboard tab (`GET /api/business-kpis/vehicles-sold?hours=24`);
  - in Prometheus: `round(sum by (business_sale_channel) (increase(business_vehicles_sold_total{bpmn_process_name!=""}[1d])))`.
- **Reconciled:** the counters match the sale events in the collector's raw span export exactly (50 deals, 90 vehicles, none counted twice).
  - Don't count sales with Tempo *search*: after a Tempo restart it can miss traces written during its first minutes, even though they're stored (fetch by id works).

### Traffic with no business context (Undefined Processes)

`dealer-workstation` ([src/unlabeledClient.js](src/unlabeledClient.js)) simulates users calling the applications' APIs **with no business context**: no `bpmn.*`/`business.*` baggage and no process or task spans. Each action is its own trace. It runs about 160 sessions/day (`UNLABELED_PER_DAY`; `UNLABELED=off` disables it). Scenarios are in [catalog/unlabeled-scenarios.json](catalog/unlabeled-scenarios.json):

| Scenario | Share | What it is |
|---|---|---|
| vacant | 45% | an established flow run exactly as modeled, empty header |
| deviation | 35% | an established flow with one change: a skipped step, two steps swapped, or a repeated step (rework) |
| emergent | 20% | a sequence no diagram has: *Self-Service Lease Buyout*, *Service-Lane Trade-Up* |

**The case id.** With no baggage, the only thing linking one user's actions is the session: the client sends `x-session-id` and every app records `session.id` (OTel semconv). Process discovery needs *some* case id; without one, separate actions can't be stitched into instances.

**What BPMN IQ does with it.** **Business Processes › Undefined Processes** calls `GET /api/undefined-processes`, which:
1. reads spans with no `bpmn.process.name` from Tempo and groups them by `session.id`;
2. maps each call to the API catalog (method + route);
3. compares each session with all established flows by API sequence (longest common subsequence):
   - an exact match → that flow, run with an empty header;
   - ≥60% → that flow with named deviations;
   - otherwise → clustered into an undefined process and rebuilt as BPMN, with application lanes and a closest-flow score.

`npm run burst -- sessions 20 emergent` starts sessions now (control on :7099).

**Verified:** 90 sessions → 40 conformant, 30 deviating (each with the right deviation), 20 undefined in 2 processes (14 + 6), which is the generated ground truth exactly.

### A fourth, undocumented flow: Vehicle Feature & Package Upsell

**Vehicle Feature & Package Upsell** also runs in mock production, but it has **no diagram in BPMN IQ**. It is a 12-task flow across Customer, Sales Consultant and System lanes that upsells leather, performance, color, technology, cold-weather and towing packages with incentives. Its applications are CRM-360, ANALYTICS-HUB, SALES-CONFIG, PRICING-ENGINE, DEALER-NET, DIGITAL-RETAIL, ACCESSORY-CFG, CREDIT-DECIDE and ORDER-MGMT, and it uses a new **Upsell Offer** data object.

- **Definition:** [catalog/discovered-flows.json](catalog/discovered-flows.json). The catalog export merges it in with `discovered: true`.
- **Where it runs in a journey:** 60% of online purchases go through it after Digital Retailing, and 50% of dealership-finance journeys start with it. Declining the offer (12% at each customer task) doesn't end the purchase.
- **How BPMN IQ finds it:** **Business Processes › Discovered Processes**. `GET /api/discovered-processes` lists every `bpmn.process.name` that Tempo has seen, drops the ones that have a diagram, and rebuilds the rest as BPMN 2.0 from their traces.

## Run it

```bash
cp .env.example .env          # set OBSERVE_COLLECTION_ENDPOINT and OBSERVE_INGEST_TOKEN
docker compose up -d --build  # collector + simulator
npm run burst -- 10           # optional: start 10 journeys now, on top of scheduled traffic
```

- `OBSERVE_MODE=local` keeps telemetry in `./data` only.
- `OBSERVE_MODE=observe` also exports to Observe.

**Without Docker:** run any OTLP/HTTP collector on `localhost:4318`, then:

```bash
npm install
npm start
```

The engine's control API runs on <http://localhost:7000/status>.

### Grafana (local)

The Compose stack also runs **Grafana Tempo** (traces), **Prometheus** (metrics) and **Grafana**. The collector sends to them whatever `OBSERVE_MODE` is set to.

- **Grafana:** <http://localhost:3000>, no login (anonymous Editor; it's a local mock).
  - The home dashboard is **BPMN business flows**, with a *Business flow* picker. It has:
    - completed, abandoned and failed counts, plus the completion rate;
    - instances per hour by outcome, which follows the daily curve;
    - instances in flight;
    - p95 task duration per task and per lane;
    - a service map;
    - per-app request rate, latency and errors;
    - data objects handed between apps;
    - trace tables: process instances, abandoned or failed instances, slow human tasks, API errors.
  - Click a trace ID to open its waterfall: process → task → API → db / hand-off, across all services.
- **Explore › Tempo** takes TraceQL on the BPMN attributes, for example:
  - `{ span.bpmn.process.name = "Warranty Contract Execution" && name =~ "process .*" }` — every instance of a flow
  - `{ span.bpmn.task.name = "Manager Final Review & Approval" && duration > 60s }` — slow reviews
  - `{ span.bpmn.process.outcome = "abandoned" }`
  - `{ span.business.journey.id = "JRN-…" }` — one customer across all three flows
  - `{ span.bpmn.lane.name = "Customer" && span.bpmn.task.performer = "human" } | avg(duration) by (span.bpmn.task.name)`
- **Prometheus:** <http://localhost:9090>.
  - It receives the simulator's metrics over OTLP, with names translated, e.g. `bpmn_process_instances_total` and `bpmn_task_duration_seconds_bucket`.
  - Tempo's generated `traces_spanmetrics_*` and `traces_service_graph_*` metrics arrive through remote write. They are broken down by `bpmn_process_name`, `bpmn_task_name` and `bpmn_lane_name`.
- **Retention:** traces 7 days (Tempo), metrics 15 days.
- **Dashboard source:** the dashboard is generated by [observability/grafana/build-dashboard.js](observability/grafana/build-dashboard.js). Edit it and re-run it with `node`. Grafana reloads the provisioned file.

### Observe setup

1. In Observe, go to **Data & integrations › Add data**. Create an ingest token (format `<token-id>:<secret>`) and copy your **collection URL**.
   - Use the URL Observe gives you rather than building it from the account ID: regional accounts use a different hostname.
2. Put both in `.env`. The collector sends traces and metrics to `<collection URL>/v2/otel`, using one exporter per signal: `x-observe-target-package: Tracing` for traces and `Metrics` for metrics.
3. Tenants provisioned on or after 2026-07-01 have `APM.flagREDMetricsGeneratedByAgent = true` by default. With this open-source collector, set it to `false`, or Service Explorer shows 0 requests/s.

## What runs

- **One process per application.** Each of the 8 catalog apps is its own OpenTelemetry service (`service.name` = app acronym). It hosts, at the real catalog endpoint, every API it is the provider of.
- **`bpmn-process-engine`** runs process instances task by task in the diagram's order.
- **Scheduler** (inside the engine) starts journeys in real time on a daily curve in `SIM_TIMEZONE`:
  - quiet overnight, with lunchtime and after-work peaks;
  - Saturdays ×1.4 and Sundays ×0.65;
  - `DAILY_JOURNEYS` sets the average per weekday (default 300).
- **Journeys:**
  - `online-purchase`: Digital Retailing, then Credit Application 55% of the time, then Warranty 45% of the time.
  - `dealership-finance`: Credit Application, then Warranty 45% of the time.
  - `warranty-add-on`: Warranty only.
- **Pacing:** human-lane tasks wait a compressed think time, with medians of about 25–55 s. Scale it with `WAIT_SCALE`. The System lane runs straight through. An instance takes a few minutes.
- **Faults:**
  - A base 0.4–2% error rate, depending on API lifecycle; the engine retries 5xx errors twice with backoff.
  - Latency jitter.
  - Occasional incident windows per app (8–20 min of slow responses and 503s; `INCIDENTS_PER_DAY_PER_APP`). `FORCE_INCIDENT_APP=CREDIT-DECIDE` starts one at boot.
  - Customer abandonment (`ABANDON_RATE`, 3%).

### Trace shape (one trace per process instance)

```
process Warranty Contract Execution            bpmn-process-engine (root)
└─ task Confirm Customer Purchase Decision     bpmn-process-engine
   └─ POST                                     engine → task app (HTTP client)
      └─ POST /api/v1/…/confirm-customer-…     WARRANTY-SALES (HTTP server, api.*)
         └─ request handler …
            ├─ Confirm Customer Purchase Decision logic
            │  ├─ SELECT service_contract      (db span)
            │  └─ INSERT service_contract
            └─ handoff Service Contract → DEALER-NET
               └─ POST /inbound/:objectId       DEALER-NET (HTTP server)
                  └─ receive Service Contract → INSERT service_contract
```

- **Data direction:** each task runs in its diagram application, which is the API's provider. That app then hands the data object to the API's consumer, so data moves provider → consumer, as each API records it.
- **Bodies:** request and response bodies are on the server span as `api.request.body` / `api.response.body` events. They are synthetic, with PII masked and restricted fields such as `ssn` dropped.
- **Linking flows:** flows in the same journey share `business.journey.id`. Each flow's root span links to the previous flow's root.

## Attribute dictionary

These are custom namespaces; OpenTelemetry has no business-process semantic conventions. The full list, with comments, is in [src/attributes.js](src/attributes.js).

`bpmn.process.*`, `bpmn.task.*`, `bpmn.lane.*` and `business.*` travel as W3C baggage. Every service copies them onto **every** span, so an auto-instrumented HTTP or database span three hops downstream still knows its flow and task.

| Attribute | On | Example |
|---|---|---|
| `bpmn.process.id` / `.name` | all spans | `Process_Warranty_Contract_Execution` / `Warranty Contract Execution` |
| `bpmn.process.instance_id` | all spans | `PI-…` |
| `bpmn.diagram.id`, `bpmn.domain`, `bpmn.subdomain` | all spans | BPMN IQ diagram id, hierarchy |
| `bpmn.task.id` / `.name` / `.type` / `.sequence` | task and below | `Task_Select_Payment_Method` |
| `bpmn.lane.id` / `.name` | task and below | `Lane_Customer` / `Customer` |
| `bpmn.task.performer` | task span | `human` \| `system` |
| `bpmn.sequence_flow.incoming.id` / `.source_id` | task span | real sequence-flow ids from the XML |
| `bpmn.sequence_flow.outgoing.id` / `.target_id` | task span | |
| `bpmn.task.application.id` / `.acronym` | task span | `LLM-004` / `DEALER-NET` |
| `bpmn.process.lanes` | root span | `["Lane_Customer\|Customer", …]` |
| `bpmn.start_event.id`, `bpmn.end_event.id`, `bpmn.process.outcome` | root span | `completed` \| `failed` \| `abandoned` |
| `api.id`, `api.name`, `api.type`, `api.lifecycle` | API server span | `API-00030` |
| `api.provider.app_id`, `api.consumer.app_id` | API server span | |
| `api.request.data_object`, `api.response.data_object` | API server span | `Service Contract` |
| `app.host.id` / `.name` / `.role` / `.datacenter` | API server span | derived catalog server |
| `business.journey.id` / `.type` / `.step`, `business.customer.id`, `business.dealer.code` | all spans | |
| `app.id`, `app.acronym`, `app.name`, `app.domain`, `app.criticality` | resource | |
| `sim.fault`, `sim.incident.active` | API server span | injected faults |

Root-span events: `bpmn.start_event`, `bpmn.end_event`, `bpmn.process.abandoned`, `bpmn.process.failed`.

Task-span events: `bpmn.task.created`, `bpmn.task.claimed`, `bpmn.task.completed`, `bpmn.task.retried`, `bpmn.task.failed`.

### Metrics

| Metric | What it measures |
|---|---|
| `bpmn.process.instances` | instances finished, by flow and outcome |
| `bpmn.process.duration` | process instance duration (s) |
| `bpmn.task.duration` | task duration including human work (s), by flow, task and lane |
| `bpmn.process.active_instances` | process instances in flight |
| `business.data_object.exchanged` | data objects handed between applications |
| `api.errors` | API calls that returned an error |
| HTTP metrics | standard `http.server.*` / `http.client.*` from auto-instrumentation |

## Rebuild BPMN 2.0 from traces

```bash
npm run reconstruct -- --compare                 # from ./data/traces.jsonl (collector file export)
npm run reconstruct -- --input=observe-spans.json --flow="Customer Credit Application"
```

This writes `data/reconstructed/<Flow>.bpmn`, containing:
- lanes, tasks, start and end events, and sequence flows, all using the original element ids;
- each task's application, as the same text annotations BPMN IQ uses;
- the domain, subdomain and flow metadata in the diagram name;
- an auto-layout.

**Input from Observe:** `--input` also accepts a JSON array of flat spans (`traceId, spanId, parentSpanId, name, startTime, endTime, attributes, resource, events`), which is the shape to export from Observe's span dataset.

`--compare` checks the result against the source model element by element. In the verification run (20 journeys, 32 instances including 4 abandoned), all three flows matched on:
- process id and lanes;
- tasks (id, name, lane);
- task applications;
- every sequence flow;
- start and end events.

## Refresh the catalog

The simulator reads only `catalog/catalog.json`. Regenerate it from BPMN IQ after diagram or API changes:

```bash
cd ../server && node scripts/export_mockprod_catalog.js            # default 3 flows
node scripts/export_mockprod_catalog.js --flows="Flow A|Flow B|Flow C"
```

Host servers in the catalog are derived and data objects are generated (illustrative), as in BPMN IQ itself.
