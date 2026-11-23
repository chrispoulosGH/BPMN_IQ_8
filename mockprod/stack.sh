#!/usr/bin/env bash
# Start / stop the mock production stack: the simulator (apps + process engine +
# dealer workstation), the OpenTelemetry Collector, Tempo, Prometheus and Grafana.
#
#   ./stack.sh start   [group|service...] [--build]   start (Docker Desktop too, if needed) and wait until healthy
#   ./stack.sh stop    [group|service...]             stop containers; data (Tempo/Prometheus/Grafana volumes) is kept
#   ./stack.sh restart [group|service...] [--build]
#   ./stack.sh status                                  containers + health of every endpoint
#   ./stack.sh logs    [service]                       follow logs (Ctrl+C to quit)
#   ./stack.sh down                                    remove containers and network; volumes are kept
#
# Groups:  sim = mockprod (the simulator)
#          obs = otel-collector tempo prometheus grafana
#          (none) = everything
# --build rebuilds the simulator image (after changing mockprod/src or the catalog).
#
# Examples:  ./stack.sh start            ./stack.sh stop sim      ./stack.sh restart grafana
# Settings (OBSERVE_MODE, DAILY_JOURNEYS, WAIT_SCALE…) come from mockprod/.env, see .env.example.
set -euo pipefail
cd "$(dirname "$0")"

SIM_SERVICES=(mockprod)
OBS_SERVICES=(otel-collector tempo prometheus grafana)

# name|url — checked by start/status
HEALTH=(
  "otel-collector|http://localhost:13133/"
  "tempo|http://localhost:3200/ready"
  "prometheus|http://localhost:9090/-/ready"
  "grafana|http://localhost:3000/api/health"
  "process engine|http://localhost:7000/healthz"
  "dealer workstation|http://localhost:7099/healthz"
)

die() { echo "Error: $*" >&2; exit 1; }

ensure_docker() {
  docker info >/dev/null 2>&1 && return 0
  [[ "${1:-}" == "nostart" ]] && die "Docker is not running."
  local exe="/c/Program Files/Docker/Docker/Docker Desktop.exe"
  if [[ -f "$exe" ]]; then
    echo "Starting Docker Desktop…"
    "$exe" >/dev/null 2>&1 &
    disown || true
  else
    die "Docker is not running. Start Docker Desktop (or the Docker daemon) and retry."
  fi
  for _ in $(seq 1 90); do
    docker info >/dev/null 2>&1 && { echo "Docker is up."; return 0; }
    sleep 2
  done
  die "Docker did not start within 3 minutes."
}

# Expand group names into the global "services" array; reject unknown names early.
services=()
resolve_services() {
  local s
  for s in "$@"; do
    case "$s" in
      sim) services+=("${SIM_SERVICES[@]}") ;;
      obs) services+=("${OBS_SERVICES[@]}") ;;
      mockprod|otel-collector|tempo|prometheus|grafana) services+=("$s") ;;
      *) die "unknown service or group '$s' (use sim, obs, mockprod, otel-collector, tempo, prometheus, grafana)" ;;
    esac
  done
}

check_health() {  # prints one line per endpoint; returns 0 if all of the given names are up
  local wanted=("$@") all_ok=0 entry name url
  for entry in "${HEALTH[@]}"; do
    name="${entry%%|*}"; url="${entry#*|}"
    if ((${#wanted[@]})) && [[ ! " ${wanted[*]} " == *" $name "* ]]; then continue; fi
    if curl -fsS -m 3 -o /dev/null "$url" 2>/dev/null; then
      printf "  %-20s up    %s\n" "$name" "$url"
    else
      printf "  %-20s DOWN  %s\n" "$name" "$url"; all_ok=1
    fi
  done
  return $all_ok
}

# Health-check names that belong to the given compose services.
health_names_for() {
  local names=() s
  (($# == 0)) && set -- "${SIM_SERVICES[@]}" "${OBS_SERVICES[@]}"
  for s in "$@"; do
    case "$s" in
      mockprod) names+=("process engine" "dealer workstation") ;;
      *) names+=("$s") ;;
    esac
  done
  printf '%s\n' "${names[@]}"
}

wait_healthy() {
  local names=() line
  while IFS= read -r line; do names+=("$line"); done < <(health_names_for "$@")
  echo "Waiting for services to be healthy…"
  for _ in $(seq 1 60); do
    check_health "${names[@]}" >/dev/null 2>&1 && { check_health "${names[@]}"; return 0; }
    sleep 3
  done
  check_health "${names[@]}" || true
  echo "Some services are not healthy after 3 minutes; see: ./stack.sh logs <service>"
  return 1
}

print_urls() {
  cat <<'EOF'

  Grafana     http://localhost:3000   (Dashboards › BPMN IQ › BPMN business flows)
  Prometheus  http://localhost:9090
  Tempo API   http://localhost:3200
EOF
}

cmd="${1:-}"; shift || true
build=()
args=()
for a in "$@"; do
  if [[ "$a" == "--build" ]]; then build=(--build); else args+=("$a"); fi
done
resolve_services ${args[@]+"${args[@]}"}

case "$cmd" in
  start)
    ensure_docker
    [[ -f .env ]] || echo "Note: no mockprod/.env; using defaults (OBSERVE_MODE=local)."
    docker compose up -d "${build[@]}" "${services[@]}"
    wait_healthy "${services[@]}" && print_urls
    ;;
  stop)
    ensure_docker nostart
    docker compose stop "${services[@]}"
    ;;
  restart)
    ensure_docker
    if ((${#build[@]})); then
      docker compose up -d --build --force-recreate "${services[@]}"
    else
      docker compose restart "${services[@]}"
    fi
    wait_healthy "${services[@]}" && print_urls
    ;;
  status)
    ensure_docker nostart
    docker compose ps --format "table {{.Service}}\t{{.State}}\t{{.Status}}"
    echo
    check_health || true
    ;;
  logs)
    ensure_docker nostart
    docker compose logs -f --tail 100 "${services[@]}"
    ;;
  down)
    ensure_docker nostart
    docker compose down
    ;;
  *)
    sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
