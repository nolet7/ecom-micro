# srespace shop (ecom-micro)

A demo e-commerce **microservices** application you can use to generate traffic and measure SLO/SLA compliance with Prometheus, Grafana, Sloth, etc.

## Services (5 custom images)
- `users` (Node/Express + Postgres)
- `catalog` (Node/Express + Postgres)
- `inventory` (Node/Express + Postgres)
- `payments` (Node/Express + Postgres) — modes: `always_success` | `always_fail` | `random` (default)
- `orders` (Node/Express + Postgres) — orchestrates **pricing → payment → inventory reservation** using idempotency

## Infra (prebuilt images)
- `api-gateway` (Nginx 1.25) reverse-proxies the services and serves a minimal static page
- 5× `postgres:15-alpine` (one DB per service)

---

## Prerequisites

- Docker + Docker Compose
- `jq` for nicer JSON output (optional)
- `kubectl` + a Kubernetes cluster
- `helm` (v3)
- For load testing: `hey` or `k6` (optional)

---

## Quick start (local, Docker Compose)

```bash
# From repo root
HOST_PORT=18081 docker compose up -d --build

# Open the gateway (serves a simple page):
# http://localhost:18081/
Health checks
curl -s http://localhost:18081/users/healthz     && echo
curl -s http://localhost:18081/catalog/healthz   && echo
curl -s http://localhost:18081/inventory/healthz && echo
curl -s http://localhost:18081/payments/healthz  && echo
curl -s http://localhost:18081/orders/healthz    && echo

Happy-path demo (no login required)

The gateway prefixes each service path: /users/*, /catalog/*, /inventory/*, /payments/*, /orders/*.

Create a user:

UID=$(curl -s -X POST http://localhost:18081/users/users \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","name":"Alice","password":"secret"}' | jq -r .id)
echo "User id: $UID"


Add two products:

P1=$(curl -s -X POST http://localhost:18081/catalog/products \
  -H 'content-type: application/json' \
  -d '{"name":"T-Shirt","price_cents":1999}' | jq -r .id)

P2=$(curl -s -X POST http://localhost:18081/catalog/products \
  -H 'content-type: application/json' \
  -d '{"name":"Sneakers","price_cents":8999}' | jq -r .id)

echo "P1=$P1  P2=$P2"


Seed inventory:

curl -s -X POST http://localhost:18081/inventory/inventory/seed \
  -H 'content-type: application/json' \
  -d "{\"product_id\":$P1,\"stock\":10}" && echo

curl -s -X POST http://localhost:18081/inventory/inventory/seed \
  -H 'content-type: application/json' \
  -d "{\"product_id\":$P2,\"stock\":3}" && echo


Place an order (idempotent):

curl -s -X POST http://localhost:18081/orders/orders \
  -H 'content-type: application/json' \
  -d "{\"user_id\":$UID,\"items\":[{\"product_id\":$P1,\"qty\":2},{\"product_id\":$P2,\"qty\":1}],\"idempotency_key\":\"demo-001\"}" | jq


Fetch the order with items:

curl -s http://localhost:18081/orders/orders/1 | jq


If you see 409 out_of_stock, seed more stock or reduce qty. The app’s “Refresh” UI pulls the latest product + stock before checkout.

Load testing

Using hey:

hey -z 30s -c 50 http://localhost:18081/catalog/products


Using k6:

# save as load.js
cat > load.js <<'K6'
import http from 'k6/http';
import { sleep } from 'k6';
export const options = { vus: 25, duration: '60s' };
export default function () {
  http.get('http://localhost:18081/catalog/products');
  sleep(0.1);
}
K6
k6 run load.js

CI/CD (Docker → Docker Hub → Helm to Kubernetes)

A GitHub Actions workflow (stored at
.github/workflows/docker-build-push-helm-deploy.yml) performs:

Build 5 service images with plain docker build

Push to Docker Hub:
docker.io/<DOCKERHUB_USERNAME>/ecom-micro-<service>:<GITHUB_SHA>

Deploy Helm chart charts/srespace-shop with:

--set imagePrefix=docker.io/<DOCKERHUB_USERNAME>/ecom-micro

--set tag=<GITHUB_SHA>

Required GitHub Secrets

DOCKERHUB_USERNAME = noletengine

DOCKERHUB_TOKEN = Docker Hub access token

KUBE_CONFIG = raw kubeconfig contents

Optional (CLI):

gh secret set DOCKERHUB_USERNAME --body "noletengine"
gh secret set DOCKERHUB_TOKEN    --body "<docker-hub-token>"
gh secret set KUBE_CONFIG        --body "$(cat ~/.kube/config)"

Helm (manual deploy)

If you want to deploy manually (bypassing CI), run:

helm upgrade --install srespace-shop charts/srespace-shop \
  --namespace srespace-shop --create-namespace \
  --set imagePrefix=docker.io/noletengine/ecom-micro \
  --set tag=$(git rev-parse HEAD)


Access the gateway:

# If cluster has LoadBalancer:
kubectl -n srespace-shop get svc api-gateway

# Or port-forward:
kubectl -n srespace-shop port-forward svc/api-gateway 18081:80
# Now open http://localhost:18081/

Notes & Troubleshooting

Port already allocated: run Compose with another port, e.g. HOST_PORT=18090.

DB connect ECONNREFUSED: first boot may take a few seconds while Postgres initializes; services retry. Check logs:

docker compose logs -f users catalog inventory payments orders


Inventory reserve 404: correct path is /inventory/inventory/reserve via the gateway.

Idempotency: reusing the same idempotency_key on /orders/orders prevents duplicate charges.

Repo layout
.
├── docker-compose.yml
├── frontend/
│   └── index.html
├── gateway/
│   └── nginx.conf
├── services/
│   ├── catalog/  (Dockerfile, package.json, server.js)
│   ├── inventory/ ...
│   ├── orders/   ...
│   ├── payments/ ...
│   └── users/    ...
└── charts/srespace-shop/   # Helm chart (values, templates)

License

MIT (or your choice).

