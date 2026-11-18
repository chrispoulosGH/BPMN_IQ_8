#!/usr/bin/env bash
# Step 1 — shared foundation for App Service: resource group, VNet + subnets,
# Log Analytics, Container Registry, Key Vault (RBAC), user-assigned identity
# with AcrPull + Key Vault Secrets User, a storage account + Azure Files share
# for BPMN_FILES_DIR, and the Linux App Service plan (B1 by default).
# Idempotent: re-running updates/keeps existing resources.
set -euo pipefail
cd "$(dirname "$0")"
source ./config.sh

az account set --subscription "$SUBSCRIPTION_ID"
az provider register --namespace Microsoft.Web --wait
az provider register --namespace Microsoft.OperationalInsights --wait

echo "== Resource group"
az group create -n "$RG" -l "$LOCATION" -o none

echo "== Network"
az network vnet create -g "$RG" -n "$VNET" --address-prefixes "$VNET_CIDR" -o none
# App Service VNet integration subnet (outbound only). Only private-range traffic
# (the mock-prod VM) goes through it; Atlas traffic keeps using the app's public
# outbound IPs, which is what the Atlas IP access list allows. Keep "route all" off.
az network vnet subnet create -g "$RG" --vnet-name "$VNET" -n snet-app --address-prefixes "$APP_SUBNET_CIDR" \
  --delegations Microsoft.Web/serverFarms -o none 2>/dev/null || true
az network vnet subnet create -g "$RG" --vnet-name "$VNET" -n snet-vm --address-prefixes "$VM_SUBNET_CIDR" -o none 2>/dev/null || true

echo "== Log Analytics"
az monitor log-analytics workspace create -g "$RG" -n "$LOG_ANALYTICS" -l "$LOCATION" -o none

echo "== Container Registry"
az acr create -g "$RG" -n "$ACR" --sku Basic --admin-enabled false -o none

echo "== Key Vault (RBAC)"
az keyvault create -g "$RG" -n "$KEYVAULT" -l "$LOCATION" --enable-rbac-authorization true -o none
ME=$(az ad signed-in-user show --query id -o tsv)
KV_ID=$(az keyvault show -n "$KEYVAULT" --query id -o tsv)
az role assignment create --assignee-object-id "$ME" --assignee-principal-type User \
  --role "Key Vault Secrets Officer" --scope "$KV_ID" -o none 2>/dev/null || true

echo "== Managed identity for the app"
az identity create -g "$RG" -n "$IDENTITY" -o none
ID_PRINCIPAL=$(az identity show -g "$RG" -n "$IDENTITY" --query principalId -o tsv)
ACR_ID=$(az acr show -n "$ACR" --query id -o tsv)
az role assignment create --assignee-object-id "$ID_PRINCIPAL" --assignee-principal-type ServicePrincipal \
  --role AcrPull --scope "$ACR_ID" -o none 2>/dev/null || true
az role assignment create --assignee-object-id "$ID_PRINCIPAL" --assignee-principal-type ServicePrincipal \
  --role "Key Vault Secrets User" --scope "$KV_ID" -o none 2>/dev/null || true

echo "== Storage for BPMN_FILES_DIR"
az storage account create -g "$RG" -n "$STORAGE" -l "$LOCATION" --sku Standard_LRS --kind StorageV2 \
  --min-tls-version TLS1_2 --allow-blob-public-access false -o none
az storage share-rm create -g "$RG" --storage-account "$STORAGE" -n "$FILE_SHARE" --quota 10 -o none

echo "== App Service plan ($PLAN_SKU, Linux)"
az appservice plan create -g "$RG" -n "$PLAN" -l "$LOCATION" --is-linux --sku "$PLAN_SKU" -o none

echo
echo "Foundation ready in $RG. Next: put the database URI and other secrets in Key Vault (02-secrets.sh)."
