# Copy to config.sh (git-ignored) and edit. Sourced by every script here.
# Target: Azure App Service for containers, B1 Linux plan (see ../../azure-deploy-comparison.md).
# Names must be globally unique where noted; lowercase letters/digits only for ACR / storage / Key Vault.

export SUBSCRIPTION_ID=""                 # az account show --query id -o tsv
export LOCATION="eastus"                  # Virginia — same metro as the Atlas cluster (AWS us-east-1)
export PREFIX="bpmniq"                    # short, lowercase; used to build resource names
export ENV_NAME="prod"

export RG="rg-${PREFIX}-${ENV_NAME}"
export VNET="vnet-${PREFIX}-${ENV_NAME}"
export VNET_CIDR="10.40.0.0/16"
export APP_SUBNET_CIDR="10.40.4.0/26"     # App Service VNet integration (delegated to Microsoft.Web/serverFarms)
export VM_SUBNET_CIDR="10.40.2.0/24"      # mock production VM
export LOG_ANALYTICS="log-${PREFIX}-${ENV_NAME}"
export ACR="acr${PREFIX}${ENV_NAME}"      # globally unique, 5-50 alphanumerics
export KEYVAULT="kv-${PREFIX}-${ENV_NAME}"   # globally unique, 3-24 chars
export STORAGE="st${PREFIX}${ENV_NAME}"   # globally unique, 3-24 lowercase alphanumerics
export FILE_SHARE="bpmn-files"
export IDENTITY="id-${PREFIX}-app"
export PLAN="asp-${PREFIX}-${ENV_NAME}"
export PLAN_SKU="B1"                      # 1 vCPU / 1.75 GB. S1/P0v3 add deployment slots (zero-downtime swaps)
export WEBAPP="app-${PREFIX}-${ENV_NAME}" # globally unique → https://<WEBAPP>.azurewebsites.net
export IMAGE_REPO="bpmn-iq"

# Mock production VM (Tempo / Prometheus / Grafana / simulator — docker compose)
export VM_NAME="vm-${PREFIX}-mockprod"
export VM_SIZE="Standard_D4s_v5"          # 4 vCPU / 16 GiB; the simulator alone uses ~2 GiB
export VM_ADMIN="azureuser"
export VM_PRIVATE_IP="10.40.2.10"         # BPMN IQ reaches Tempo/Prometheus here (through VNet integration)
export SSH_ALLOWED_CIDR=""                # your public IP/32 for SSH; leave empty to use Azure Bastion only

# App settings that are not secrets
export APP_AUTH_MODE="easyauth"           # easyauth (Microsoft Entra ID via App Service authentication) | local
