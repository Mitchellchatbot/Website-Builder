from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)

    context = browser.new_context(
        record_video_dir="videos/",
        record_video_size={"width": 1920, "height": 1080},
        viewport={"width": 1920, "height": 1080}
    )

    page = context.new_page()
    page.goto("https://valleyspringrecovery.com/")

    # Wait a bit for the initial load
    page.wait_for_timeout(2000)

    # Scroll down the page gradually to record the whole website smoothly
    last_position = page.evaluate("window.scrollY")
    
    while True:
        # Scroll down by a smaller amount for much smoother scrolling
        page.evaluate("window.scrollBy(0, 10)")
        # Wait a very short duration to capture the smooth scroll
        page.wait_for_timeout(40)
        
        current_position = page.evaluate("window.scrollY")
        # If the scroll position hasn't changed, we've reached the bottom
        if current_position == last_position:
            break
        last_position = current_position

    # Wait a bit at the end of the page before finishing
    page.wait_for_timeout(2000)

    context.close()
    browser.close()