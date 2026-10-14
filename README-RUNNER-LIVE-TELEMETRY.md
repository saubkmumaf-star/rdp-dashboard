# Make Running Runner Cards show details before a run finishes

## Why the screenshot has `Not found in logs`

The dashboard sees the active workflow run, but GitHub's REST API log-download endpoints return downloadable archive/redirect URLs only when GitHub has made logs available. For many `in_progress` runs, `/actions/runs/{run_id}/logs` and even `/actions/jobs/{job_id}/logs` return 404 until the job completes. This is a GitHub API limitation, not a Turso database issue. See the [workflow-runs log endpoint docs](https://docs.github.com/en/rest/actions/workflow-runs#download-workflow-run-logs), [workflow-jobs log endpoint docs](https://docs.github.com/en/rest/actions/workflow-jobs#download-job-logs-for-a-workflow-run), and [GitHub Community discussion](https://github.com/orgs/community/discussions/75518).

This build tries both the run archive and individual job logs, then reports when live telemetry is required. For truly live CPU/RAM/OS/RDP fields, your target workflow must publish those values to the dashboard while the workflow is running.

## One-time setup (not a dashboard key)

1. Generate a long random secret (32+ characters).
2. Add it to Vercel **Production** Environment Variables as `RUNNER_INGEST_TOKEN`, then redeploy.
3. In Vercel **Settings → Deployment Protection → Protection Bypass for Automation**, create a bypass secret (needed only when Vercel Authentication protects the deployment). In the target GitHub repository's **Settings → Secrets and variables → Actions → Secrets**, add `RUNNER_INGEST_TOKEN` with the same value as Vercel and add `VERCEL_PROTECTION_BYPASS` with the generated Vercel bypass secret. Vercel documents this header-based automation flow [here](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation).
4. The target workflow needs its existing values to be available as environment variables named `RDP_ADDRESS`, `RDP_USERNAME`, and `RDP_PASSWORD`. If it uses different names, map the existing variables into these names in the example step. Do not echo them to logs.

These are integration secrets used only by the GitHub workflow; neither is an access-key prompt on the Running Runners page. Keep the Vercel deployment protected by Vercel Authentication because this dashboard can display credentials. The bypass secret should be stored only as a GitHub Actions secret and must never be printed in workflow logs.

## Add the telemetry step to the target workflow

Copy the following step into the target repository's workflow file (for example `.github/workflows/main.yml`) **after** the RDP credentials/address and Tailscale address have been generated. In the step `env`, update the `RDP_*` expressions if your workflow uses different environment names. If values are written to `$GITHUB_ENV`, they will be available in later steps.

