# Simba Demo — How This Was Built, and How to Tear It Down

This is the record of the live “Commit → GitHub Actions → ECS” demo (workshop slides 5–7).
It describes what already exists in AWS account `431655581157` and GitHub repo
`amanzeht/simba-demo-api`, how each piece was created, the problems we hit, and the
exact order to destroy everything after the workshop.

Do not treat this as a greenfield runbook to re-create the stack from scratch unless you
intend to. Most IDs below are live. Recreating a named resource that already exists will
fail.

---

## 1. What the demo proves

The promotion path is **feature → dev → test → UAT → prod**.

- Every promotion is a **pull request**. Rulesets block direct pushes to `dev`,
  `test`, `uat`, and `prod`.
- The image is **built once** when a feature lands on `dev`. Later environments
  retag that **same digest**. No rebuild on the way to prod.
- **UAT is pre-production.** Whatever digest is on UAT is what a `uat → prod` PR
  will ship. It is not “another test stage.”
- **No human deploys.** You can see every environment on one ALB. Only GitHub
  Actions (OIDC role `simba-demo-github-actions`) may call `ecs:UpdateService`.

| Surface | Value |
|---|---|
| Catalog (all envs) | http://simba-demo-alb-84496632.us-east-1.elb.amazonaws.com/ |
| **dev** | http://simba-demo-alb-84496632.us-east-1.elb.amazonaws.com/dev |
| **test** | http://simba-demo-alb-84496632.us-east-1.elb.amazonaws.com/test |
| **UAT** | http://simba-demo-alb-84496632.us-east-1.elb.amazonaws.com/uat |
| **prod** | http://simba-demo-alb-84496632.us-east-1.elb.amazonaws.com/prod |
| GitHub repo | https://github.com/amanzeht/simba-demo-api (public) |
| Default branch | `dev` |

`GET /<env>/version` returns `{ environment, commit, version }`.

Pipeline:

| Event | What runs |
|---|---|
| PR into `dev` / `test` / `uat` / `prod` | Tests + Gitleaks + `npm audit`. No deploy. |
| Push/merge to `dev` | Validate, **build image once**, tag `:$SHA` and `:dev`, deploy `simba-demo-api-dev` |
| Push/merge to `test` | Validate, retag `:dev` → `:test` (same digest), deploy `simba-demo-api-test`, autocannon |
| Push/merge to `uat` | Validate, retag `:test` → `:uat`, deploy `simba-demo-api-uat`, smoke |
| Push/merge to `prod` | Validate, retag `:uat` → `:prod`, deploy `simba-demo-api-prod`, smoke |

v1 of this demo was a single `main` → one ECS service. That path is retired.
Sections 2–4 still describe how the shared network/IAM/ALB was first built.

---

## 2. Starting conditions (what we already had)

These were already true before any demo resources were created:

- Local machine had `aws`, `gh`, `git`, `docker`, `node`/`npm`.
- AWS CLI was logged in as `Team13_Admin` in `us-east-1`.
- That user is in IAM group `Admin` → `AdministratorAccess`.
- GitHub CLI was logged in as `amanzeht` (SSH git, `repo` scope).
- The application already existed in this folder: Express API, Jest tests, Dockerfile,
  workflow, task definition with `<ACCOUNT_ID>` placeholders.
- Account `431655581157` had a **default VPC** (`vpc-084154f2521cbf00c`, `172.31.0.0/16`)
  but **no subnets** and **no usable internet gateway**. The main route table already
  had a `0.0.0.0/0` route pointing at a **deleted** IGW (`igw-00970ad1ddd4ced36`) —
  state `blackhole`.
- No ECR repo, ECS cluster, ALB, demo IAM roles, or GitHub OIDC provider existed yet.
- There was no git repo and no GitHub remote.

We did **not** create a new VPC. We reused the default VPC and added the missing
network pieces.

---

## 3. Resource inventory (what exists now)

Account `431655581157`, region `us-east-1`. Resources created for this demo are tagged
`Project=simba-demo` where AWS allows tags.

