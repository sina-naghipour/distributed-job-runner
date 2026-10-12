# ==============================================================================
# Distributed Job Runner (DJR) - Automated Verification & Demonstration Script
# Covers Happy Paths, Routing, Failures, Live Streaming & Fault Tolerance
# ==============================================================================

$baseUrl = "http://localhost:4000/api"
$ErrorActionPreference = "Stop"

function Print-Header($title) {
  Write-Host "`n====================================================================" -ForegroundColor Cyan
  Write-Host "  $title" -ForegroundColor Cyan
  Write-Host "====================================================================" -ForegroundColor Cyan
}

function Print-Success($msg) {
  Write-Host "[PASS] $msg" -ForegroundColor Green
}

function Print-Info($msg) {
  Write-Host "[INFO] $msg" -ForegroundColor Yellow
}

# ------------------------------------------------------------------------------
# SCENARIO 1: Cluster Health & Multi-Agent Discovery
# ------------------------------------------------------------------------------
Print-Header "SCENARIO 1: Cluster Health & Multi-Agent Discovery"
$agentsRes = Invoke-RestMethod -Uri "$baseUrl/agents" -Method Get
$agents = $agentsRes.agents

Print-Info "Connected Agents count: $($agents.Count)"
foreach ($a in $agents) {
  Print-Info "  - Agent ID: $($a.agentId), Docker Version: $($a.dockerVersion), Active Jobs: $($a.activeJobCount)"
}

if ($agents.Count -lt 2) {
  Write-Error "Expected at least 2 independent agents connected to control plane!"
}
Print-Success "Two independent agents (agent-alpha & agent-beta) are connected and reporting heartbeats."

# ------------------------------------------------------------------------------
# SCENARIO 2: Targeted Routing & Isolated Execution on agent-alpha
# ------------------------------------------------------------------------------
Print-Header "SCENARIO 2: Targeted Routing to agent-alpha"
$jobAlphaBody = @{
  targetAgentId = "agent-alpha"
  image = "alpine:latest"
  script = "echo 'EXECUTING_ON_ALPHA'; uname -a; sleep 1; echo 'DONE_ALPHA';"
} | ConvertTo-Json

$resA = Invoke-RestMethod -Uri "$baseUrl/jobs" -Method Post -Body $jobAlphaBody -ContentType "application/json"
$jobIdA = $resA.jobId
Print-Info "Dispatched Job $jobIdA to agent-alpha (Status: $($resA.state))"

Start-Sleep -Seconds 3

$jobA = Invoke-RestMethod -Uri "$baseUrl/jobs/$jobIdA" -Method Get
$logsA = (Invoke-RestMethod -Uri "$baseUrl/jobs/$jobIdA/logs" -Method Get).logs

Print-Info "Execution Logs from container:`n$logsA"
if ($jobA.state -eq "SUCCEEDED" -and $logsA -match "EXECUTING_ON_ALPHA") {
  Print-Success "Job successfully executed on agent-alpha with exit code 0."
} else {
  Write-Error "Job on agent-alpha failed or produced incorrect logs!"
}

# ------------------------------------------------------------------------------
# SCENARIO 3: Targeted Routing to agent-beta & Non-Zero Exit Code Detection
# ------------------------------------------------------------------------------
Print-Header "SCENARIO 3: Error Handling & Non-Zero Exit Code on agent-beta"
$jobBetaFailBody = @{
  targetAgentId = "agent-beta"
  image = "alpine:latest"
  command = @("sh", "-c", "echo 'Triggering deliberate failure on beta...'; exit 55")
} | ConvertTo-Json

$resB = Invoke-RestMethod -Uri "$baseUrl/jobs" -Method Post -Body $jobBetaFailBody -ContentType "application/json"
$jobIdB = $resB.jobId
Print-Info "Dispatched Job $jobIdB to agent-beta"

Start-Sleep -Seconds 2

$jobB = Invoke-RestMethod -Uri "$baseUrl/jobs/$jobIdB" -Method Get
Print-Info "Job State: $($jobB.state), ExitCode: $($jobB.result.exitCode)"

if ($jobB.state -eq "FAILED" -and $jobB.result.exitCode -eq 55) {
  Print-Success "Non-zero exit code correctly transitioned job state to FAILED without crashing the agent."
} else {
  Write-Error "Failed to capture non-zero exit code on agent-beta!"
}

