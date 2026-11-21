#!/usr/bin/env bash
# Step 6 — let GitHub Actions deploy pushes to main (.github/workflows/deploy-azure.yml).
#
# Creates, once:
#   - an Entra ID app registration + service principal "gh-<PREFIX>-deploy";
#   - a federated credential trusting ONLY this repo's main branch (OIDC, no secret);
#   - role assignments: Contributor on the Container Registry (ACR Tasks builds) and
#     Website Contributor on the web app (change its image). Nothing wider.
#   - GitHub repository variables AZURE_CLIENT_ID / TENANT_ID / SUBSCRIPTION_ID / RG /
#     ACR / WEBAPP (identifiers, not secrets), via the gh CLI.
#
# Needs: az signed in as someone who can create app registrations and role assignments
# (Owner / User Access Administrator on the resource group); gh signed in with admin
# rights on the repo. Safe to re-run.
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")"
source ./config.sh
az account set --subscription "$SUBSCRIPTION_ID"

REPO="${GITHUB_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
APP_NAME="gh-${PREFIX}-deploy"
TENANT_ID=$(az account show --query tenantId -o tsv)
echo "== GitHub repo $REPO → deploy identity $APP_NAME"

APP_ID=$(az ad app list --display-name "$APP_NAME" --query "[0].appId" -o tsv)
if [[ -z "$APP_ID" ]]; then
  APP_ID=$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)
  echo "  created app registration $APP_ID"
fi
if ! az ad sp show --id "$APP_ID" -o none 2>/dev/null; then
  az ad sp create --id "$APP_ID" -o none
fi
SP_OID=$(az ad sp show --id "$APP_ID" --query id -o tsv)

# GitHub may present the subject with names only (repo:owner/repo:...) or with
# immutable numeric IDs (repo:owner@<ownerId>/repo@<repoId>:...), depending on the
# repo/org setting. Trust both forms, for the main branch only.
OWNER_ID=$(gh api "repos/${REPO}" -q .owner.id)
REPO_ID=$(gh api "repos/${REPO}" -q .id)
add_fic() {  # credential-name subject
  if [[ -z "$(az ad app federated-credential list --id "$APP_ID" --query "[?subject=='$2'].name" -o tsv)" ]]; then
    az ad app federated-credential create --id "$APP_ID" --parameters "{
      \"name\": \"$1\",
      \"issuer\": \"https://token.actions.githubusercontent.com\",
      \"subject\": \"$2\",
      \"audiences\": [\"api://AzureADTokenExchange\"]
    }" -o none
  fi
  echo "  federated credential for $2"
}
add_fic github-main "repo:${REPO}:ref:refs/heads/main"
add_fic github-main-ids "repo:${REPO%%/*}@${OWNER_ID}/${REPO##*/}@${REPO_ID}:ref:refs/heads/main"

assign() {  # role scope
  if [[ -z "$(az role assignment list --assignee "$SP_OID" --role "$1" --scope "$2" --query "[0].id" -o tsv)" ]]; then
    # A new service principal can take a few seconds to replicate; retry.
    for i in 1 2 3 4 5 6; do
      az role assignment create --assignee-object-id "$SP_OID" --assignee-principal-type ServicePrincipal \
        --role "$1" --scope "$2" -o none && break
      echo "  retrying role assignment ($i)"; sleep 10
    done
  fi
  echo "  $1 on ${2##*/}"
}
ACR_RES=$(az acr show -g "$RG" -n "$ACR" --query id -o tsv)
APP_RES=$(az webapp show -g "$RG" -n "$WEBAPP" --query id -o tsv)
assign "Contributor" "$ACR_RES"
assign "Website Contributor" "$APP_RES"

echo "== GitHub repository variables"
gh variable set AZURE_CLIENT_ID       -R "$REPO" -b "$APP_ID"
gh variable set AZURE_TENANT_ID       -R "$REPO" -b "$TENANT_ID"
gh variable set AZURE_SUBSCRIPTION_ID -R "$REPO" -b "$SUBSCRIPTION_ID"
gh variable set AZURE_RG              -R "$REPO" -b "$RG"
gh variable set AZURE_ACR             -R "$REPO" -b "$ACR"
gh variable set AZURE_WEBAPP          -R "$REPO" -b "$WEBAPP"

echo
echo "Done. Pushes to main that change client/, server/ or the Dockerfile now deploy."
echo "Run one by hand: gh workflow run deploy-azure.yml -R $REPO --ref main"