### 3.1 Network

| Resource | ID / value | Notes |
|---|---|---|
| VPC (pre-existing default) | `vpc-084154f2521cbf00c` | **Do not delete** on teardown |
| Internet gateway | `igw-06b18982880e37da1` | Created and attached |
| Public subnet A | `subnet-08197c81de74479e6` | `172.31.0.0/20`, `us-east-1a`, auto-assign public IPv4 |
| Public subnet B | `subnet-0d4b9e3ceb8ae05eb` | `172.31.16.0/20`, `us-east-1b`, auto-assign public IPv4 |
| Main route table | `rtb-0b3831c80bba687b7` | `0.0.0.0/0` → `igw-06b18982880e37da1` |
| ALB security group | `sg-08a9614e8c1a311f1` (`simba-demo-alb-sg`) | Inbound TCP 80 from `0.0.0.0/0` |
| Task security group | `sg-0086538a0b9822024` (`simba-demo-task-sg`) | Inbound TCP 8080 from ALB SG only |

Fargate tasks use `assignPublicIp=ENABLED` so they can pull from ECR without a NAT
gateway (NAT would have been slower and more expensive).

### 3.2 IAM / OIDC

| Resource | Name / ARN |
|---|---|
| ECS task execution role | `simba-demo-ecsTaskExecutionRole` — attached `AmazonECSTaskExecutionRolePolicy` (pull ECR, write logs) |
| ECS task role | `simba-demo-ecsTaskRole` — no extra policies; the app needs none |
| GitHub Actions deploy role | `arn:aws:iam::431655581157:role/simba-demo-github-actions` |
| GitHub OIDC provider | `arn:aws:iam::431655581157:oidc-provider/token.actions.githubusercontent.com` |

The deploy role can: ECR auth + push + `DescribeImages`/`PutImage` (needed to
promote a digest without rebuilding), register/update ECS task definitions and
the four env services, and `iam:PassRole` on the two ECS roles only.

Trust policy allows `sts:AssumeRoleWithWebIdentity` and `sts:TagSession` from
`token.actions.githubusercontent.com` with audience `sts.amazonaws.com`, and `sub`
matching **both** claim formats (see §6.3):

- `repo:amanzeht/simba-demo-api:*` (classic)
- `repo:amanzeht@315419458/simba-demo-api@1351819977:*` (current GitHub ID-qualified `sub`)

### 3.3 Compute, registry, logs, load balancer

| Resource | Name / ID |
|---|---|
| ECR repository | `simba-demo-api` → `431655581157.dkr.ecr.us-east-1.amazonaws.com/simba-demo-api` |
| ECR promotion tags | `:dev` `:test` `:uat` `:prod` plus the commit SHA (same digest after promote) |
| CloudWatch log group | `/ecs/simba-demo-api` (7-day retention) |
| ECS cluster | `simba-demo-cluster` |
| Task definition family | `simba-demo-api` (one family; each env deploy registers a new revision with that env’s `BASE_PATH`) |
| ECS services | `simba-demo-api-dev`, `simba-demo-api-test`, `simba-demo-api-uat`, `simba-demo-api-prod` |
| Legacy service | `simba-demo-api-service` — scaled to 0 after the four-env cutover |
| Target groups | `simba-demo-dev-tg` (`/dev/health`), `simba-demo-test-tg`, `simba-demo-uat-tg`, `simba-demo-prod-tg` |
| Legacy target group | `simba-demo-api-tg` — unused after cutover |
| ALB | `simba-demo-alb` — path rules `/dev`, `/test`, `/uat`, `/prod`; default action is a JSON catalog |
| ALB DNS | `simba-demo-alb-84496632.us-east-1.elb.amazonaws.com` |
| Listener | `arn:aws:elasticloadbalancing:us-east-1:431655581157:listener/app/simba-demo-alb/402eaa315a79cd0f/0427835f4573f91e` |
| Listener rules | priority 10/20/30/40 → dev/test/uat/prod |

Target group ARNs:

