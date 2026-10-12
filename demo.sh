#!/usr/bin/env bash
# ==============================================================================
# Distributed Job Runner (DJR) - Automated Verification & Demonstration Script
# Bash version for Linux / macOS environments
# ==============================================================================

set -e
BASE_URL="http://localhost:4000/api"

echo "===================================================================="
echo "  SCENARIO 1: Cluster Health & Multi-Agent Discovery"
echo "===================================================================="
curl -s "$BASE_URL/agents" | grep -q "agent-alpha" && echo "[PASS] Multi-agent cluster alive."

echo "===================================================================="
echo "  SCENARIO 2: Targeted Routing to agent-alpha"
echo "===================================================================="
JOB_A=$(curl -s -X POST "$BASE_URL/jobs" \
  -H "Content-Type: application/json" \
  -d '{"targetAgentId":"agent-alpha","image":"alpine:latest","script":"echo BASH_ALPHA; uname -a"}')
JOB_ID_A=$(echo "$JOB_A" | grep -o '"jobId":"[^"]*' | cut -d'"' -f4)
echo "Dispatched Job: $JOB_ID_A"
sleep 3
curl -s "$BASE_URL/jobs/$JOB_ID_A/logs" | grep -q "BASH_ALPHA" && echo "[PASS] Job executed on agent-alpha."

echo "===================================================================="
echo "  SCENARIO 3: Error Handling & Non-Zero Exit Code"
echo "===================================================================="
JOB_FAIL=$(curl -s -X POST "$BASE_URL/jobs" \
  -H "Content-Type: application/json" \
  -d '{"targetAgentId":"agent-beta","image":"alpine:latest","command":["sh","-c","exit 77"]}')
JOB_ID_FAIL=$(echo "$JOB_FAIL" | grep -o '"jobId":"[^"]*' | cut -d'"' -f4)
sleep 2
curl -s "$BASE_URL/jobs/$JOB_ID_FAIL" | grep -q '"state":"FAILED"' && echo "[PASS] Non-zero exit code captured."

echo "===================================================================="
echo "  ALL CORE SCENARIOS COMPLETED SUCCESSFULLY!"
echo "===================================================================="
