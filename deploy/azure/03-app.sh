#!/usr/bin/env bash
# Step 3 — build the BPMN IQ image in Azure Container Registry and create or
# update the App Service web app (Linux, custom container). Re-run to deploy a
# new version (tagged with the current git commit).
#
# On B1 there are no deployment slots: changing the image restarts the app
# (a short gap in service). Roll back by re-running with an older commit
# checked out, or: az webapp config container set ... --container-image-name <acr>/bpmn-iq:<old-tag>
#
# Non-secret settings: deploy/azure/app-settings.env (KEY=VALUE per line,
# git-ignored), e.g. JIRA_BASE_URL, JIRA_EMAIL, JIRA_PROJECT_KEYS, JIRA_BOARD_ID.
# Secrets come from Key Vault (02-secrets.sh) as Key Vault references resolved
# with the app's user-assigned identity.
set -euo pipefail
# Git Bash on Windows rewrites args starting with "/" (resource IDs, mount paths) as
# Windows paths; turn that off. No effect on Linux/macOS.
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")"
source ./config.sh
az account set --subscription "$SUBSCRIPTION_ID"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TAG="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain -- client server Dockerfile)" ]]; then
  TAG="${TAG}-dirty"
  echo "Note: uncommitted changes in client/ or server/; tagging the image $TAG"
fi
IMAGE="${ACR}.azurecr.io/${IMAGE_REPO}:${TAG}"

echo "== Build $IMAGE in ACR"
# --no-logs: still waits for the build, but does not stream its log. Streaming crashes the
# Windows Azure CLI on non-ASCII output (it cannot be switched to UTF-8). Logs: portal, or
# az acr task logs / az acr task list-runs.
RUN=$(az acr build -r "$ACR" -t "${IMAGE_REPO}:${TAG}" -t "${IMAGE_REPO}:latest" "$REPO_ROOT" --no-logs --query "{id:runId,status:status}" -o tsv)
read -r RUN_ID RUN_STATUS <<<"$RUN"
echo "  ACR run $RUN_ID: $RUN_STATUS"
[[ "$RUN_STATUS" == "Succeeded" ]] || { echo "Image build failed; see: az acr task logs -r $ACR --run-id $RUN_ID"; exit 1; }

ID_RES=$(az identity show -g "$RG" -n "$IDENTITY" --query id -o tsv)
ID_CLIENT=$(az identity show -g "$RG" -n "$IDENTITY" --query clientId -o tsv)
KV_URI="https://${KEYVAULT}.vault.azure.net"

echo "== Web app $WEBAPP"
if ! az webapp show -g "$RG" -n "$WEBAPP" -o none 2>/dev/null; then
  az webapp create -g "$RG" -p "$PLAN" -n "$WEBAPP" --container-image-name "$IMAGE" -o none
fi
az webapp identity assign -g "$RG" -n "$WEBAPP" --identities "$ID_RES" -o none

# Pull from ACR with the user-assigned identity; health check; Always On (B1
# would otherwise unload the app after ~20 idle minutes); HTTPS/TLS hygiene.
az webapp config set -g "$RG" -n "$WEBAPP" --always-on true --ftps-state Disabled --min-tls-version 1.2 \
  --generic-configurations "{\"acrUseManagedIdentityCreds\": true, \"acrUserManagedIdentityID\": \"${ID_CLIENT}\", \"healthCheckPath\": \"/api/health\"}" -o none
az webapp update -g "$RG" -n "$WEBAPP" --https-only true -o none
# Key Vault references resolve with this identity (default would be the system identity, which has no access).
APP_ID_RES=$(az webapp show -g "$RG" -n "$WEBAPP" --query id -o tsv)
az resource update --ids "$APP_ID_RES" --set properties.keyVaultReferenceIdentity="$ID_RES" -o none

# AUTH_MODE=easyauth is only safe once platform authentication is on (it
# strips client-supplied identity headers). Keep 'local' until 04-entra-auth.sh ran.
AUTH_MODE="local"
if [[ "$APP_AUTH_MODE" == "easyauth" ]] && [[ "$(az webapp auth show -g "$RG" -n "$WEBAPP" --query platform.enabled -o tsv 2>/dev/null)" == "true" ]]; then
  AUTH_MODE="easyauth"
fi

