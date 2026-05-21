from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routes.leads import router as leads_router
from routes.generate import router as generate_router
from routes.history import router as history_router
from routes.active import router as active_router
from routes.dashboard import router as dashboard_router
from routes.custom_links import router as custom_links_router

app = FastAPI(title="Website Generator API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(leads_router)
app.include_router(generate_router)
app.include_router(history_router)
app.include_router(active_router)
app.include_router(dashboard_router)
app.include_router(custom_links_router)


@app.get("/health")
def health():
    return {"status": "ok"}