```yaml
      - name: Publish live runner details to dashboard
        shell: pwsh
        env:
          DASHBOARD_URL: https://rdp-dashboard-jet.vercel.app
          RUNNER_INGEST_TOKEN: ${{ secrets.RUNNER_INGEST_TOKEN }}
          VERCEL_PROTECTION_BYPASS: ${{ secrets.VERCEL_PROTECTION_BYPASS }}
          RDP_ADDRESS: ${{ env.RDP_ADDRESS }}
          RDP_USERNAME: ${{ env.RDP_USERNAME }}
          RDP_PASSWORD: ${{ env.RDP_PASSWORD }}
        run: |
          $ErrorActionPreference = 'Stop'
          if ([string]::IsNullOrWhiteSpace($env:RUNNER_INGEST_TOKEN)) { throw 'RUNNER_INGEST_TOKEN GitHub Actions secret is missing.' }
          if ([string]::IsNullOrWhiteSpace($env:GITHUB_REPOSITORY) -or [string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ID)) { throw 'GitHub run metadata is missing.' }

          $cpuInfo = @(Get-CimInstance Win32_Processor)
          $cpu = ($cpuInfo | Select-Object -First 1 -ExpandProperty Name)
          $cores = ($cpuInfo | Measure-Object -Property NumberOfCores -Sum).Sum
          $threads = ($cpuInfo | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
          $computer = Get-CimInstance Win32_ComputerSystem
          $ram = '{0:N2} GB' -f ($computer.TotalPhysicalMemory / 1GB)
          $diskInfo = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
          $disk = if ($diskInfo) { '{0:N1} GB total, {1:N1} GB free' -f ($diskInfo.Size / 1GB), ($diskInfo.FreeSpace / 1GB) } else { '' }
          $osInfo = Get-CimInstance Win32_OperatingSystem
          $os = if ($osInfo) { "$($osInfo.Caption) ($($osInfo.Version))" } else { 'Windows' }

          $address = $env:RDP_ADDRESS
          if ([string]::IsNullOrWhiteSpace($address)) {
            $ts = Get-Command tailscale -ErrorAction SilentlyContinue
            if ($ts) { $address = (& $ts.Source ip -4 2>$null | Select-Object -First 1) }
          }
          $username = $env:RDP_USERNAME
          $password = $env:RDP_PASSWORD
          $aliveLine = if (-not [string]::IsNullOrWhiteSpace($address)) { "alive — RDP: $address" } else { '' }
          $payload = @{
            action = 'ingest'
            repo = $env:GITHUB_REPOSITORY
            runId = [long]$env:GITHUB_RUN_ID
            runNumber = [long]$env:GITHUB_RUN_NUMBER
            branch = $env:GITHUB_REF_NAME
            status = 'in_progress'
            details = @{
              cpu = $cpu
              cores = "$cores cores / $threads threads"
              ram = $ram
              disk = $disk
              os = $os
              address = $address
              username = $username
              password = $password
              aliveLine = $aliveLine
            }
            recentLines = @()
          } | ConvertTo-Json -Depth 6 -Compress
          $headers = @{ Authorization = "Bearer $env:RUNNER_INGEST_TOKEN" }
          # Needed only when the Vercel deployment is protected by Vercel Authentication.
          if (-not [string]::IsNullOrWhiteSpace($env:VERCEL_PROTECTION_BYPASS)) { $headers['x-vercel-protection-bypass'] = $env:VERCEL_PROTECTION_BYPASS }
          $result = Invoke-RestMethod -Method Post -Uri "$($env:DASHBOARD_URL.TrimEnd('/'))/api/runner-live" -Headers $headers -ContentType 'application/json' -Body $payload -TimeoutSec 15
          if ($result.ok -ne $true -or $result.stored -ne $true) { throw 'Dashboard did not confirm that telemetry was saved. Check Vercel protection bypass and server logs.' }
          Write-Host 'Live runner telemetry published to dashboard (credential values omitted).'
```

### Keep `aliveLine` fresh

The step above publishes current hardware and RDP values once. If your workflow already has a long-running keep-alive loop, call the same publish request again inside that loop (or rerun this step whenever the RDP/Tailscale address changes) so `aliveLine` and changed session values stay current. Do not print the request body, password, or ingestion token. The dashboard polls telemetry about every 30 seconds; active GitHub run cards themselves refresh on the normal dashboard interval.

## Validate

1. Redeploy the dashboard after adding `RUNNER_INGEST_TOKEN` in Vercel.
2. Add the secret to the target GitHub repository and commit the workflow step.
3. Dispatch a new workflow run (old runs cannot retroactively send telemetry).
4. Open Running Runners. After the publish step completes, the live detail fields should populate from the `runner_live` table in Turso. If not, check the action step's status and confirm that `GITHUB_REPOSITORY`, `GITHUB_RUN_ID`, and the three `RDP_*` variables contain the expected non-empty values; never print the password/token while troubleshooting.

## What stays as fallback

When a workflow finishes, the dashboard still tries GitHub's run log archive first and individual job logs second. Live telemetry is needed only to display details while a run is active, before GitHub publishes downloadable logs.
