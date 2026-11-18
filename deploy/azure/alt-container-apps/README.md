# Alternative: Azure Container Apps (not the chosen target)

These are the original Container Apps versions of steps 0, 1, 3 and 4, kept for reference. Steps 2 (`02-secrets.sh`) and 5 (`05-mockprod-vm.sh`) in the parent folder work unchanged with them.

**Decision (2026-11-18):** deploy to **App Service B1** instead; see `../../../azure-deploy-comparison.md`.

The reason: the Atlas cluster is a free-tier M0 cluster, which has no private endpoints. Container Apps has no fixed outbound IP, so reaching Atlas would need a NAT gateway — a fixed monthly cost larger than the app itself. App Service publishes outbound IPs that can go straight into the Atlas IP access list.

Revisit this choice if Atlas moves to a dedicated tier (M10+) with a private endpoint, or if zero-downtime revisions and traffic splitting become important.
