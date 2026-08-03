# Use the official AWS Lambda Node 24 image
FROM public.ecr.aws/lambda/nodejs:24

# Copy package.json over to the image
COPY package.json ${LAMBDA_TASK_ROOT}

# Install dependencies inside the Linux container so the binaries match AWS
RUN npm install

# Copy your actual code
COPY index.js ${LAMBDA_TASK_ROOT}

# Tell Lambda which function file and method to execute
CMD [ "index.handler" ]
