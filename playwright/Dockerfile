FROM public.ecr.aws/lambda/nodejs:24

RUN dnf install -y \
  nss \
  atk \
  cups-libs \
  gtk3 \
  libXcomposite \
  libXcursor \
  libXdamage \
  libXext \
  libXi \
  libXrandr \
  libXScrnSaver \
  libXtst \
  pango \
  alsa-lib \
  libdrm \
  mesa-libgbm \
  && dnf clean all

WORKDIR ${LAMBDA_TASK_ROOT}

COPY package*.json ./
RUN npm install

COPY createBaseline.mjs ./

CMD ["createBaseline.handler"]