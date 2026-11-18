#!/usr/bin/env bash
# Step 4 — Microsoft Entra ID sign-in in front of BPMN IQ (Container Apps
# built-in authentication). Creates an app registration in your tenant,
# turns platform auth on (unauthenticated users → Entra login page), and only
# THEN switches the app to AUTH_MODE=easyauth, so it trusts the signed-in
# identity (X-MS-CLIENT-PRINCIPAL-NAME) instead of its own login form.
# Needs permission to create app registrations in Entra ID.
set -euo pipefail
# Git Bash on Windows rewrites args starting with "/" (resource IDs, mount paths) as
# Windows paths; turn that off. No effect on Linux/macOS.
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")"
source ./config.sh
az account set --subscription "$SUBSCRIPTION_ID"

FQDN=$(az containerapp show -g "$RG" -n "$APP_NAME" --query properties.configuration.ingress.fqdn -o tsv)
TENANT=$(az account show --query tenantId -o tsv)
DISPLAY_NAME="BPMN IQ (${ENV_NAME})"

echo "== App registration: $DISPLAY_NAME"
APP_ID=$(az ad app list --display-name "$DISPLAY_NAME" --query "[0].appId" -o tsv)
if [[ -z "$APP_ID" ]]; then
  APP_ID=$(az ad app create --display-name "$DISPLAY_NAME" --sign-in-audience AzureADMyOrg \
    --web-redirect-uris "https://${FQDN}/.auth/login/aad/callback" \
    --enable-id-token-issuance true --query appId -o tsv)
else
  az ad app update --id "$APP_ID" --web-redirect-uris "https://${FQDN}/.auth/login/aad/callback" --enable-id-token-issuance true
fi
CLIENT_SECRET=$(az ad app credential reset --id "$APP_ID" --display-name "containerapp-auth" --years 1 --query password -o tsv)

echo "== Platform authentication on $APP_NAME"
az containerapp secret set -g "$RG" -n "$APP_NAME" --secrets "microsoft-provider-authentication-secret=${CLIENT_SECRET}" -o none
az containerapp auth microsoft update -g "$RG" -n "$APP_NAME" \
  --client-id "$APP_ID" --client-secret-name microsoft-provider-authentication-secret \
  --issuer "https://login.microsoftonline.com/${TENANT}/v2.0" --yes -o none
az containerapp auth update -g "$RG" -n "$APP_NAME" --enabled true \
  --unauthenticated-client-action RedirectToLoginPage --redirect-provider azureactivedirectory -o none

echo "== Switch the app to AUTH_MODE=easyauth"
az containerapp update -g "$RG" -n "$APP_NAME" --set-env-vars AUTH_MODE=easyauth -o none

echo
echo "Sign-in is on: https://${FQDN} redirects to Microsoft Entra ID; BPMN IQ uses the signed-in user's"
echo "UPN as its user id (auto-registered on first sign-in). Restrict who can sign in by setting"
echo "'Assignment required' on the enterprise application '$DISPLAY_NAME' and assigning users/groups."
echo "The client secret expires in 1 year — re-run this script to rotate it."
