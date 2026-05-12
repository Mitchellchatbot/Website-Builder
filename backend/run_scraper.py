"""
Runs scrape_site in an isolated subprocess to avoid Playwright + asyncio conflicts.
Called by services/pipeline.py via subprocess.run — never imported directly.
"""
import sys
from pathlib import Path


def main():
    if len(sys.argv) < 3:
        print(
            "Usage: run_scraper.py <website_url> <output_folder> [company_name]",
            file=sys.stderr,
        )
        sys.exit(1)

    website_url = sys.argv[1]
    output_folder = sys.argv[2]
    company_name = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None

    # Ensure backend/ is on sys.path for pipeline imports
    backend_dir = Path(__file__).parent
    if str(backend_dir) not in sys.path:
        sys.path.insert(0, str(backend_dir))

    from dotenv import load_dotenv
    load_dotenv()

    from pipeline.scraper import scrape_site
    scrape_site(website_url, Path(output_folder), company_name=company_name)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"\n[run_scraper] FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
