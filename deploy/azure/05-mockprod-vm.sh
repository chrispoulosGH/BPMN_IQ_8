#!/usr/bin/env bash
# Step 5 — the mock production environment (simulator + OTel collector +
# Tempo + Prometheus + Grafana) on one Ubuntu VM running the repo's
# mockprod/docker-compose.yml, in the same VNet as BPMN IQ (private IP
# $VM_PRIVATE_IP). No public ports except optional SSH from SSH_ALLOWED_CIDR.
#
# After it's created: copy the repo onto the VM, add mockprod/.env, start it:
#   ssh $VM_ADMIN@<ip>   (or Azure Bastion)
#   git clone <your repo> bpmn-iq && cd bpmn-iq/mockprod
#   cp .env.example .env && nano .env        # OBSERVE_* if exporting to Observe
#   docker compose up -d --build
set -euo pipefail
# Git Bash on Windows rewrites args starting with "/" (resource IDs, mount paths) as
# Windows paths; turn that off. No effect on Linux/macOS.
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")"
source ./config.sh
az account set --subscription "$SUBSCRIPTION_ID"

CLOUD_INIT="$(mktemp)"
cat > "$CLOUD_INIT" <<'EOF'
#cloud-config
package_update: true
packages: [ca-certificates, curl, git]
runcmd:
  - curl -fsSL https://get.docker.com | sh
  - usermod -aG docker __ADMIN__
  - mkdir -p /datadisk
  # data disk (LUN 0) for Tempo / Prometheus / Grafana volumes and the trace files
  - bash -c 'DEV=$(readlink -f /dev/disk/azure/scsi1/lun0); if ! blkid "$DEV"; then mkfs.ext4 -F "$DEV"; fi; echo "$DEV /datadisk ext4 defaults,nofail 0 2" >> /etc/fstab; mount -a'
  - bash -c 'mkdir -p /datadisk/docker && systemctl stop docker && echo "{\"data-root\": \"/datadisk/docker\"}" > /etc/docker/daemon.json && systemctl start docker'
EOF
sed -i "s/__ADMIN__/${VM_ADMIN}/" "$CLOUD_INIT"

PUBLIC_IP_ARGS=(--public-ip-address "")
NSG_RULE_SSH=""
if [[ -n "$SSH_ALLOWED_CIDR" ]]; then
  PUBLIC_IP_ARGS=(--public-ip-sku Standard)
  NSG_RULE_SSH="yes"
fi

echo "== VM $VM_NAME ($VM_SIZE) in $VNET/snet-vm at $VM_PRIVATE_IP"
az vm create -g "$RG" -n "$VM_NAME" --image Canonical:ubuntu-24_04-lts:server:latest --size "$VM_SIZE" \
  --vnet-name "$VNET" --subnet snet-vm --private-ip-address "$VM_PRIVATE_IP" "${PUBLIC_IP_ARGS[@]}" \
  --nsg "${VM_NAME}-nsg" --nsg-rule NONE \
  --admin-username "$VM_ADMIN" --generate-ssh-keys \
  --os-disk-size-gb 64 --data-disk-sizes-gb 256 \
  --custom-data "$CLOUD_INIT" -o none
rm -f "$CLOUD_INIT"

echo "== Network rules: Tempo/Prometheus/Grafana only from inside the VNet"
az network nsg rule create -g "$RG" --nsg-name "${VM_NAME}-nsg" -n allow-vnet-observability --priority 200 \
  --source-address-prefixes VirtualNetwork --destination-port-ranges 3000 3200 9090 4317 4318 \
  --access Allow --protocol Tcp -o none
if [[ -n "$NSG_RULE_SSH" ]]; then
  az network nsg rule create -g "$RG" --nsg-name "${VM_NAME}-nsg" -n allow-ssh-admin --priority 300 \
    --source-address-prefixes "$SSH_ALLOWED_CIDR" --destination-port-ranges 22 --access Allow --protocol Tcp -o none
fi

echo
echo "VM ready. Private IP $VM_PRIVATE_IP — BPMN IQ reaches Tempo at http://$VM_PRIVATE_IP:3200 and Prometheus at :9090."
if [[ -n "$NSG_RULE_SSH" ]]; then
  echo "SSH: ssh ${VM_ADMIN}@$(az vm show -d -g "$RG" -n "$VM_NAME" --query publicIps -o tsv)"
else
  echo "No public IP: connect with Azure Bastion (az network bastion ssh …) or from inside the VNet."
fi
echo "Grafana (port 3000) is VNet-only; reach it through Bastion/SSH tunnel, e.g. ssh -L 3000:localhost:3000 …"