| Env | ARN |
|---|---|
| dev | `arn:aws:elasticloadbalancing:us-east-1:431655581157:targetgroup/simba-demo-dev-tg/c5cbce63509b623e` |
| test | `arn:aws:elasticloadbalancing:us-east-1:431655581157:targetgroup/simba-demo-test-tg/7657cc0833a691f3` |
| uat | `arn:aws:elasticloadbalancing:us-east-1:431655581157:targetgroup/simba-demo-uat-tg/2ed8aee525719a12` |
| prod | `arn:aws:elasticloadbalancing:us-east-1:431655581157:targetgroup/simba-demo-prod-tg/00ed6ba4d9e05248` |

### 3.4 GitHub

| Resource | Value |
|---|---|
| Repo | `amanzeht/simba-demo-api`, public |
| Default branch | `dev` |
| Promotion branches | `dev`, `test`, `uat`, `prod` — PR-only (repository ruleset) |
| Leftover | `main` remains from v1; the pipeline no longer deploys it |
| Repo secret | `AWS_DEPLOY_ROLE_ARN` = `arn:aws:iam::431655581157:role/simba-demo-github-actions` |
| Repo variable | `DEMO_BASE_URL` = `http://simba-demo-alb-84496632.us-east-1.elb.amazonaws.com` |
| GitHub Environments | `dev`, `test`, `uat`, `prod` (Actions “environment” URLs; **no** manual approval gates — the PR is the human decision) |

### 3.5 App / repo files

| File | What it does now |
|---|---|
| `src/index.js` | Routes prefixed by `BASE_PATH` (`/dev`, `/test`, `/uat`, `/prod`). JSON includes `environment`. |
| `ecs-task-definition.json` | Account `431655581157`; `ENVIRONMENT` + `BASE_PATH` filled by the pipeline per env |
| `.github/workflows/deploy.yml` | Validate on PRs. Build only on `dev`. Digest promote on `test`/`uat`/`prod`. |

---

## 4. How the setup was created (step by step)

All AWS commands ran as `Team13_Admin` in `us-east-1`. The application code was already
in the working directory; we did not rewrite the API.

### Step 0 — Confirm the app and the account

```bash
npm ci
npm test          # 3 Jest tests: /, /health, /version
aws sts get-caller-identity
# Account 431655581157, user Team13_Admin
```

Filled `431655581157` into `ecs-task-definition.json` (replacing `<ACCOUNT_ID>`).

### Step 1 — Networking on the empty default VPC

The default VPC had no subnets and a blackhole default route. We:

1. Created IGW `igw-06b18982880e37da1` and attached it to `vpc-084154f2521cbf00c`.
2. Created two public subnets in `us-east-1a` / `us-east-1b` (`172.31.0.0/20`,
   `172.31.16.0/20`) and enabled `map-public-ip-on-launch`.
3. Deleted the blackhole `0.0.0.0/0` route on `rtb-0b3831c80bba687b7` (it pointed at
   deleted `igw-00970ad1ddd4ced36`) and created `0.0.0.0/0` → `igw-06b18982880e37da1`.
4. Created `simba-demo-alb-sg` (80 from the internet) and `simba-demo-task-sg`
   (8080 from the ALB SG only).

Equivalent commands:

```bash
VPC_ID=vpc-084154f2521cbf00c

IGW_ID=$(aws ec2 create-internet-gateway \
  --tag-specifications 'ResourceType=internet-gateway,Tags=[{Key=Name,Value=simba-demo-igw},{Key=Project,Value=simba-demo}]' \
  --query InternetGateway.InternetGatewayId --output text)
aws ec2 attach-internet-gateway --internet-gateway-id "$IGW_ID" --vpc-id "$VPC_ID"

SUBNET_A=$(aws ec2 create-subnet --vpc-id "$VPC_ID" --cidr-block 172.31.0.0/20 \
  --availability-zone us-east-1a \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=simba-demo-public-1a},{Key=Project,Value=simba-demo}]' \
  --query Subnet.SubnetId --output text)
SUBNET_B=$(aws ec2 create-subnet --vpc-id "$VPC_ID" --cidr-block 172.31.16.0/20 \
  --availability-zone us-east-1b \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=simba-demo-public-1b},{Key=Project,Value=simba-demo}]' \
  --query Subnet.SubnetId --output text)
aws ec2 modify-subnet-attribute --subnet-id "$SUBNET_A" --map-public-ip-on-launch
aws ec2 modify-subnet-attribute --subnet-id "$SUBNET_B" --map-public-ip-on-launch

# Then: delete the blackhole default route and recreate it pointing at $IGW_ID
# Then: create the two security groups and their ingress rules (see inventory)
```

