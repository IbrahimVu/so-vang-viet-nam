param(
  [Parameter(Mandatory)]
  [ValidatePattern('^[a-z][a-z0-9-]{4,28}[a-z0-9]$')]
  [string]$ProjectId,
  [ValidatePattern('^[a-z]+-[a-z]+[0-9]+$')]
  [string]$Region = 'asia-southeast1'
)

$ErrorActionPreference = 'Stop'
$gcloud = (Get-Command gcloud -ErrorAction Stop).Source

function Invoke-Cloud {
  & $gcloud @args "--project=$ProjectId" '--quiet'
  if ($LASTEXITCODE -ne 0) {
    throw "Google Cloud command failed: $($args[0]) $($args[1])"
  }
}

function Test-Cloud {
  & $gcloud @args "--project=$ProjectId" '--quiet' 2>$null | Out-Null
  return $LASTEXITCODE -eq 0
}

$billing = Invoke-Cloud billing projects describe $ProjectId '--format=value(billingEnabled)'
if ($billing -ne 'true') {
  throw 'The Google Cloud project must already have Billing enabled.'
}

$scanService = 'so-vang-scan'
$schedulerAccount = "so-vang-scheduler@$ProjectId.iam.gserviceaccount.com"
$runtimeAccount = "so-vang-runtime@$ProjectId.iam.gserviceaccount.com"
$bucket = "$ProjectId-so-vang-quotes"
$bucketUrl = "gs://$bucket"
$apis = @('run.googleapis.com', 'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com',
  'cloudscheduler.googleapis.com', 'storage.googleapis.com', 'logging.googleapis.com')
Invoke-Cloud services enable @apis

if (!(Test-Cloud iam service-accounts describe $runtimeAccount)) {
  Invoke-Cloud iam service-accounts create so-vang-runtime '--display-name=So Vang scanner'
}
if (!(Test-Cloud iam service-accounts describe $schedulerAccount)) {
  Invoke-Cloud iam service-accounts create so-vang-scheduler '--display-name=So Vang Scheduler invoker'
}
if (!(Test-Cloud storage buckets describe $bucketUrl)) {
  Invoke-Cloud storage buckets create $bucketUrl "--location=$Region" '--uniform-bucket-level-access'
}

Invoke-Cloud storage buckets add-iam-policy-binding $bucketUrl "--member=serviceAccount:$runtimeAccount" '--role=roles/storage.objectUser'

$deployOptions = @("--source=$PSScriptRoot", "--region=$Region",
  "--service-account=$runtimeAccount", "--update-env-vars=GOLD_SNAPSHOT_BUCKET=$bucket",
  '--command=node', '--args=cloud-scan.mjs', '--no-allow-unauthenticated', '--invoker-iam-check',
  '--ingress=internal', '--max-instances=1', '--concurrency=1', '--timeout=90s')
Invoke-Cloud run deploy $scanService @deployOptions

Invoke-Cloud run services add-iam-policy-binding $scanService "--region=$Region" "--member=serviceAccount:$schedulerAccount" '--role=roles/run.invoker'
$serviceUrl = Invoke-Cloud run services describe $scanService "--region=$Region" '--format=value(status.url)'
if ($serviceUrl -notmatch '^https://[^/]+$') { throw 'Cloud Run did not return a service URL.' }

function Set-ScanSchedule {
  param($Name, $Cron, $Route, $Method, $Deadline, $Retries)
  $operation = if (Test-Cloud scheduler jobs describe $Name "--location=$Region") { 'update' } else { 'create' }
  $options = @("--location=$Region", "--schedule=$Cron", '--time-zone=Asia/Ho_Chi_Minh',
    "--uri=$serviceUrl/$Route", "--http-method=$Method",
    "--oidc-service-account-email=$schedulerAccount", "--oidc-token-audience=$serviceUrl",
    "--attempt-deadline=$Deadline", "--max-retry-attempts=$Retries", '--max-retry-duration=120s',
    '--min-backoff=15s', '--max-backoff=45s')
  Invoke-Cloud scheduler jobs $operation http $Name @options
}

Set-ScanSchedule 'so-vang-scan' '*/5 8-20 * * *' 'scan' 'POST' '90s' 2
Set-ScanSchedule 'so-vang-health' '2-57/5 8-20 * * *' 'healthz' 'GET' '30s' 0

Write-Output "Private scanner deployed. Verify publication in $bucketUrl/prices.json before cutover."
