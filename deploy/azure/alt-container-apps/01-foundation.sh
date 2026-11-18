#!/usr/bin/env bash
# Step 1 — shared foundation: resource group, VNet + subnets, Log Analytics,
# Container Registry, Key Vault (RBAC), user-assigned identity with AcrPull +
# Key Vault Secrets User, a storage account + Azure Files share for
# BPMN_FILES_DIR, and the Container Apps environment in the VNet.
# Idempotent: re-running updates/keeps existing resources.
set -euo pipefail
cd "$(dirname "$0")"
source ./config.sh

az account set --subscription "$SUBSCRIPTION_ID"
az extension add --name containerapp --upgrade --only-show-errors
az provider register --namespace Microsoft.App --wait
az provider register --namespace Microsoft.OperationalInsights --wait

echo "== Resource group"
az group create -n "$RG" -l "$LOCATION" -o none

echo "== Network"
az network vnet create -g "$RG" -n "$VNET" --address-prefixes "$VNET_CIDR" -o none
az network vnet subnet create -g "$RG" --vnet-name "$VNET" -n snet-aca --address-prefixes "$ACA_SUBNET_CIDR" \
  --delegations Microsoft.App/environments -o none 2>/dev/null || true
az network vnet subnet create -g "$RG" --vnet-name "$VNET" -n snet-vm --address-prefixes "$VM_SUBNET_CIDR" -o none 2>/dev/null || true

echo "== Log Analytics"
az monitor log-analytics workspace create -g "$RG" -n "$LOG_ANALYTICS" -l "$LOCATION" -o none
LAW_ID=$(az monitor log-analytics workspace show -g "$RG" -n "$LOG_ANALYTICS" --query customerId -o tsv)
LAW_KEY=$(az monitor log-analytics workspace get-shared-keys -g "$RG" -n "$LOG_ANALYTICS" --query primarySharedKey -o tsv)

echo "== Container Registry"
az acr create -g "$RG" -n "$ACR" --sku Basic --admin-enabled false -o none

echo "== Key Vault (RBAC)"
az keyvault create -g "$RG" -n "$KEYVAULT" -l "$LOCATION" --enable-rbac-authorization true -o none
# Let the person running this write secrets.
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
STORAGE_KEY=$(az storage account keys list -g "$RG" -n "$STORAGE" --query "[0].value" -o tsv)
az storage share-rm create -g "$RG" --storage-account "$STORAGE" -n "$FILE_SHARE" --quota 10 -o none

echo "== Container Apps environment (in the VNet)"
ACA_SUBNET_ID=$(az network vnet subnet show -g "$RG" --vnet-name "$VNET" -n snet-aca --query id -o tsv)
if ! az containerapp env show -g "$RG" -n "$ACA_ENV" -o none 2>/dev/null; then
  az containerapp env create -g "$RG" -n "$ACA_ENV" -l "$LOCATION" \
    --infrastructure-subnet-resource-id "$ACA_SUBNET_ID" \
    --logs-workspace-id "$LAW_ID" --logs-workspace-key "$LAW_KEY" -o none
fi
az containerapp env storage set -g "$RG" -n "$ACA_ENV" --storage-name bpmnfiles \
  --azure-file-account-name "$STORAGE" --azure-file-account-key "$STORAGE_KEY" \
  --azure-file-share-name "$FILE_SHARE" --access-mode ReadWrite -o none

echo
echo "Foundation ready in $RG. Next: put the database URI and other secrets in Key Vault (02-secrets.sh)."
echo "Outbound traffic from Container Apps does not have a fixed IP; for MongoDB Atlas use a private"
echo "endpoint into $VNET, or attach a NAT gateway to snet-aca and allow its IP in Atlas."