### Step 2 — IAM roles and GitHub OIDC

1. Created `simba-demo-ecsTaskExecutionRole` and `simba-demo-ecsTaskRole` with trust
   `ecs-tasks.amazonaws.com`. Attached `AmazonECSTaskExecutionRolePolicy` to the
   execution role only.
2. Created the GitHub OIDC identity provider
   `token.actions.githubusercontent.com` (client ID `sts.amazonaws.com`,
   thumbprint `6938fd4d98bab03faadb97b34396831e3780aea1`).
3. Created role `simba-demo-github-actions` trusted by that provider, scoped to
   `repo:amanzeht/simba-demo-api:*`.
4. Attached inline policy `simba-demo-deploy`: ECR push to this one repo, ECS
   register/update, `iam:PassRole` on the two ECS roles.

The first pipeline run still failed OIDC (see §6.3). The trust policy was then updated
to also match GitHub’s ID-qualified `sub` and to allow `sts:TagSession`.

### Step 3 — Registry, logs, cluster, ALB

```bash
aws ecr create-repository --repository-name simba-demo-api \
  --image-scanning-configuration scanOnPush=true \
  --tags Key=Project,Value=simba-demo

aws logs create-log-group --log-group-name /ecs/simba-demo-api
aws logs put-retention-policy --log-group-name /ecs/simba-demo-api --retention-in-days 7

aws ecs create-cluster --cluster-name simba-demo-cluster \
  --tags key=Project,value=simba-demo

# Target group (target-type ip — required for Fargate/awsvpc)
# Health check: HTTP GET /health, interval 15s, healthy after 2, matcher 200

# ALB simba-demo-alb across both public subnets, SG simba-demo-alb-sg
# Listener HTTP :80 → forward to simba-demo-api-tg
```

An ECS service cannot be created until a task definition exists with a **real** image,
so the first image had to be built locally and pushed before the service.

### Step 4 — Bootstrap image, task definition, service

Chicken-and-egg: the pipeline deploys to a service that must already exist; the service
needs an image that is already in ECR.

```bash
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin \
    431655581157.dkr.ecr.us-east-1.amazonaws.com

# First local build (Apple Silicon) produced linux/arm64. Fargate default is linux/amd64.
# That image could not be pulled — see §6.2. Rebuild with:

docker build --platform linux/amd64 \
  -t 431655581157.dkr.ecr.us-east-1.amazonaws.com/simba-demo-api:bootstrap .
docker push 431655581157.dkr.ecr.us-east-1.amazonaws.com/simba-demo-api:bootstrap
```

A one-off task definition JSON was registered with that `bootstrap` image (the repo file
still has a placeholder image; the pipeline overwrites it on every deploy). Then:

```bash
aws ecs create-service \
  --cluster simba-demo-cluster \
  --service-name simba-demo-api-service \
  --task-definition simba-demo-api \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-08197c81de74479e6,subnet-0d4b9e3ceb8ae05eb],securityGroups=[sg-0086538a0b9822024],assignPublicIp=ENABLED}" \
  --load-balancers "targetGroupArn=arn:aws:elasticloadbalancing:us-east-1:431655581157:targetgroup/simba-demo-api-tg/f9df3f76a53eb918,containerName=simba-demo-api,containerPort=8080" \
  --health-check-grace-period-seconds 60
```

