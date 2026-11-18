#!/usr/bin/env bash
# Step 4 — Microsoft Entra ID sign-in in front of BPMN IQ (App Service
# authentication). Creates an app registration in your tenant, stores its
# client secret in Key Vault (referenced from the app settings), turns platform
# auth on (unauthenticated users → Entra login page), and only THEN switches
# the app to AUTH_MODE=easyauth, so it trusts the signed-in identity
# (X-MS-CLIENT-PRINCIPAL-NAME) instead of its own login form.
# Needs permission to create app registrations in Entra ID.
set -euo pipefail
cd "$(dirname "$0")"
source ./config.sh
az account set --subscription "$SUBSCRIPTION_ID"

HOST=$(az webapp show -g "$RG" -n "$WEBAPP" --query defaultHostName -o tsv)
TENANT=$(az account show --query tenantId -o tsv)
DISPLAY_NAME="BPMN IQ (${ENV_NAME})"
KV_URI="https://${KEYVAULT}.vault.azure.net"

echo "== App registration: $DISPLAY_NAME"
APP_ID=$(az ad app list --display-name "$DISPLAY_NAME" --query "[0].appId" -o tsv)
if [[ -z "$APP_ID" ]]; then
  APP_ID=$(az ad app create --display-name "$DISPLAY_NAME" --sign-in-audience AzureADMyOrg \
    --web-redirect-uris "https://${HOST}/.auth/login/aad/callback" \
    --enable-id-token-issuance true --query appId -o tsv)
else
  az ad app update --id "$APP_ID" --web-redirect-uris "https://${HOST}/.auth/login/aad/callback" --enable-id-token-issuance true
fi
CLIENT_SECRET=$(az ad app credential reset --id "$APP_ID" --display-name "appservice-auth" --years 1 --query password -o tsv)
az keyvault secret set --vault-name "$KEYVAULT" -n entra-client-secret --value "$CLIENT_SECRET" -o none
unset CLIENT_SECRET

echo "== Platform authentication on $WEBAPP"
az webapp config appsettings set -g "$RG" -n "$WEBAPP" \
  --settings "MICROSOFT_PROVIDER_AUTHENTICATION_SECRET=@Microsoft.KeyVault(SecretUri=${KV_URI}/secrets/entra-client-secret/)" -o none
az webapp auth microsoft update -g "$RG" -n "$WEBAPP" \
  --client-id "$APP_ID" --client-secret-setting-name MICROSOFT_PROVIDER_AUTHENTICATION_SECRET \
  --issuer "https://login.microsoftonline.com/${TENANT}/v2.0" --yes -o none
az webapp auth update -g "$RG" -n "$WEBAPP" --enabled true \
  --action RedirectToLoginPage --redirect-provider azureactivedirectory -o none

echo "== Switch the app to AUTH_MODE=easyauth"
az webapp config appsettings set -g "$RG" -n "$WEBAPP" --settings AUTH_MODE=easyauth -o none

echo
echo "Sign-in is on: https://${HOST} redirects to Microsoft Entra ID; BPMN IQ uses the signed-in user's"
echo "UPN as its user id (auto-registered on first sign-in). Restrict who can sign in by setting"
echo "'Assignment required' on the enterprise application '$DISPLAY_NAME' and assigning users/groups."
echo "The client secret expires in 1 year — re-run this script to rotate it."