SETTINGS=(
  "WEBSITES_PORT=3001"                       # App Service routes to the container's port
  "PORT=3001"
  "WEBSITES_ENABLE_APP_SERVICE_STORAGE=false"
  "NODE_ENV=production"
  "AUTH_MODE=${AUTH_MODE}"
  "BPMN_FILES_DIR=/data/bpmn-files"
  "TEMPO_URL=http://${VM_PRIVATE_IP}:3200"
  "PROMETHEUS_URL=http://${VM_PRIVATE_IP}:9090"
)
# Secrets present in Key Vault become Key Vault references.
add_kv_setting() {  # ENV_VAR  key-vault-secret-name
  if az keyvault secret show --vault-name "$KEYVAULT" -n "$2" -o none 2>/dev/null; then
    SETTINGS+=("$1=@Microsoft.KeyVault(SecretUri=${KV_URI}/secrets/$2/)")
  fi
}
add_kv_setting MONGO_URI mongo-uri
add_kv_setting ANTHROPIC_API_KEY anthropic-api-key
add_kv_setting JIRA_API_TOKEN jira-api-token
if [[ -f app-settings.env ]]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    SETTINGS+=("${key}=${value}")
  done < app-settings.env
fi
az webapp config appsettings set -g "$RG" -n "$WEBAPP" --settings "${SETTINGS[@]}" -o none

echo "== Azure Files mount → /data/bpmn-files"
STORAGE_KEY=$(az storage account keys list -g "$RG" -n "$STORAGE" --query "[0].value" -o tsv)
if az webapp config storage-account list -g "$RG" -n "$WEBAPP" --query "[?name=='bpmnfiles']" -o tsv | grep -q .; then
  az webapp config storage-account update -g "$RG" -n "$WEBAPP" --custom-id bpmnfiles --storage-type AzureFiles \
    --account-name "$STORAGE" --share-name "$FILE_SHARE" --access-key "$STORAGE_KEY" --mount-path /data/bpmn-files -o none
else
  az webapp config storage-account add -g "$RG" -n "$WEBAPP" --custom-id bpmnfiles --storage-type AzureFiles \
    --account-name "$STORAGE" --share-name "$FILE_SHARE" --access-key "$STORAGE_KEY" --mount-path /data/bpmn-files -o none
fi

echo "== VNet integration (reaches the mock-prod VM; Atlas stays on public outbound IPs)"
if [[ -z "$(az webapp vnet-integration list -g "$RG" -n "$WEBAPP" --query "[0].name" -o tsv 2>/dev/null)" ]]; then
  az webapp vnet-integration add -g "$RG" -n "$WEBAPP" --vnet "$VNET" --subnet snet-app -o none
fi
az resource update --ids "$APP_ID_RES" --set properties.vnetRouteAllEnabled=false -o none

echo "== Logs → Log Analytics"
LAW_RES=$(az monitor log-analytics workspace show -g "$RG" -n "$LOG_ANALYTICS" --query id -o tsv)
az monitor diagnostic-settings create --name to-log-analytics --resource "$APP_ID_RES" --workspace "$LAW_RES" \
  --logs '[{"category":"AppServiceConsoleLogs","enabled":true},{"category":"AppServiceHTTPLogs","enabled":true}]' -o none 2>/dev/null || true

echo "== Deploy image $IMAGE (restarts the app)"
az webapp config container set -g "$RG" -n "$WEBAPP" --container-image-name "$IMAGE" \
  --container-registry-url "https://${ACR}.azurecr.io" -o none

HOST=$(az webapp show -g "$RG" -n "$WEBAPP" --query defaultHostName -o tsv)
echo
echo "BPMN IQ: https://${HOST}   (AUTH_MODE=${AUTH_MODE})"
echo
echo "Atlas IP access list — add every address below (Atlas → Network Access → Add IP Address)."
echo "These are all the outbound IPs this app can use; they change only if the plan's pricing tier or region changes."
az webapp show -g "$RG" -n "$WEBAPP" --query possibleOutboundIpAddresses -o tsv | tr ',' '\n' | sed 's#$#/32#'
[[ "$AUTH_MODE" == "local" && "$APP_AUTH_MODE" == "easyauth" ]] && echo && echo "Next: ./04-entra-auth.sh to turn on Microsoft Entra ID sign-in (until then the app uses its own login)."
true