After the amd64 image was pushed and the service was force-redeployed, the target became
healthy and the three HTTP endpoints returned JSON. `/version` showed
`commit: bootstrap` until the pipeline ran.

### Step 5 — Git repo, GitHub remote, OIDC secret

```bash
git init -b main
git add -A
git commit -m "Add Simba demo API, pipeline, and ECS task definition."

gh repo create simba-demo-api --public --source=. --remote=origin \
  --description "Project Simba live demo: commit → GitHub Actions → ECS"

gh secret set AWS_DEPLOY_ROLE_ARN --repo amanzeht/simba-demo-api \
  --body "arn:aws:iam::431655581157:role/simba-demo-github-actions"

git push -u origin main
```

Secret was set **before** the push so the first workflow would have the role ARN.
Branch protection was **not** applied (slide 8 leftover).

### Step 6 — First pipeline run, OIDC fix, rerun

Push to `main` started workflow `33342364634`.

| Job | First run | After OIDC fix |
|---|---|---|
| Build & Unit/Integration Tests | pass | pass (cached) |
| Security Testing | pass | pass |
| Build Container Image & Push to ECR | **fail** — `sts:AssumeRoleWithWebIdentity` denied | pass |
| Light Load Test | skipped | pass |
| Deploy to ECS | skipped | pass (~4 min, wait-for-stability) |

Trust policy was updated (classic `sub` + ID-qualified `sub` + `sts:TagSession`).
Then: `gh run rerun 33342364634 --failed`.

After deploy, `GET /version` returned SHA `918a325d949d98870be2b101fe8b65383422c2da`,
matching `git rev-parse HEAD` on `main`. That was the working **v1** (single env) demo.

### Step 7 — Extend to feature → dev → test → UAT → prod

This was added after v1 was live.

1. App gained `BASE_PATH` + `ENVIRONMENT` so one image can serve `/dev`, `/test`,
   `/uat`, `/prod`.
2. Built `linux/amd64` image `v2-multienv` and tagged it `:dev` in ECR.
3. Created four target groups with health checks `/<env>/health`.
4. Replaced the ALB default forward with a JSON catalog. Added listener rules
   priority 10/20/30/40 for the four path prefixes.
5. Registered four task-definition revisions (same family, different env vars)
   and created `simba-demo-api-{dev,test,uat,prod}`. Scaled the legacy
   `simba-demo-api-service` to 0.
6. Rewrote `.github/workflows/deploy.yml` to build only on `dev` and promote
   digests afterward.
7. Created branches `dev` / `test` / `uat` / `prod`, set default to `dev`, added
   a ruleset that requires a pull request (0 extra reviewers — solo workshop)
   and blocks force-push/delete. Created GitHub Environments with URLs.
   Set `DEMO_BASE_URL`.

---

## 5. How a later commit flows (what you show in the room)

1. `git checkout dev && git checkout -b feature/new-message`
2. Change the `/` message (and tests). Open a PR **into `dev`**.
3. PR: tests + security only. Merge: image is **built once**, **dev** updates.
   `/dev/version` shows the new SHA. `/test`, `/uat`, `/prod` do not move.
4. PR **`dev` → `test`**. Merge: `:dev` digest is retagged `:test` and deployed.
   Autocannon hits `/test/health`.
5. PR **`test` → `uat`**. Merge: same digest to UAT. Say: this is pre-prod.
6. PR **`uat` → `prod`**. Merge: same digest to prod. No rebuild.

Compare `/<env>/version` after each merge. Only the environment you just promoted
changes. The pipeline is the only caller of `ecs:UpdateService`.

---

## 6. Problems we hit (so they are not rediscovered)

### 6.1 Empty default VPC + blackhole route

The default VPC had no subnets. The main route table’s `0.0.0.0/0` pointed at a
deleted IGW (`blackhole`). Creating a new IGW was not enough — `create-route` failed
with `RouteAlreadyExists`. We deleted the dead route, then created
`0.0.0.0/0 → igw-06b18982880e37da1`. Without that, the ALB and tasks have no internet
path (ECR pulls and client traffic both fail).

