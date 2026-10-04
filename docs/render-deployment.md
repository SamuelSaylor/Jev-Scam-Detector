# Deploy the demo on Render

Create one Free Docker web service for the browser app and FastAPI. Demo mode needs no API keys. The service runs one worker, builds the default `render` stage of `Dockerfile`, and serves `/api/health` as its health endpoint.

## Create the service

1. In the [Render Dashboard](https://dashboard.render.com/), connect the private GitHub repository `SamuelSaylor/Jev-Scam-Detector`. Grant the Render GitHub app access to this repository. If Render reports that the repository URL is invalid or cannot be fetched, check the app's repository permissions before retrying. Do not select or change another service.
2. Choose **New > Blueprint**, select this repository and the `main` branch, and review `render.yaml`. Confirm one Free Docker web service, the repository root as Docker context, `./Dockerfile`, `/api/health`, and automatic deployment **Off**. The Blueprint has no disk, database, or paid add-on. Check the workspace's usage and payment settings before creation.
3. Keep automatic deploys off in the service Dashboard too. GitHub CD makes explicit requests after `main` CI passes. Do not enable **After CI Checks Pass** alongside CD or two deploy requests can occur.
4. Copy the new service ID, which starts with `srv-`, from its Dashboard URL. In the GitHub repository, create an environment named `production`. Add environment secrets `RENDER_API_KEY` and `RENDER_SERVICE_ID`. Create the Render API key for an account with access to this service. Add environment approval rules if an operator must approve releases. Never put these values in Git or browser config.

Blueprint creation can start an initial deploy even when automatic deploys are off. Confirm its revision separately; GitHub CD controls later releases. A feature-branch push does not release to production. Integrate the branch into `main`. The `CI` workflow runs source checks and both Docker runtime smokes on `main` pushes and pull requests. A successful `main` push triggers `Deploy production`. That workflow accepts only a successful `CI` push run from this repository, checks that its commit is still the current `main` head after environment approval, and asks Render to deploy that exact commit. It waits for Render's deploy result. A failed check or stale run does not request a deployment. A rerun for the still-current commit may request another deploy; manual Dashboard deploys are outside GitHub's queue.

For the first CD release, merge the deployment branch to `main` after the workflow and secrets are configured. Check that both `CI` jobs pass for that commit and that `Deploy production` finishes successfully. Inspect the service's Deploys page to confirm the live deploy commit matches that commit. If Render cannot fetch the private repository, fix its GitHub app permission. Do not bypass checks with a manual deploy to conceal that failure.

## Use the Render CLI

Install the official CLI on macOS and authorize it with the already signed-in browser:

```bash
brew install render
render login
render workspaces --output json --confirm
render services --output json --confirm
```

Select the workspace during `render login`. The service listing supplies the ID for `RENDER_SERVICE_ID`. To inspect its deploys, run `render deploys list SERVICE_ID --output json --confirm`. CLI login is for the operator. GitHub uses the API key in the `production` environment, not your local CLI session. Do not trigger a live deploy while setting up the CLI.

If a release must be rolled back, first pause the GitHub `Deploy production` workflow or stop merging to `main`, then select a known-good commit in Render's Deploys page or run `render deploys create SERVICE_ID --commit VERIFIED_SHA --wait --confirm`. Verify the live commit and run the two-person demo. A later successful `main` push can replace the rollback. Render auto-deploy must remain off.

## Check the running app

Open the service's `https://...onrender.com` URL in two separate browser contexts. Follow the [two-person demo steps](../README.md#try-the-two-person-no-key-demo). Check room creation, joining, typed lines, and the review. Test microphone audio on the intended networks. Local container checks do not establish public HTTPS, WSS, or media connectivity.

The service binds Render's `PORT` and uses `RENDER_EXTERNAL_URL` as the exact allowed WebSocket origin. For a custom domain, set `FRONTEND_ORIGIN` in the service environment to its exact browser origin, such as `https://call.example.org`. Do not add a path, trailing slash, or wildcard. This value takes precedence over `RENDER_EXTERNAL_URL`; restart after changing it.

For optional live transcription and assessment, set `OPENAI_API_KEY` and `TYPESAFE_API_KEY` as private service environment variables. Demo mode needs neither. To require a bearer token for `/api/emails/scan`, set `EMAIL_SCAN_TOKEN` in the service environment and configure the client with the same token. Without that setting, email scans allow unauthenticated requests. Keep all three values out of Git. Keep provider keys server-side; only the email client's bearer token belongs in its client configuration.

Free services sleep after 15 minutes without inbound traffic. A cold start takes time and discards in-memory rooms, tokens, transcripts, and pending assessments. Restarts and redeploys also discard them. Free instances have 750 hours per workspace per month; exhaustion suspends the service. Builds or bandwidth can incur charges with a payment method, so `plan: free` does not guarantee zero charges. Check [Render's current free limits](https://render.com/docs/free) before the event. `/api/health` checks process readiness, not call continuity or provider health. The shipped `/config.json` has STUN but no TURN relay, so some networks cannot carry peer audio.

Run `just smoke-containers` locally with Docker and uv to build and probe the default Render image and the split Compose layout with isolated fake credentials. The script creates its own ports and Compose project and removes its containers, Compose volumes, and run-specific image tags afterward. Docker retains build caches. It does not make paid-provider requests or test Render's public TLS edge.
