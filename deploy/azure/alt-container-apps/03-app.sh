#!/usr/bin/env bash
# Step 3 — build the BPMN IQ image in Azure Container Registry and create or
# update the Container App. Re-run to deploy a new version (tagged with the
# current git commit).
#
# Non-secret settings: deploy/azure/app-settings.env (KEY=VALUE per line,
# git-ignored), e.g.
#   JIRA_BASE_URL=https://yourco.atlassian.net
#   JIRA_EMAIL=you@yourco.com
#   JIRA_PROJECT_KEYS=BI82
#   JIRA_BOARD_ID=34
#   TEMPO_URL=http://10.40.2.10:3200
#   PROMETHEUS_URL=http://10.40.2.10:9090
# Secrets come from Key Vault (02-secrets.sh) via the app's managed identity.
set -euo pipefail
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
az acr build -r "$ACR" -t "${IMAGE_REPO}:${TAG}" -t "${IMAGE_REPO}:latest" "$REPO_ROOT" -o none

ID_RES=$(az identity show -g "$RG" -n "$IDENTITY" --query id -o tsv)
ENV_ID=$(az containerapp env show -g "$RG" -n "$ACA_ENV" --query id -o tsv)
KV_URI="https://${KEYVAULT}.vault.azure.net"

# Secrets that exist in Key Vault become app secrets (Key Vault references).
SECRETS_YAML=""
SECRET_ENV_YAML=""
add_secret() {  # key-vault-name  ENV_VAR
  if az keyvault secret show --vault-name "$KEYVAULT" -n "$1" -o none 2>/dev/null; then
    SECRETS_YAML+="      - name: $1
        keyVaultUrl: ${KV_URI}/secrets/$1
        identity: ${ID_RES}
"
    SECRET_ENV_YAML+="          - name: $2
            secretRef: $1
"
  fi
}
add_secret mongo-uri MONGO_URI
add_secret anthropic-api-key ANTHROPIC_API_KEY
add_secret jira-api-token JIRA_API_TOKEN

# AUTH_MODE=easyauth is only safe once platform authentication is on (it
# strips client-supplied identity headers). Keep 'local' until 04-entra-auth.sh ran.
AUTH_MODE="local"
if [[ "$APP_AUTH_MODE" == "easyauth" ]] && [[ "$(az containerapp auth show -g "$RG" -n "$APP_NAME" --query platform.enabled -o tsv 2>/dev/null)" == "true" ]]; then
  AUTH_MODE="easyauth"
fi

PLAIN_ENV_YAML=""
add_env() { PLAIN_ENV_YAML+="          - name: $1
            value: \"$2\"
"; }
add_env NODE_ENV production
add_env AUTH_MODE "$AUTH_MODE"
add_env BPMN_FILES_DIR /data/bpmn-files
add_env TEMPO_URL "http://${VM_PRIVATE_IP}:3200"
add_env PROMETHEUS_URL "http://${VM_PRIVATE_IP}:9090"
if [[ -f app-settings.env ]]; then
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    add_env "$key" "$value"
  done < app-settings.env
fi

YAML_FILE="$(mktemp)"
cat > "$YAML_FILE" <<EOF
location: ${LOCATION}
identity:
  type: UserAssigned
  userAssignedIdentities:
    ${ID_RES}: {}
properties:
  environmentId: ${ENV_ID}
  configuration:
    activeRevisionsMode: Single
    ingress:
      external: true
      targetPort: 3001
      transport: auto
      allowInsecure: false
    registries:
      - server: ${ACR}.azurecr.io
        identity: ${ID_RES}
    secrets:
${SECRETS_YAML}
  template:
    containers:
      - name: bpmn-iq
        image: ${IMAGE}
        resources:
          cpu: 1.0
          memory: 2Gi
        env:
${PLAIN_ENV_YAML}${SECRET_ENV_YAML}
        probes:
          - type: Liveness
            httpGet:
              path: /api/health
              port: 3001
            initialDelaySeconds: 20
            periodSeconds: 30
          - type: Readiness
            httpGet:
              path: /api/health
              port: 3001
            initialDelaySeconds: 10
            periodSeconds: 10
        volumeMounts:
          - volumeName: bpmn-files
            mountPath: /data/bpmn-files
    scale:
      minReplicas: ${APP_MIN_REPLICAS}
      maxReplicas: ${APP_MAX_REPLICAS}
    volumes:
      - name: bpmn-files
        storageType: AzureFile
        storageName: bpmnfiles
EOF

if az containerapp show -g "$RG" -n "$APP_NAME" -o none 2>/dev/null; then
  echo "== Update $APP_NAME → $IMAGE (AUTH_MODE=$AUTH_MODE)"
  az containerapp update -g "$RG" -n "$APP_NAME" --yaml "$YAML_FILE" -o none
else
  echo "== Create $APP_NAME → $IMAGE (AUTH_MODE=$AUTH_MODE)"
  az containerapp create -g "$RG" -n "$APP_NAME" --yaml "$YAML_FILE" -o none
fi
rm -f "$YAML_FILE"

FQDN=$(az containerapp show -g "$RG" -n "$APP_NAME" --query properties.configuration.ingress.fqdn -o tsv)
echo
echo "BPMN IQ: https://${FQDN}"
[[ "$AUTH_MODE" == "local" && "$APP_AUTH_MODE" == "easyauth" ]] && echo "Next: ./04-entra-auth.sh to turn on Microsoft Entra ID sign-in (until then the app uses its own login)."
true
