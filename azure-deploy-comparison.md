# BPMN IQ on Azure: Container Apps vs App Service for containers

This compares two Azure targets for the same BPMN IQ Docker image. One is the current plan in [deploy/azure/](deploy/azure/), Azure Container Apps (ACA). The other is Azure App Service for containers.

Expected load: a few users and low request volume.

> **Pricing caveat:** Microsoft's pricing pages didn't render dollar figures when this was researched. The figures below come from the published billing model and third-party guides. Confirm them in the Azure pricing calculator for your region before deciding.

## Cost

| | Container Apps (current scripts) | App Service for containers |
|---|---|---|
| **Billing model** | Billed per second. An idle replica is charged a reduced vCPU rate; memory is charged in full. Each month the first 180,000 vCPU-seconds, 360,000 GiB-seconds and 2 million requests are free. | A fixed monthly price per plan instance, whether used or not. |
| **This app** | **About $20–25/month** at 1 vCPU / 2 GiB with a minimum of 1 replica (`03-app.sh`). **About $10/month** at 0.5 vCPU / 1 GiB. **About $0** if it scales to zero, but the first request then waits a few seconds and in-memory caches reset. | **B1** (1 vCPU / 1.75 GB): **about $13/month**. **P0v3** (1 vCPU / 4 GB, adds deployment slots): **about $55–60/month**. |
| **Database connection** | No fixed outbound IP. Reaching Atlas needs a **NAT gateway**, a fixed monthly cost that can exceed the app's, or a **private endpoint**, which Atlas supports only on dedicated tiers. | Publishes a list of outbound IPs you can **allowlist in Atlas** at no extra cost. |
| **Same either way** | Container Registry (Basic), Key Vault, Azure Files, and the mock-production VM. The VM is the largest cost by far. | Same. |

**Bottom line:** compute costs about the same, $10–25 a month either way. The difference is whether Atlas needs a NAT gateway.

## Operational overhead