### 6.2 Apple Silicon image vs Fargate amd64

Local `docker build` on this Mac produced `linux/arm64`. ECS event:

```
CannotPullContainerError: image Manifest does not contain descriptor matching platform 'linux/amd64'
```

Fix: rebuild and push with `--platform linux/amd64`, then
`aws ecs update-service --force-new-deployment`. The workflow `docker build` line was
updated to the same flag so Actions (already amd64) stays explicit.

### 6.3 GitHub OIDC `sub` now includes numeric IDs

CloudTrail `userIdentity.principalId` for the failed assume-role was:

```
...:repo:amanzeht@315419458/simba-demo-api@1351819977:ref:refs/heads/main
```

not `repo:amanzeht/simba-demo-api:ref:refs/heads/main`.

The first trust policy (`StringLike` `repo:amanzeht/simba-demo-api:*`) did not match.
We added `repo:amanzeht@315419458/simba-demo-api@1351819977:*` and `sts:TagSession`
(`configure-aws-credentials@v4` tags the session). After that, assume-role succeeded.

`315419458` is the GitHub user id for `amanzeht`. `1351819977` is the repo id for
`simba-demo-api`. If the repo is transferred or recreated, this claim changes and the
trust policy must be updated again.

### 6.4 Gitleaks license

`gitleaks/gitleaks-action@v2` is free for **public** repos. We created the repo public
so the security-scan job would not need a `GITLEAKS_LICENSE`. If the repo is made
private, that job will fail until a license secret is added (or the scan is switched
to the Gitleaks container CLI).

### 6.5 First health-wait looked like a 503

An early wait loop ended with ALB `503` while tasks were still failing the arm64 pull.
That was the bootstrap image, not the ALB itself. After the amd64 image, targets went
healthy.

---

## 7. Cost while this stays up

Rough order of magnitude in `us-east-1`:

| Item | Why it costs |
|---|---|
| Application Load Balancer | Dominant cost. ~$16/month plus LCU. **Delete this first after the demo.** |
| Fargate 0.25 vCPU / 0.5 GB × **4 tasks** | Four environments. Still small vs the ALB, but 24/7 adds up |
| Public IPv4 on each task + ALB | AWS charges for in-use public IPv4 |
| ECR storage | Tiny for this image |
| CloudWatch Logs | 7-day retention; trivial at this volume |
| NAT gateway | **Not created** on purpose |

Idle overnight before Monday is fine. Do not leave the ALB up for weeks.

---

## 8. How to destroy it (exact order)

Teardown is **dependency-ordered**. Wrong order = `DependencyViolation` / `ResourceInUse`.

Do **not** delete:

- The default VPC `vpc-084154f2521cbf00c`
- The main route table `rtb-0b3831c80bba687b7` itself
- IAM user `Team13_Admin` or group `Admin`
- Anything not tagged / named `simba-demo*` unless you are sure it is ours

The OIDC provider `token.actions.githubusercontent.com` was created for this demo.
If anyone else in this account has started using it, **skip** that delete.

Set these once, then run the blocks in order. Wait where the comments say wait.

