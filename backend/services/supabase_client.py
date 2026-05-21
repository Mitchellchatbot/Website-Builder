import os
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

_SUPABASE_URL: str | None = None
_SUPABASE_KEY: str | None = None


def _load_env() -> tuple[str, str]:
    global _SUPABASE_URL, _SUPABASE_KEY
    if not _SUPABASE_URL or not _SUPABASE_KEY:
        _SUPABASE_URL = os.getenv("SUPABASE_URL")
        _SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        if not _SUPABASE_URL or not _SUPABASE_KEY:
            raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env")
    return _SUPABASE_URL, _SUPABASE_KEY


def get_client() -> Client:
    # Fresh client per call — avoids stale HTTP/2 connections that cause
    # RemoteProtocolError: Server disconnected on reused connections.
    url, key = _load_env()
    return create_client(url, key)