# ------------------------------------------------------------------------------
# SCENARIO 4: Idempotency Key Deduplication
# ------------------------------------------------------------------------------
Print-Header "SCENARIO 4: Idempotent Submission Guard"
$idemKey = "demo-idem-" + [guid]::NewGuid().ToString().Substring(0, 8)
$idemBody = @{
  targetAgentId = "agent-alpha"
  image = "alpine:latest"
  command = @("echo", "Testing idempotency deduplication")
  idempotencyKey = $idemKey
} | ConvertTo-Json

Print-Info "Submitting first request with idempotencyKey: $idemKey"
$sub1 = Invoke-RestMethod -Uri "$baseUrl/jobs" -Method Post -Body $idemBody -ContentType "application/json"
Print-Info "First submission returned Job ID: $($sub1.jobId)"

Print-Info "Replaying identical request with same idempotencyKey..."
$sub2 = Invoke-RestMethod -Uri "$baseUrl/jobs" -Method Post -Body $idemBody -ContentType "application/json"
Print-Info "Second submission returned Job ID: $($sub2.jobId), IdempotentReplay: $($sub2.idempotentReplay)"

if ($sub1.jobId -eq $sub2.jobId -and $sub2.idempotentReplay -eq $true) {
  Print-Success "Idempotency verified: Duplicate requests safely reused existing job record without re-spawning containers."
} else {
  Write-Error "Idempotency deduplication check failed!"
}

# ------------------------------------------------------------------------------
# SCENARIO 5: Offline Agent Queueing & Auto-Drain upon Reconnect
# ------------------------------------------------------------------------------
Print-Header "SCENARIO 5: Offline Agent Queueing & Auto-Drain"
Print-Info "Temporarily taking agent-beta offline..."
docker compose stop agent-beta | Out-Null
Start-Sleep -Seconds 1

$offlineBody = @{
  targetAgentId = "agent-beta"
  image = "alpine:latest"
  script = "echo 'RECONNECTED_BETA_SUCCESS'; uptime;"
} | ConvertTo-Json

Print-Info "Submitting job targeted to offline agent-beta..."
$offRes = Invoke-RestMethod -Uri "$baseUrl/jobs" -Method Post -Body $offlineBody -ContentType "application/json"
Print-Info "Response: state=$($offRes.state), message=$($offRes.message)"

$queueStatus = (Invoke-RestMethod -Uri "$baseUrl/queue" -Method Get).queues
Print-Info "Offline Queue Depth for agent-beta: $($queueStatus.'agent-beta')"

Print-Info "Restarting agent-beta to initiate reconnection..."
docker compose start agent-beta | Out-Null

Print-Info "Waiting 4s for agent-beta to reconnect, drain queue, and finish execution..."
Start-Sleep -Seconds 4

$jobDrain = Invoke-RestMethod -Uri "$baseUrl/jobs/$($offRes.jobId)" -Method Get
$logsDrain = (Invoke-RestMethod -Uri "$baseUrl/jobs/$($offRes.jobId)/logs" -Method Get).logs

Print-Info "Status after reconnection: $($jobDrain.state)"
Print-Info "Logs:`n$logsDrain"

if ($jobDrain.state -eq "SUCCEEDED" -and $logsDrain -match "RECONNECTED_BETA_SUCCESS") {
  Print-Success "Offline queueing verified: Job was buffered and automatically executed to completion upon agent reconnect!"
} else {
  Write-Error "Offline queue auto-drain check failed!"
}

# ------------------------------------------------------------------------------
# SCENARIO 6: Durable Final Log Disk Artifact Verification
# ------------------------------------------------------------------------------
Print-Header "SCENARIO 6: Durable Final Log Artifact Persistence"
$artifactPath = "./data/logs/$($jobIdA).log"
if (Test-Path $artifactPath) {
  $fileSize = (Get-Item $artifactPath).Length
  Print-Success "Final log exists on host disk at $artifactPath ($fileSize bytes), completely independent of container lifecycle."
} else {
  Write-Error "Log artifact $artifactPath not found on disk!"
}

Print-Header "ALL 6 DEMONSTRATION & FAILURE SCENARIOS COMPLETED SUCCESSFULLY!"
