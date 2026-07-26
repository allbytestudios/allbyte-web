# Godot cloud-exporter image.
# Built + pushed to ECR by .github/workflows/exporter-image.yml (OIDC, no keys).
# CodeBuild runs this image: clone game source -> cloud_export.sh -> push-channel.js.
#
# Contains ONLY tooling (Godot, templates, awscli, node, the two deployer scripts).
# NO game source, NO keys — those arrive at runtime (private clone + Secrets Manager).
#
# Layer ownership:
#   - App Claude owns: base, awscli, node, the /opt/exporter deployer scripts.
#   - Arc owns/confirms: the Godot install block (version, asset URLs, template path).
#     The container install works today — mirror its exact version. See the spec.

FROM node:22-bookworm-slim

# --- OS deps (Godot headless + build tooling) ---------------------------------
# python3 + git are required by cloud_export.sh (build_manifest.py / audit scripts,
# and the git short-sha stamp).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip git python3 python3-pip python-is-python3 fontconfig libfontconfig1 \
    && rm -rf /var/lib/apt/lists/*

# --- AWS CLI v2 (push-channel.js shells out to `aws`) --------------------------
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscliv2.zip \
    && aws --version

# --- Godot 4 headless + web export templates ----------------------------------
# ⚠ ARC: confirm these against the working container install. The template dir
# name MUST match Godot's expected "<version>.<status>" (e.g. 4.6.2.stable), or
# --export-release can't find the web template. NEVER run `godot --doctool` in
# this image — it wipes the export templates (in our runbook for a reason).
ARG GODOT_VERSION=4.6.2-stable
ARG GODOT_TEMPLATE_DIR=4.6.2.stable
ARG GODOT_RELEASE_BASE=https://github.com/godotengine/godot/releases/download
RUN set -eux; \
    curl -fsSL "${GODOT_RELEASE_BASE}/${GODOT_VERSION}/Godot_v${GODOT_VERSION}_linux.x86_64.zip" -o /tmp/godot.zip; \
    unzip -q /tmp/godot.zip -d /tmp; \
    mv "/tmp/Godot_v${GODOT_VERSION}_linux.x86_64" /usr/local/bin/godot; \
    chmod +x /usr/local/bin/godot; \
    curl -fsSL "${GODOT_RELEASE_BASE}/${GODOT_VERSION}/Godot_v${GODOT_VERSION}_export_templates.tpz" -o /tmp/templates.tpz; \
    mkdir -p "/root/.local/share/godot/export_templates/${GODOT_TEMPLATE_DIR}"; \
    unzip -q /tmp/templates.tpz -d /tmp/tpl; \
    cp -r /tmp/tpl/templates/* "/root/.local/share/godot/export_templates/${GODOT_TEMPLATE_DIR}/"; \
    rm -rf /tmp/godot.zip /tmp/templates.tpz /tmp/tpl; \
    godot --version

# cloud_export.sh expects the IMAGE to set GODOT_BIN explicitly (its `godot` is the
# real 4.6.2; the script's local-only fallback path doesn't exist here).
ENV GODOT_BIN=/usr/local/bin/godot
# Compat shim: Arc's Tier-2 gate (run-tests.sh) hardcodes the container godot path
# instead of honoring $GODOT_BIN. Provide it so the gate finds Godot 4.6.2.
# TODO(arc): make run-tests.sh honor GODOT_BIN, then drop this.
RUN mkdir -p /workspace/GameDev/Godots && ln -sf /usr/local/bin/godot /workspace/GameDev/Godots/godot4

# --- Deployer scripts (baked, pinned to this repo's commit) --------------------
# Pure Node builtins — no npm install. Rebuilt automatically by the workflow when
# these change (keeps CodeBuild's copy in sync with allbyte-web).
# push-channel.js resolves siblings relative to its repo root (join(__dirname,"..")):
# the obfuscator at root/scripts/ and gameVersions.ts at root/src/lib/. With
# push-channel at /opt/exporter/, root=/opt — so mirror that layout.
COPY scripts/push-channel.js /opt/exporter/push-channel.js
# push-channel imports ./verify-pck-encryption.js (the pre-deploy decrypt+MD5
# gate) as a SIBLING — must sit next to it at /opt/exporter/ or the import 404s.
COPY scripts/verify-pck-encryption.js /opt/exporter/verify-pck-encryption.js
COPY scripts/obfuscate-godot-export.js /opt/scripts/obfuscate-godot-export.js
COPY src/lib/gameVersions.ts /opt/src/lib/gameVersions.ts

# --- Post-deploy boot smoke (the "green = actually boots" gate) ----------------
# push-channel runs `python /opt/scripts/smoke_prod.py --channel <ch> --boot-only`
# after a dev-channel deploy and exits non-zero on failure — but the smoke only
# runs if the file AND a real headless Chromium are present. Baking both here is
# what makes a runtime-broken build fail the CodeBuild run instead of shipping
# green (the 2026-07-09 develop OOB shipped green precisely because neither was
# in the image, so the smoke silently no-op'd). smoke_prod.py's SUSPECT_PATTERNS
# already catch the Godot MD5/decrypt signatures behind that crash.
COPY scripts/smoke_prod.py /opt/scripts/smoke_prod.py
RUN pip3 install --no-cache-dir --break-system-packages playwright \
    && playwright install --with-deps chromium
# CodeBuild runs as root, where Chromium's sandbox can't initialize — smoke_prod
# reads this flag and launches headless with --no-sandbox.
ENV SMOKE_CHROMIUM_NO_SANDBOX=1

WORKDIR /workspace
