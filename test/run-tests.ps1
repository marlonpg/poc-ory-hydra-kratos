# Load Test Runner Script (Windows PowerShell)
# Usage: .\test\run-tests.ps1 -Profile low|medium|high

param(
    [ValidateSet('low', 'medium', 'high')]
    [string]$Profile = 'low'
)

$ErrorActionPreference = 'Stop'

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "POC Load Testing Suite" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Profile: $Profile" -ForegroundColor Green
Write-Host "Time: $(Get-Date)" -ForegroundColor Gray
Write-Host ""

# Check if k6 is installed
try {
    $k6Version = & k6 version 2>$null
    Write-Host "k6 version: $k6Version" -ForegroundColor Green
} catch {
    Write-Host "❌ k6 not found. Install from: https://k6.io/docs/getting-started/installation/" -ForegroundColor Red
    exit 1
}
Write-Host ""

# Verify services are running
Write-Host "🔍 Checking if services are running..." -ForegroundColor Yellow
$services = @(
    @{name='Hydra'; port=4444; endpoint='/.well-known/openid-configuration'},
    @{name='Kratos'; port=4433; endpoint='/health'},
    @{name='Vote API'; port=4000; endpoint='/health'}
)

foreach ($service in $services) {
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:$($service.port)$($service.endpoint)" -TimeoutSec 2 -ErrorAction SilentlyContinue
        Write-Host "✅ $($service.name):$($service.port) is running" -ForegroundColor Green
    } catch {
        Write-Host "⚠️  $($service.name):$($service.port) may not be responding" -ForegroundColor Yellow
    }
}
Write-Host ""

# Run tests
Write-Host "📊 Starting load tests..." -ForegroundColor Cyan
Write-Host ""

# Test 1: Hydra Token Endpoint
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Magenta
Write-Host "1️⃣  Testing Hydra Token Endpoint" -ForegroundColor Magenta
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Magenta
try {
    & k6 run -e LOAD=$Profile test/load-test-hydra.js
} catch {
    Write-Host "⚠️  Hydra test had issues" -ForegroundColor Yellow
}
Write-Host ""

# Test 2: Kratos Identity & Sessions
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Magenta
Write-Host "2️⃣  Testing Kratos Sessions" -ForegroundColor Magenta
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Magenta
try {
    & k6 run -e LOAD=$Profile test/load-test-kratos.js
} catch {
    Write-Host "⚠️  Kratos test had issues" -ForegroundColor Yellow
}
Write-Host ""

# Test 3: Vote API
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Magenta
Write-Host "3️⃣  Testing Vote API" -ForegroundColor Magenta
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Magenta
try {
    & k6 run -e LOAD=$Profile test/load-test-vote-api.js
} catch {
    Write-Host "⚠️  Vote API test had issues" -ForegroundColor Yellow
}
Write-Host ""

Write-Host "========================================" -ForegroundColor Green
Write-Host "✅ All tests completed!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "📈 Tips:" -ForegroundColor Cyan
Write-Host "  - Run with -Profile high for stress testing (10k req/s target)" -ForegroundColor Gray
Write-Host "  - Monitor service logs: docker-compose logs -f <service>" -ForegroundColor Gray
Write-Host "  - Check CPU/memory: docker stats" -ForegroundColor Gray
Write-Host ""
