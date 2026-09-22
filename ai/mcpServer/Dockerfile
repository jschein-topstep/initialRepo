# Build context for this Dockerfile is the REPO ROOT (see deploy.ps1), not
# this folder -- that's what lets it reach into ai/aiQueryReports/ (to reuse
# its DuckDB tool logic) and layer/nodejs/ (to reuse the existing SPP OAuth
# utilities) without duplicating either. Container-image Lambdas can't
# attach Lambda Layers at all (AWS platform limitation, PackageType: Image
# only), which is why layer/nodejs/*.mjs gets copied in directly instead of
# attached the way tslib-* functions attach it.
# docker build -f ai/mcpServer/Dockerfile .

FROM public.ecr.aws/lambda/nodejs:24

COPY ai/mcpServer/package.json ${LAMBDA_TASK_ROOT}

RUN npm install

# Reused as-is from aiQueryReports -- see the additive Object.assign(exports,
# ...) at the bottom of that file, and tools.js's require("./index.js") here.
COPY ai/aiQueryReports/index.js ${LAMBDA_TASK_ROOT}/index.js
COPY ai/aiQueryReports/agent-instructions.txt ${LAMBDA_TASK_ROOT}/agent-instructions.txt
COPY ai/aiQueryReports/tool-description.txt ${LAMBDA_TASK_ROOT}/tool-description.txt

# Reused as-is from the "sharedUtils" Lambda layer -- renamed to .mjs so
# Node treats them as ES modules regardless of this image's own (CommonJS)
# package.json, matching how they're loaded under /opt/nodejs/ normally.
COPY layer/nodejs/oauthUtils.mjs ${LAMBDA_TASK_ROOT}/oauthUtils.mjs
COPY layer/nodejs/sharedUtils.js ${LAMBDA_TASK_ROOT}/sharedUtils.mjs

COPY ai/mcpServer/mcp-handler.js ${LAMBDA_TASK_ROOT}
COPY ai/mcpServer/lambda-transport.js ${LAMBDA_TASK_ROOT}
COPY ai/mcpServer/tools.js ${LAMBDA_TASK_ROOT}
COPY ai/mcpServer/oauth-endpoints.js ${LAMBDA_TASK_ROOT}
COPY ai/mcpServer/sppUserAuth.js ${LAMBDA_TASK_ROOT}
COPY ai/mcpServer/sppRestClient.js ${LAMBDA_TASK_ROOT}
COPY ai/mcpServer/filterCache.js ${LAMBDA_TASK_ROOT}
COPY ai/mcpServer/filterScope.js ${LAMBDA_TASK_ROOT}

CMD [ "mcp-handler.handler" ]
