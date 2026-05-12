import sys
import io

"""
netlify_deployer.py
-------------------
Deploys generated company websites to Netlify via ZIP upload API.

Each company gets its own Netlify site. Site IDs are persisted in
netlify_sites.json so re-deploys update the same site rather than
creating a new one.

Usage:
    python netlify_deployer.py                        # deploy all companies that have index.html
    python netlify_deployer.py "Valley Spring Recovery"  # deploy one specific folder
    python netlify_deployer.py --list                 # list all deployed sites
"""

import os
import re
import json
import zipfile
import requests
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

ROOT_DIR      = Path(__file__).parent.parent  # backend/
SITES_DB      = ROOT_DIR / "netlify_sites.json"
API_BASE      = "https://api.netlify.com/api/v1"
EXCLUDE_DIRS  = {"output", ".git", "__pycache__", "memory"}


# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────

def slugify(name: str) -> str:
    s = name.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")[:50]


def load_sites_db() -> dict:
    if SITES_DB.exists():
        return json.loads(SITES_DB.read_text(encoding="utf-8"))
    return {}


def save_sites_db(db: dict):
    SITES_DB.write_text(json.dumps(db, indent=2), encoding="utf-8")


def auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ─────────────────────────────────────────────
# Site management
# ─────────────────────────────────────────────

def create_site(company_name: str, token: str) -> dict:
    slug = slugify(company_name)
    for attempt in range(6):
        name = slug if attempt == 0 else f"{slug}-{attempt}"
        resp = requests.post(
            f"{API_BASE}/sites",
            headers=auth_headers(token),
            json={"name": name},
            timeout=120,
        )
        if resp.status_code == 201:
            site = resp.json()
            print(f"   ✅ Site created: {site['url']}")
            return site
        if resp.status_code in (422, 409):
            continue
        resp.raise_for_status()
    raise RuntimeError(f"Could not create a unique Netlify site for '{company_name}' after 6 attempts")


def get_or_create_site(company_name: str, token: str) -> dict:
    db = load_sites_db()
    if company_name in db:
        print(f"   ℹ  Reusing site: {db[company_name]['url']}")
        return db[company_name]
    site = create_site(company_name, token)
    db[company_name] = {
        "site_id": site["id"],
        "name":    site["name"],
        "url":     site["url"],
    }
    save_sites_db(db)
    return db[company_name]


# ─────────────────────────────────────────────
# Zip builder
# ─────────────────────────────────────────────

def build_zip(lead_path: Path) -> bytes:
    index_html = lead_path / "index.html"
    images_dir = lead_path / "images"

    if not index_html.exists():
        raise FileNotFoundError(f"index.html not found in {lead_path}")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(index_html, "index.html")
        if images_dir.exists():
            for img in sorted(images_dir.iterdir()):
                if img.is_file():
                    zf.write(img, f"images/{img.name}")
                    print(f"   📦 {img.name}")

    return buf.getvalue()


# ─────────────────────────────────────────────
# Deploy
# ─────────────────────────────────────────────

def deploy_zip(site_id: str, zip_bytes: bytes, token: str) -> dict:
    resp = requests.post(
        f"{API_BASE}/sites/{site_id}/deploys",
        headers={**auth_headers(token), "Content-Type": "application/zip"},
        data=zip_bytes,
        timeout=300,
    )
    resp.raise_for_status()
    return resp.json()


def deploy_company(lead_folder: str | Path, token: str = None) -> str:
    token = token or os.getenv("NETLIFY_TOKEN")
    if not token:
        raise ValueError("NETLIFY_TOKEN not set in .env")

    lead_path    = Path(lead_folder)
    data_path    = lead_path / "data.json"
    company_name = lead_path.name

    if data_path.exists():
        data         = json.loads(data_path.read_text(encoding="utf-8"))
        company_name = data.get("company_name", lead_path.name)

    print(f"\n🚀 Deploying: {company_name}")

    print("   📦 Building zip...")
    zip_bytes = build_zip(lead_path)
    print(f"   ✅ Zip ready — {len(zip_bytes):,} bytes")

    print("   🌐 Resolving Netlify site...")
    site = get_or_create_site(company_name, token)

    print("   ⬆  Uploading...")
    deploy = deploy_zip(site["site_id"], zip_bytes, token)

    live_url   = site["url"]
    deploy_url = deploy.get("deploy_ssl_url") or deploy.get("deploy_url") or live_url
    print(f"   ✅ Live:   {live_url}")
    print(f"   🔗 Deploy: {deploy_url}")

    return live_url


def deploy_all(token: str = None):
    token = token or os.getenv("NETLIFY_TOKEN")

    companies = [
        d for d in ROOT_DIR.iterdir()
        if d.is_dir()
        and d.name not in EXCLUDE_DIRS
        and (d / "index.html").exists()
    ]

    if not companies:
        print("No company folders with index.html found in root dir.")
        return

    print(f"📋 {len(companies)} site(s) to deploy\n")
    results = {}

    for folder in companies:
        try:
            url = deploy_company(folder, token)
            results[folder.name] = {"status": "ok", "url": url}
        except Exception as e:
            print(f"   ❌ Error: {e}")
            results[folder.name] = {"status": "failed", "error": str(e)}

    print("\n── Deploy Summary ──────────────────────────")
    for name, r in results.items():
        if r["status"] == "ok":
            print(f"  ✅ {name}: {r['url']}")
        else:
            print(f"  ❌ {name}: {r['error']}")


# ─────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────

def deploy_site(folder_path: "Path | str", site_name: str) -> tuple[str, str]:
    """Importable entry point: deploy folder to Netlify using site_name as the slug.
    Returns (live_url, deploy_id)."""
    token = os.getenv("NETLIFY_TOKEN")
    if not token:
        raise ValueError("NETLIFY_TOKEN not set in .env")
    lead_path = Path(folder_path)
    print(f"\n🚀 Deploying: {site_name}")
    print("   📦 Building zip...")
    zip_bytes = build_zip(lead_path)
    print(f"   ✅ Zip ready — {len(zip_bytes):,} bytes")
    print("   🌐 Resolving Netlify site...")
    site = get_or_create_site(site_name, token)
    print("   ⬆  Uploading...")
    deploy = deploy_zip(site["site_id"], zip_bytes, token)
    live_url = site["url"]
    deploy_id = deploy.get("id", "")
    print(f"   ✅ Live: {live_url} (deploy: {deploy_id})")
    return live_url, deploy_id


if __name__ == "__main__":
    if len(sys.argv) == 1:
        deploy_all()
    elif sys.argv[1] == "--list":
        db = load_sites_db()
        if not db:
            print("No deployed sites on record.")
        else:
            for name, info in db.items():
                print(f"  • {name}: {info['url']}")
    else:
        deploy_company(sys.argv[1])
