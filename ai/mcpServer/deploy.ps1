$ErrorActionPreference = "Stop"

$AccountId = "776528084998"
$Region = "us-east-2"
$RepoName = "spp-mcp-server"
$FunctionName = "sppMcpServer"
$ImageUri = "$AccountId.dkr.ecr.$Region.amazonaws.com/$RepoName`:latest"

# Build context is the REPO ROOT, not this folder -- the Dockerfile reaches
# into ai/aiQueryReports (DuckDB tool logic) and layer/nodejs (SPP OAuth
# utilities) to reuse both without duplicating them.
Push-Location "$PSScriptRoot\..\.."
try {
  Write-Host "Building image..." -ForegroundColor Cyan
  docker buildx build --platform linux/amd64 --provenance=false --output=type=docker `
    -f ai/mcpServer/Dockerfile -t $RepoName .
} finally {
  Pop-Location
}

Write-Host "Tagging image..." -ForegroundColor Cyan
docker tag "$RepoName`:latest" $ImageUri

Write-Host "Pushing to ECR..." -ForegroundColor Cyan
docker push $ImageUri

Write-Host "Updating Lambda function..." -ForegroundColor Cyan
$env:AWS_PAGER = ""
aws lambda update-function-code --function-name $FunctionName --image-uri $ImageUri --region $Region --query "LastUpdateStatus" --output text

Write-Host "Done." -ForegroundColor Green
