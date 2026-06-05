# Cloud Run Sandboxes User Guide

Cloud Run Sandboxes provide fast, isolated environments for executing untrusted code inside Cloud Run containers. 

## Prerequisites

Access is controlled by the Cloud Run team. Submit [this form](https://forms.gle/dRJzeLDoGcFmSbiM7) to request allow-listing for your GCP project.

Once allowed, the sandbox binary is automatically made available in all your Cloud Run containers (Services, Jobs, and Instances).

---

## Deploying an ADK Agent App with Sandbox Support

You can deploy our showcase project to verify gVisor sandbox capabilities within a Cloud Run container.

**Repository:** [github.com/ryanpei/cloud-run-sandboxes](https://github.com/ryanpei/cloud-run-sandboxes)

### Setup GCP Variables
```bash
export PROJECT_ID="YOUR_GCP_PROJECT_ID"
export REGION="YOUR_GCP_REGION"
```

### 1. Build Container Image
Submit the build to Cloud Build (this compiles the agent and pre-installs Python 3):
```bash
gcloud builds submit --tag gcr.io/${PROJECT_ID}/sandbox-assistant:latest --project=${PROJECT_ID}
```

### 2. Deploy to Cloud Run
Deploy the container using the second-generation (`gen2`) execution environment to enable the sandbox mounting socket:
```bash
gcloud run deploy secure-coding-assistant \
  --image=gcr.io/${PROJECT_ID}/sandbox-assistant:latest \
  --region=${REGION} \
  --project=${PROJECT_ID} \
  --execution-environment=gen2 \
  --no-invoker-iam-check \
  --set-env-vars GOOGLE_GENAI_USE_VERTEXAI=1,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_LOCATION=${REGION}
```

---

## Security Configuration (Optional)

Lock the container behind Bearer Token Authentication by setting `API_AUTH_TOKEN` during deployment:

```bash
# Create a secret to store your access token
gcloud secrets create api-auth-token --replication-policy="automatic"

export API_AUTH_TOKEN=$(gcloud auth print-access-token)

echo -n "$API_AUTH_TOKEN" | gcloud secrets versions add api-auth-token --data-file=-

PROJECT_NUMBER=$(gcloud projects describe ${PROJECT_ID} --format="value(projectNumber)")

gcloud secrets add-iam-policy-binding api-auth-token \
 --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
 --role="roles/secretmanager.secretAccessor" \
 --project=${PROJECT_ID}

gcloud run deploy secure-coding-assistant \
  --image=gcr.io/${PROJECT_ID}/sandbox-assistant:latest \
  --region=${REGION} \
  --project=${PROJECT_ID} \
  --execution-environment=gen2 \
  --no-invoker-iam-check \
  --set-env-vars GOOGLE_GENAI_USE_VERTEXAI=1,GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_LOCATION=${REGION} \
  --set-secrets API_AUTH_TOKEN=api-auth-token:latest
```

*   **Browser UI:** Load the chatbot appending the query token:
    `http://localhost:9900/dev-ui/?app=coding_assistant&token=your-token`
    *(The gateway sets an HttpOnly session cookie on first load; subsequent WebSocket connections authenticate automatically).*
*   **REST API Client:** Export the token on your workstation terminal. The CLI client automatically appends the Bearer headers:
    `export API_AUTH_TOKEN="your-token"`

---

## REST API Sandbox Execution (CLI Client)

To execute Python scripts directly inside the cloud sandbox using the workstation CLI client:

```bash
# Execute a custom Python script
npx tsx client/client.ts https://secure-coding-assistant-YOUR_PROJECT.us-west1.run.app client/example.py
```

---

## Using the Sandbox CLI Directly

For debugging or testing, you can SSH directly into the container using [SSH for Cloud Run](https://docs.google.com/document/d/1D9Eb2rlYcJgPUXjCJW1b-LFSpASrGxnTABDRlzbmuGU/edit?resourcekey=0-lrYnhhG53rsKfwCHO1JHNQ&tab=t.0#heading=h.n821zo6z9ewr).

The sandbox binary is located at `/usr/local/gcp/bin/sandbox`. Add an alias for convenience:
```bash
alias sandbox="/usr/local/gcp/bin/sandbox"
```

### 1. One-Off Execution (`sandbox do`)
Create, run a command, and destroy an ephemeral sandbox in a single step:
```bash
sandbox do -- /bin/sh -c "echo hello"
```

#### Common `do` Flags:
*   `--allow-egress` : Allow network egress from the sandbox (e.g., to pull/push data).
*   `-e`, `--env KEY=VAL` : Set environment variables inside the sandbox.
*   `--workdir PATH` : Set the working directory.
*   `--rootfs PATH` : Map the root filesystem (default: `/`, read-only).
*   `--write` : Allow mounted filesystems to be writable.
*   `--persist-dir PATH` : Direct host path to persist filesystem changes between executions.
*   `--overlaydir PATH` : Path to use as a writable overlay layer.
*   `--mount src=...,dst=...` : Mount a host directory or volume.

### 2. Persistent Sandboxes (`sandbox run`, `exec`, `delete`)
For multi-step interactions where you need to retain the sandbox state:

#### A. Start a Persistent Session
```bash
# Starts an empty persistent sandbox session in the background
sandbox run my-session-1 --detach
```
*(Accepts all common `do` flags listed above to configure network, environment, and mounts).*

#### B. Execute Commands in a Running Session
Run one or more commands inside your already running sandbox session:
```bash
# Execute command
sandbox exec my-session-1 /usr/bin/python3 -c "print('Hello from sandbox')"

# Execute in specific directory with env variables
sandbox exec my-session-1 -e FOO=BAR --workdir /tmp /bin/sh -c "echo \$FOO"
```

#### C. Stop and Remove a Session
```bash
# Stop and clean up the sandbox session
sandbox delete my-session-1

# Force delete a running sandbox session
sandbox delete my-session-1 --force
```

### 3. Advanced Lifecycle Operations (`wait`, `tar`)

#### Wait for Completion (`sandbox wait`)
Block execution until a specific sandbox session terminates and output its exit code:
```bash
sandbox wait my-session-1
```

#### Export Sandbox Changes (`sandbox tar`)
Create and save a tarball of all writable modifications made to the filesystem during the sandbox session:
```bash
sandbox tar my-session-1 --file /tmp/session_changes.tar
```
*(This captures all new, modified, or deleted files relative to the baseline rootfs).*
