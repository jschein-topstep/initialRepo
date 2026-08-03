$ErrorActionPreference = "Stop"

$AccountId = "776528084998"
$Region = "us-east-2"
$RepoName = "node-duckdb-lambda"
$FunctionName = "aiQueryReports"
$ImageUri = "$AccountId.dkr.ecr.$Region.amazonaws.com/$RepoName`:latest"

Write-Host "Building image..." -ForegroundColor Cyan
docker buildx build --platform linux/amd64 --provenance=false --output=type=docker -t $RepoName .

Write-Host "Tagging image..." -ForegroundColor Cyan
docker tag "$RepoName`:latest" $ImageUri

Write-Host "Pushing to ECR..." -ForegroundColor Cyan
docker push $ImageUri

Write-Host "Updating Lambda function..." -ForegroundColor Cyan
$env:AWS_PAGER = ""
aws lambda update-function-code --function-name $FunctionName --image-uri $ImageUri --query "LastUpdateStatus" --output text

Write-Host "Done." -ForegroundColor Green