| | Container Apps | App Service |
|---|---|---|
| **Container registry** | Same registry. Pulls with the managed identity. | Same registry. Pulls with the managed identity (`acrUseManagedIdentityCreds` plus the identity's client ID). Can also redeploy automatically when a new image is pushed. |
| **Releasing a new version** | Each deploy is a new **revision**. The old one keeps serving until the new one passes its health checks. Rolling back means reactivating the previous revision, and traffic can be split between versions. All of this is included at your tier. | Updating the image **restarts the app**, so expect a short outage. Zero-downtime swaps and quick swap-back need **deployment slots**, which require Standard or Premium. On B1, rolling back means redeploying the previous image tag. |
| **Network** | Needs a /23 subnet delegated to `Microsoft.App/environments`. This is already in the scripts. | Needs a smaller subnet delegated to `Microsoft.Web/serverFarms` for outbound access to the VNet. |
| **Day to day** | Container-oriented tooling: logs go to Log Analytics, and you can open a console in a replica. | More familiar for a single web app: log stream, SSH/Kudu console, a health-check setting and built-in diagnostics. |

## Compatibility with the Express + static-file setup

**App Service runs the image as it is. No code changes are needed.**

- **Static files and API:** Express serves the built client (`client/dist`) and the API from one container, so App Service only has to run the image.
- **Port:** set `WEBSITES_PORT=3001` so App Service routes traffic to the right port.
- **Secure cookies:** the app's `trust proxy` setting already handles the forwarded HTTPS headers App Service's front end adds.
- **Sign-in:** App Service's built-in authentication sets the same `X-MS-CLIENT-PRINCIPAL-NAME` header Container Apps does, so `AUTH_MODE=easyauth` works as written.
- **Health check:** set the health-check path to `/api/health`. App Service ignores the image's own `HEALTHCHECK`, which is harmless.
- **File storage:** `BPMN_FILES_DIR` maps to an Azure Files mount through App Service's storage mounts.
- **Timeout caveat (both platforms):** requests through the front end time out after about 230–240 seconds. The Process Optimizer's `analyze` call takes 1–3 minutes, so it sits close to that limit on either target.

## Script impact if you switch to App Service

| Script | Impact |
|---|---|
| `config.example.sh` | **Edit.** Replace `ACA_ENV`, the /23 `ACA_SUBNET_CIDR` and the replica counts with an App Service plan name, SKU and instance count, plus an integration subnet. |
| `01-foundation.sh` | **Partial rewrite.** Remove the `containerapp` extension, the `Microsoft.App` provider, `az containerapp env create` and `env storage set`. Add `az appservice plan create --is-linux`, and change the subnet delegation to `Microsoft.Web/serverFarms`. The Container Registry, Key Vault, identity, storage and Log Analytics steps stay. |
| `02-secrets.sh` | **Unchanged.** |
| `03-app.sh` | **Rewrite the deploy half.** `az acr build` stays. The Container Apps YAML becomes `az webapp create` and `az webapp config container set`, plus: <ul><li>assigning the identity and setting the registry pull settings;</li><li>app settings using `@Microsoft.KeyVault(SecretUri=…)`, with `keyVaultReferenceIdentity` set to the user-assigned identity (otherwise App Service uses its system identity and the secrets don't resolve);</li><li>`WEBSITES_PORT=3001` and the health-check path;</li><li>`az webapp config storage-account add` and `az webapp vnet-integration add`.</li></ul> The `AUTH_MODE` safety check moves from `az containerapp auth show` to `az webapp auth show`, and the hostname query changes. |
| `04-entra-auth.sh` | **Moderate rewrite.** The app registration and callback URL (`/.auth/login/aad/callback`) stay. `az containerapp auth` and `containerapp secret set` become `az webapp auth microsoft update`, with the client secret stored as an app setting. `--set-env-vars` becomes `az webapp config appsettings set`. Keep the same order: turn platform sign-in on first, then switch the app to `easyauth`. |
| `05-mockprod-vm.sh` | **Unchanged.** The firewall rule that allows the VNet also covers App Service's integration subnet. |
| `README.md` | Update the architecture diagram and the Atlas connectivity notes. |

If you stay on Container Apps, one cheap change: size the app in `03-app.sh` at 0.5 vCPU / 1 GiB. That roughly halves the compute cost at this traffic.

## Decision (2026-11-18): App Service B1

**Atlas facts, confirmed by Chris:** Cluster0 is the **free tier (M0)** on AWS us-east-1 (Virginia). It has **no private endpoints**.

That is the case the recommendation below calls out as flipping the choice. Container Apps would need a NAT gateway just to give Atlas a fixed IP to allow. App Service B1 publishes outbound IPs that go straight into the Atlas IP access list.

**Chosen:** App Service B1 (Linux) in **East US** (also Virginia), with the Atlas IP access list.

- [deploy/azure/](deploy/azure/) now targets App Service.
- The Container Apps scripts are kept in [deploy/azure/alt-container-apps/](deploy/azure/alt-container-apps/).
- **Accepted trade-off:** each deploy restarts the app (no slots on B1).
- **Revisit** if Atlas moves to a dedicated tier with a private endpoint, or if zero-downtime deploys become a requirement.

## Original recommendation (before the Atlas tier was known)

**Stay on Azure Container Apps.** Both targets run the image unchanged, and at a few users the compute bill is close: about $10–25 a month either way. Container Apps includes revision history and one-command rollback at your current tier, and it can scale to zero later. On App Service, zero-downtime deploys and quick rollback need deployment slots, which means moving from B1 (about $13) to Standard or Premium (about $55 or more). The deploy scripts and the tested image already target Container Apps. The one factor that could flip this is the database connection. Container Apps has no fixed outbound IP, so Atlas needs a NAT gateway or a private endpoint. If your Atlas cluster is a shared tier that only accepts an IP allowlist, and you don't want to pay for a NAT gateway, App Service B1 is the simpler and cheaper choice: allowlist its outbound IPs and accept a brief restart on each deploy.

## Sources

- [Azure Container Apps pricing](https://azure.microsoft.com/en-us/pricing/details/container-apps/)
- [Billing in Azure Container Apps (Microsoft Learn)](https://learn.microsoft.com/en-us/azure/container-apps/billing)
- [Azure Container Apps pricing, Azure China (idle vs active rates)](https://www.azure.cn/en-us/pricing/details/container-apps/)
- [Azure Container Apps pricing guide (DevZero, third-party)](https://www.devzero.io/blog/azure-container-apps-pricing)
- [App Service on Linux pricing](https://azure.microsoft.com/en-us/pricing/details/app-service/linux/)
- [App Service plans pricing](https://azure.microsoft.com/en-us/pricing/details/app-service/plans)
- [App Service pricing guide (Usage.ai, third-party)](https://www.usage.ai/?p=11627)
