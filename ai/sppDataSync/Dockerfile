# Build context is the REPO ROOT (see deploy.ps1) -- reaches into
# layer/nodejs to reuse the existing SPP OAuth utilities without
# duplicating them. Container-image Lambdas can't attach Lambda Layers at
# all (needed here for the native DuckDB module), so oauthUtils.mjs is
# copied in directly instead of attached, same pattern as ai/mcpServer.
# docker build -f ai/sppDataSync/Dockerfile .

FROM public.ecr.aws/lambda/nodejs:24

COPY ai/sppDataSync/package.json ${LAMBDA_TASK_ROOT}

RUN npm install

# Reused as-is from the "sharedUtils" layer -- renamed to .mjs so Node
# treats it as an ES module regardless of this image's own (CommonJS)
# package.json.
COPY layer/nodejs/oauthUtils.mjs ${LAMBDA_TASK_ROOT}/oauthUtils.mjs

COPY ai/sppDataSync/sppDataSync.js ${LAMBDA_TASK_ROOT}

CMD [ "sppDataSync.handler" ]
