# Project Simba — Live Demo (Slide 7)

This is the "Commit → Pipeline → Demo Cloud" demo Duane asked for on the call, built to
match slides 5–7 of the workshop deck:

- **Slide 5** — the five pipeline stages: Build, Container Image, Unit & Integration
  Tests, Security Testing, Load Testing.
- **Slide 6** — GitHub Actions as the pipeline tool, no manual trigger, no manual deploy.
- **Slide 7** — the live demo itself, deploying to a simple ECS cluster ("Demo Cloud").

## What's here

| File | Purpose |
|---|---|
| `src/index.js` | A minimal Express API (`/`, `/health`, `/version`) — "just a simple API to show a developer committing code." |
| `src/index.test.js` | Unit/integration tests — pipeline stage 3. |
| `Dockerfile` | Containerizes the API — pipeline stage 2. No secrets baked in, runs as a non-root user. |
| `.github/workflows/deploy.yml` | The GitHub Actions pipeline: build → test → security scan → build image → push to ECR → light load check → deploy to ECS. |
| `ecs-task-definition.json` | Fargate task definition the pipeline deploys against. |

## What Emeka needs to set up over the weekend

Duane's ask on the call, translated into steps:

1. **Get a demo AWS account** (or a sandboxed account/role within an existing one).
2. **Create an ECR repository** named `simba-demo-api` to hold the built images.
3. **Create a simple ECS cluster** (`simba-demo-cluster`) — Fargate is the least setup:
   - one Fargate **service** (`simba-demo-api-service`) running the task definition here
   - a small **Application Load Balancer** in front of it, target group on port 8080,
     health check path `/health`
4. **Create the two IAM roles** referenced in `ecs-task-definition.json`:
   - `simba-demo-ecsTaskExecutionRole` (standard ECS execution role — pulls the image, writes logs)
   - `simba-demo-ecsTaskRole` (permissions the app itself needs — none for this demo)
   - Fill in `<ACCOUNT_ID>` in `ecs-task-definition.json` once these exist.
5. **Set up GitHub OIDC → AWS** (no long-lived AWS keys stored in the repo, per the
   secrets-scan rule on slide 5):
   - create an IAM role GitHub Actions can assume via OIDC, scoped to push to ECR and
     deploy to this ECS service/cluster
   - add its ARN as a repo secret: `AWS_DEPLOY_ROLE_ARN`
6. **Push this repo to GitHub**, confirm branch protection is on `main` (slide 8), and
   merge a small PR — that's the "developer committing code" moment for the demo.
7. **Watch the Actions tab** — the pipeline should run all five stages and land the new
   version behind the load balancer. `GET /version` on the demo URL will show the
   commit SHA that's live, which is the payoff moment for the room.

## Monday decision point

Per the call: review this with Duane at Monday's sprint planning. If it's fully working,
demo it live on slide 7. If one or two pieces are still short, decide then whether to
present without the live demo rather than risk it on stage.
