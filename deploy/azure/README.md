# Deploying BPMN IQ to Azure (App Service B1)

**Target:** Azure App Service for containers, Linux **B1**. This was decided on 2026-11-18; see [../../azure-deploy-comparison.md](../../azure-deploy-comparison.md).

The reason: the Atlas cluster is a **free-tier M0** cluster with no private endpoints. App Service publishes fixed outbound IPs that go straight into the Atlas IP access list. Container Apps would need a NAT gateway to get a fixed IP. The Container Apps version of these scripts is kept in [alt-container-apps/](alt-container-apps/).

```
                    Microsoft Entra ID sign-in (App Service authentication)
                                    │
 users ──HTTPS──► App Service B1: BPMN IQ (Express API + React client, one container)
                    │  secrets ◄── Key Vault references (user-assigned identity)   files ◄── Azure Files
                    │
                    ├── public outbound IPs ──► MongoDB Atlas M0 (AWS us-east-1)   ← Atlas IP access list
                    └── VNet integration ────► VM: mockprod docker compose (simulator, OTel collector,
                                                   Tempo, Prometheus, Grafana) ──► Observe (optional)
```

Run the scripts in order from bash (Git Bash, WSL or Azure Cloud Shell) after `az login`. Each one can be re-run safely.

| Step | Script | What it does |
|---|---|---|
| 0 | — | `cp config.example.sh config.sh` and edit it: subscription, unique names. Region defaults to **East US** (Virginia, next to the Atlas cluster). |
| 1 | `01-foundation.sh` | Resource group, VNet (with the App Service integration subnet and VM subnet), Log Analytics, Container Registry, Key Vault, managed identity, Azure Files share, B1 Linux App Service plan |
| 2 | `02-secrets.sh` | Puts `MONGO_URI` (and optional Anthropic / Jira tokens) in Key Vault, read from your shell or prompted for |
| 3 | `03-app.sh` | Builds the image in ACR (tagged with the git commit), creates or updates the web app with Key Vault references, health check, Always On, HTTPS only, Azure Files mount and VNet integration. **Prints the outbound IPs for the Atlas allowlist.** Re-run to deploy a new version. |
| 4 | `04-entra-auth.sh` | Microsoft Entra ID sign-in (client secret in Key Vault), then switches the app to `AUTH_MODE=easyauth` |
| 5 | `05-mockprod-vm.sh` | Ubuntu VM in the VNet for the mock-production stack (private IP, no public ports by default) |
| 6 | `06-github-deploy.sh` | Lets GitHub Actions deploy pushes to `main`: an OIDC federated credential (main branch only, no secret), least-privilege roles on the registry and web app, and the repo variables the workflow reads |

## Atlas (free tier M0) — what to do

1. After step 3, add **every IP it prints** to Atlas → Network Access → IP Access List, as `/32` entries. Don't use `0.0.0.0/0`.
2. Those IPs stay fixed unless you change the plan's **pricing tier** (e.g. B1 → P0v3) or region. If you do, re-run step 3 and update the list.
3. **The connection string:** step 2 asks for the existing `MONGO_URI` from `server/.env`, which includes `/bpmn_iq`. Nothing needs migrating.
4. **M0 limits to keep in mind for production use:**
   - 512 MB storage (currently about 140 MB);
   - a connection cap and shared, throttled throughput;
   - **no backups.**

   Moving to a dedicated tier (M10+) later would add backups and private endpoints, at which point [alt-container-apps/](alt-container-apps/) becomes an option again.

## Application settings

| Setting | Value | Notes |
|---|---|---|
| `WEBSITES_PORT`, `PORT` | `3001` | App Service routes traffic to the container's port |
| `NODE_ENV` | `production` | secure cookies; no auto-registration by default |
| `MONGO_URI` | `@Microsoft.KeyVault(…/mongo-uri/)` | resolved with the user-assigned identity (`keyVaultReferenceIdentity`) |
| `AUTH_MODE` | `local` → `easyauth` after step 4 | trusts `X-MS-CLIENT-PRINCIPAL-NAME` only once platform sign-in is on |
| `MICROSOFT_PROVIDER_AUTHENTICATION_SECRET` | Key Vault reference | set by step 4 |
| `ALLOW_AUTO_REGISTER`, `COOKIE_SECURE`, `CORS_ORIGINS` | unset | production defaults are correct |
| `BPMN_FILES_DIR` | `/data/bpmn-files` | Azure Files mount; the container's own disk is lost on restart |
| `TEMPO_URL`, `PROMETHEUS_URL` | `http://10.40.2.10:3200` / `:9090` | the mock-prod VM, reached through VNet integration |
| `ANTHROPIC_API_KEY`, `JIRA_*` | Key Vault / `app-settings.env` | optional features |

## Releases and rollback on B1

- **Releasing (automatic):** after step 6, every push to `main` that changes `client/`, `server/`, the `Dockerfile` or `.dockerignore` runs [.github/workflows/deploy-azure.yml](../../.github/workflows/deploy-azure.yml). It builds the image in ACR tagged with the commit, points the web app at it, and waits until `/api/health` reports that commit (`{"status":"ok","version":"<sha>"}`). Pushes to other branches never deploy. Run it by hand from the Actions tab or `gh workflow run deploy-azure.yml --ref main`.
  - The workflow only changes the **image**. App settings, Key Vault references, the Azure Files mount and VNet integration are left as step 3 set them; re-run step 3 to change those.
- **Releasing (by hand):** re-running step 3 swaps the image and **restarts** the app. With a few users, a short gap is acceptable.
- **Rolling back:** check out the previous commit and re-run step 3. Or point the app straight at an older tag: `az webapp config container set -g <rg> -n <app> --container-image-name <acr>.azurecr.io/bpmn-iq:<tag>`.
- **Zero-downtime swaps:** these need deployment slots, available from S1 / P0v3. Moving to one of those tiers changes the outbound IPs (see the Atlas section).

## Run locally exactly as in Azure

```bash
docker build -t bpmn-iq .
docker run -p 8080:3001 -e MONGO_URI="<your Atlas URI>" -e COOKIE_SECURE=false -e ALLOW_AUTO_REGISTER=true bpmn-iq
# → http://localhost:8080
```

## After deploying

- **Restrict sign-in:** Entra ID → Enterprise applications → *BPMN IQ (prod)* → Properties → **Assignment required = Yes**, then assign users or groups.
- **Grafana:** the VM's Grafana allows anonymous Editor access and is reachable only inside the VNet. Use an SSH tunnel or Bastion.
- **Logs:** App Service → Log stream, or Log Analytics → `AppServiceConsoleLogs`.
- **CI/CD:** a GitHub Actions job on push to `main` can run `03-app.sh` using OIDC federation (`azure/login` with a federated credential).
