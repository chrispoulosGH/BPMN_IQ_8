#!/usr/bin/env bash
# Step 2 — secrets into Key Vault. Values are read from your shell environment
# (or prompted for, hidden) — never from a file in the repo. Re-run to rotate.
#
#   MONGO_URI=... ANTHROPIC_API_KEY=... JIRA_API_TOKEN=... ./02-secrets.sh
#
# Key Vault secret name  ← environment variable
#   mongo-uri            ← MONGO_URI            (required; Atlas / Cosmos connection string incl. /bpmn_iq)
#   anthropic-api-key    ← ANTHROPIC_API_KEY    (optional; Process Optimizer)
#   jira-api-token       ← JIRA_API_TOKEN       (optional; Process Change Radar)
#   entra-client-secret  ← ENTRA_CLIENT_SECRET  (set by 04-entra-auth.sh)
set -euo pipefail
cd "$(dirname "$0")"
source ./config.sh
az account set --subscription "$SUBSCRIPTION_ID"

put_secret() {
  local name="$1" var="$2" required="$3" value="${!2:-}"
  if [[ -z "$value" && "$required" == "required" ]]; then
    read -r -s -p "$var: " value; echo
  fi
  if [[ -z "$value" ]]; then echo "  skip $name (no $var)"; return; fi
  az keyvault secret set --vault-name "$KEYVAULT" -n "$name" --value "$value" -o none
  echo "  set $name"
}

echo "== Key Vault $KEYVAULT"
put_secret mongo-uri MONGO_URI required
put_secret anthropic-api-key ANTHROPIC_API_KEY optional
put_secret jira-api-token JIRA_API_TOKEN optional
echo "Done. Non-secret Jira settings (JIRA_BASE_URL, JIRA_EMAIL, field ids…) go in app-settings.env (see 03-app.sh)."