```bash
export AWS_REGION=us-east-1
export ACCOUNT_ID=431655581157
export VPC_ID=vpc-084154f2521cbf00c
export CLUSTER=simba-demo-cluster
export ALB_ARN=arn:aws:elasticloadbalancing:us-east-1:431655581157:loadbalancer/app/simba-demo-alb/402eaa315a79cd0f
export LISTENER_ARN=arn:aws:elasticloadbalancing:us-east-1:431655581157:listener/app/simba-demo-alb/402eaa315a79cd0f/0427835f4573f91e
export TG_DEV=arn:aws:elasticloadbalancing:us-east-1:431655581157:targetgroup/simba-demo-dev-tg/c5cbce63509b623e
export TG_TEST=arn:aws:elasticloadbalancing:us-east-1:431655581157:targetgroup/simba-demo-test-tg/7657cc0833a691f3
export TG_UAT=arn:aws:elasticloadbalancing:us-east-1:431655581157:targetgroup/simba-demo-uat-tg/2ed8aee525719a12
export TG_PROD=arn:aws:elasticloadbalancing:us-east-1:431655581157:targetgroup/simba-demo-prod-tg/00ed6ba4d9e05248
export TG_LEGACY=arn:aws:elasticloadbalancing:us-east-1:431655581157:targetgroup/simba-demo-api-tg/f9df3f76a53eb918
export SUBNET_A=subnet-08197c81de74479e6
export SUBNET_B=subnet-0d4b9e3ceb8ae05eb
export ALB_SG=sg-08a9614e8c1a311f1
export TASK_SG=sg-0086538a0b9822024
export IGW_ID=igw-06b18982880e37da1
export RTB=rtb-0b3831c80bba687b7
```

### 8.1 Stop taking traffic and stop tasks

```bash
for SVC in simba-demo-api-dev simba-demo-api-test simba-demo-api-uat simba-demo-api-prod simba-demo-api-service; do
  aws ecs update-service --cluster "$CLUSTER" --service "$SVC" --desired-count 0 || true
done
for SVC in simba-demo-api-dev simba-demo-api-test simba-demo-api-uat simba-demo-api-prod simba-demo-api-service; do
  aws ecs wait services-stable --cluster "$CLUSTER" --services "$SVC" || true
  aws ecs delete-service --cluster "$CLUSTER" --service "$SVC" --force || true
  aws ecs wait services-inactive --cluster "$CLUSTER" --services "$SVC" || true
done
```

### 8.2 Delete the load balancer (this is the expensive piece)

```bash
aws elbv2 delete-listener --listener-arn "$LISTENER_ARN" || true
aws elbv2 delete-load-balancer --load-balancer-arn "$ALB_ARN"
aws elbv2 wait load-balancers-deleted --load-balancer-arns "$ALB_ARN"

for TG in "$TG_DEV" "$TG_TEST" "$TG_UAT" "$TG_PROD" "$TG_LEGACY"; do
  aws elbv2 delete-target-group --target-group-arn "$TG" || true
done
```

### 8.3 Delete the ECS cluster and task definitions

```bash
aws ecs delete-cluster --cluster "$CLUSTER"

# List and deregister every revision so the family can disappear.
for ARN in $(aws ecs list-task-definitions --family-prefix simba-demo-api --query 'taskDefinitionArns[]' --output text); do
  aws ecs deregister-task-definition --task-definition "$ARN" >/dev/null
done
# Optional: delete the inactive task definitions so they do not linger in the console.
for ARN in $(aws ecs list-task-definitions --family-prefix simba-demo-api --status INACTIVE --query 'taskDefinitionArns[]' --output text); do
  aws ecs delete-task-definitions --task-definitions "$ARN" >/dev/null || true
done
```

### 8.4 Empty and delete ECR

```bash
# Delete all images (including bootstrap and SHA tags), then the repo.
IMGS=$(aws ecr list-images --repository-name simba-demo-api --query 'imageIds[*]' --output json)
if [ "$IMGS" != "[]" ]; then
  aws ecr batch-delete-image --repository-name simba-demo-api --image-ids "$IMGS"
fi
aws ecr delete-repository --repository-name simba-demo-api --force
```

### 8.5 Delete logs

```bash
aws logs delete-log-group --log-group-name /ecs/simba-demo-api
```

### 8.6 Delete security groups

Task SG references ALB SG, so delete the task SG first.

```bash
aws ec2 delete-security-group --group-id "$TASK_SG"
aws ec2 delete-security-group --group-id "$ALB_SG"
```

### 8.7 Delete subnets and the demo IGW

