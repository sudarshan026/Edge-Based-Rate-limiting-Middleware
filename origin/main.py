"""
Origin Server — simulates a dynamic application with business logic.
Exposes:
  GET /products   → returns a hardcoded product catalogue (stand-in for a DB call)
  GET /health     → liveness probe
"""
from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [ORIGIN] %(levelname)s %(message)s",
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Fake database (hardcoded product catalogue)
# ---------------------------------------------------------------------------
PRODUCTS: list[dict[str, Any]] = [
    {"id": 1, "name": "Laptop Pro 15",    "price": 89999, "stock": 42},
    {"id": 2, "name": "Wireless Headset", "price":  3499, "stock": 120},
    {"id": 3, "name": "USB-C Hub 7-in-1", "price":  1899, "stock": 300},
    {"id": 4, "name": "Mechanical Keyboard", "price": 5999, "stock": 75},
    {"id": 5, "name": "4K Webcam",        "price":  7299, "stock": 55},
    {"id": 6, "name": "Ergonomic Mouse",  "price":  2199, "stock": 210},
    {"id": 7, "name": "27\" Monitor",     "price": 24999, "stock": 18},
    {"id": 8, "name": "Laptop Stand",     "price":  1499, "stock": 88},
]


# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Origin Server starting up.")
    yield
    logger.info("Origin Server shutting down.")


app = FastAPI(title="Origin Server", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    return {"status": "ok", "service": "origin", "ts": time.time()}


@app.get("/products")
async def get_products(request: Request):
    client_id = request.headers.get("x-client-id", "unknown")
    pop = request.headers.get("x-pop", "unknown")
    logger.info("GET /products  client_id=%s  via_pop=%s", client_id, pop)
    return JSONResponse(
        content={"products": PRODUCTS, "count": len(PRODUCTS)},
        headers={
            "x-origin-served-at": str(time.time()),
            "x-client-id": client_id,
        },
    )


# ---------------------------------------------------------------------------
# Catch-all for any other forwarded paths
# ---------------------------------------------------------------------------
@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def catch_all(path: str, request: Request):
    client_id = request.headers.get("x-client-id", "unknown")
    logger.info("catch-all /%s  client_id=%s", path, client_id)
    return JSONResponse(
        content={"message": f"Echo from origin: /{path}", "client_id": client_id},
        headers={"x-origin-served-at": str(time.time())},
    )
