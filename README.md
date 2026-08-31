# Project Simba — Live Demo

Commit → pull request → pipeline → environment. Humans never deploy.

The promotion path is:

```
feature → dev → test → UAT → prod
```

Every promotion is a pull request. There are no direct commits to `dev`, `test`,
`uat`, or `prod`. By the time a change reaches UAT it is treated as production-ready
(pre-production, not “another test stage”). You can see every environment; only
GitHub Actions can push to one.

## Live URLs

Catalog (lists every environment):
http://simba-demo-alb-84496632.us-east-1.elb.amazonaws.com/

| Environment | URL | What it is |
|---|---|---|
| **dev** | http://simba-demo-alb-84496632.us-east-1.elb.amazonaws.com/dev | First landing zone after a feature PR |
| **test** | http://simba-demo-alb-84496632.us-east-1.elb.amazonaws.com/test | Integration / light load |
| **UAT** | http://simba-demo-alb-84496632.us-east-1.elb.amazonaws.com/uat | Pre-production. Same image that will go to prod |
| **prod** | http://simba-demo-alb-84496632.us-east-1.elb.amazonaws.com/prod | Production |

`GET /<env>/version` shows `environment` + the commit SHA that environment is running.

## How a change moves

1. Branch from `dev`: `git checkout -b feature/your-change`
2. Open a PR **into `dev`**. Pipeline runs tests + Gitleaks + `npm audit`. Merge deploys
   to **dev** and **builds the image once**.
3. Open a PR **`dev` → `test`**. Merge does **not** rebuild. It retags the `dev` image
   digest as `test` and deploys that exact digest to **test**, then runs a light load check.
4. Open a PR **`test` → `uat`**. Same digest. UAT is pre-prod.
5. Open a PR **`uat` → `prod`**. Same digest again. No rebuild on the way to production.

Only the pipeline assumes `AWS_DEPLOY_ROLE_ARN` (GitHub OIDC) and calls `ecs:UpdateService`.

## What's here

| File | Purpose |
|---|---|
| `src/index.js` | Express API. Routes are prefixed by `BASE_PATH` (`/dev`, `/test`, `/uat`, `/prod`). |
| `src/index.test.js` | Unit/integration tests, including a UAT base-path case. |
| `Dockerfile` | Container image. No secrets. Non-root user. Built only on `dev`. |
| `.github/workflows/deploy.yml` | Validate on every PR. Build on `dev`. Promote digest on `test`/`uat`/`prod`. Deploy. |
| `ecs-task-definition.json` | Fargate task template. Pipeline fills image + env vars. |
| `SETUP-AND-TEARDOWN.md` | How the AWS/GitHub stack was built and how to destroy it. |

## Room demo

1. Hit the catalog URL, then `/dev/version`, `/test/version`, `/uat/version`, `/prod/version`.
2. Change the `/` message on a feature branch. PR → `dev`. Watch Actions deploy **dev** only.
3. PR `dev` → `test` → `uat` → `prod`. After each merge, only that environment’s SHA/digest moves.
4. On UAT, say the line: this is pre-production; prod will get this same image, not a new build.