```bash
aws ec2 delete-subnet --subnet-id "$SUBNET_A"
aws ec2 delete-subnet --subnet-id "$SUBNET_B"

# Remove our default route before detaching the IGW, or it becomes a blackhole again.
aws ec2 delete-route --route-table-id "$RTB" --destination-cidr-block 0.0.0.0/0 || true

aws ec2 detach-internet-gateway --internet-gateway-id "$IGW_ID" --vpc-id "$VPC_ID"
aws ec2 delete-internet-gateway --internet-gateway-id "$IGW_ID"
```

Leave `vpc-084154f2521cbf00c` and `rtb-0b3831c80bba687b7` in place. They predated this demo.

### 8.8 Delete IAM roles and (optionally) the OIDC provider

```bash
aws iam detach-role-policy \
  --role-name simba-demo-ecsTaskExecutionRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam delete-role --role-name simba-demo-ecsTaskExecutionRole
aws iam delete-role --role-name simba-demo-ecsTaskRole

aws iam delete-role-policy --role-name simba-demo-github-actions --policy-name simba-demo-deploy
aws iam delete-role --role-name simba-demo-github-actions

# ONLY if nothing else in this account uses GitHub OIDC:
aws iam delete-open-id-connect-provider \
  --open-id-connect-provider-arn arn:aws:iam::431655581157:oidc-provider/token.actions.githubusercontent.com
```

### 8.9 GitHub cleanup

```bash
# From a clone of the repo:
gh secret delete AWS_DEPLOY_ROLE_ARN --repo amanzeht/simba-demo-api
gh variable delete DEMO_BASE_URL --repo amanzeht/simba-demo-api || true
for ENV in dev test uat prod; do
  gh api --method DELETE "repos/amanzeht/simba-demo-api/environments/$ENV" || true
done

# Optional — only if you also want the code hosting gone:
# gh repo delete amanzeht/simba-demo-api --yes
```

Deleting the GitHub repo is optional. The AWS bill stops once §8.2–8.5 are done.
Keeping the repo is useful if you want the pipeline YAML as a reference.

### 8.10 Local leftovers (optional)

```bash
docker rmi 431655581157.dkr.ecr.us-east-1.amazonaws.com/simba-demo-api:bootstrap || true
rm -f /tmp/simba-demo-ids.env /tmp/simba-github-trust.json /tmp/simba-github-perm.json /tmp/simba-task-def.json
```

### 8.11 Confirm nothing demo-shaped remains

```bash
aws ecs list-clusters
aws ecr describe-repositories --repository-names simba-demo-api 2>&1 | head
aws elbv2 describe-load-balancers --names simba-demo-alb 2>&1 | head
aws iam get-role --role-name simba-demo-github-actions 2>&1 | head
aws ec2 describe-security-groups --filters Name=group-name,Values=simba-demo-alb-sg,simba-demo-task-sg
aws ec2 describe-subnets --filters Name=tag:Project,Values=simba-demo
```

Every one of those should be empty or `*NotFound*` / `*RepositoryNotFound*`.

---

## 9. What is still not done

| Item | Status |
|---|---|
| Required *reviewer* on env PRs (count ≥ 1) | Ruleset requires a **PR** with 0 extra approvals so a solo demo can merge. Add 1 reviewer if two people are in the room. |
| HTTPS / custom domain | HTTP 80 + path prefixes. Enough for an internal workshop. |
| Separate ALBs per env | One ALB, four paths — cheaper and still “you can see every environment.” |
| Automated teardown script | This file is the script. Watch the OIDC provider delete. |

---

## 10. Quick “is it still up?” checks

```bash
BASE=http://simba-demo-alb-84496632.us-east-1.elb.amazonaws.com
curl -sS "$BASE/"
for env in dev test uat prod; do
  echo "---- $env ----"
  curl -sS "$BASE/$env/health"
  echo
  curl -sS "$BASE/$env/version"
  echo
done

aws ecs describe-services --cluster simba-demo-cluster \
  --services simba-demo-api-dev simba-demo-api-test simba-demo-api-uat simba-demo-api-prod \
  --query 'services[].{name:serviceName,running:runningCount,desired:desiredCount}'

gh run list --repo amanzeht/simba-demo-api --limit 8
```
