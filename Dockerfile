# ---------------------------------------------------------------------------
# Shared base image for origin, edge, and shield services.
# All three Python services share identical runtime dependencies;
# only the WORKDIR and CMD differ (set by docker-compose).
# ---------------------------------------------------------------------------

FROM python:3.12-slim AS base

# Install system deps (curl is useful for health-check probes inside containers)
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user for security hygiene
RUN useradd --create-home appuser
USER appuser
WORKDIR /app

# --- Python dependencies ---
COPY --chown=appuser:appuser requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

# PATH for --user installed binaries
ENV PATH="/home/appuser/.local/bin:${PATH}"

# Source files are copied in by docker-compose build context overrides,
# but we need a sensible default CMD so the image is self-contained.
# Individual services override this in docker-compose.yml.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
