#!/usr/bin/env python3
"""
Workforce Australia Job Scraper - Selenium & Playwright Versions
Run with: python3 workforce_scraper.py [selenium|playwright]

Installation:
    # For Selenium
    pip install selenium webdriver-manager
    
    # For Playwright
    pip install playwright
    playwright install chromium
"""

import re
import time
import random
import logging
from datetime import date, datetime, timedelta
from typing import List, Dict, Optional
from dataclasses import dataclass
import pandas as pd

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)


# ============================================================
# COMMON CONFIGURATION
# ============================================================

@dataclass
class SearchConfig:
    keywords: List[str]
    location: str
    days_back: int = 14
    max_pages: int = 3
    headless: bool = False
    job_type: str = "all"  # all, full_time, part_time, casual, contract

    @property
    def cutoff_date(self) -> date:
        return date.today() - timedelta(days=self.days_back)


def parse_workforce_date(date_str: str) -> Optional[date]:
    """Parse Workforce Australia date formats"""
    if not date_str:
        return None
    
    date_str = date_str.lower().strip()
    
    # Today / Yesterday
    if 'today' in date_str:
        return date.today()
    if 'yesterday' in date_str:
        return date.today() - timedelta(days=1)
    
    # "DD/MM/YYYY" format
    match = re.search(r'(\d{1,2})/(\d{1,2})/(\d{4})', date_str)
    if match:
        day, month, year = int(match.group(1)), int(match.group(2)), int(match.group(3))
        return date(year, month, day)
    
    # "DD MMM YYYY" format (e.g., "12 May 2025")
    match = re.search(r'(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})', date_str)
    if match:
        day, month_str, year = int(match.group(1)), match.group(2), int(match.group(3))
        month_map = {
            'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
            'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12
        }
        month = month_map.get(month_str[:3].lower(), 1)
        return date(year, month, day)
    
    return None


def is_within_cutoff(posted_date_str: str, cutoff_date: date) -> bool:
    """Check if job was posted within cutoff period"""
    job_date = parse_workforce_date(posted_date_str)
    if job_date is None:
        return True
    return job_date >= cutoff_date


# ============================================================
# VERSION 1: PLAYWRIGHT SCRAPER (Recommended)
# ============================================================

def playwright_scrape_workforce(config: SearchConfig) -> List[Dict]:
    """Scrape Workforce Australia using Playwright"""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        log.error("Playwright not installed. Run: pip install playwright && playwright install chromium")
        return []

    log.info("🎭 Starting Playwright Workforce Australia scraper...")
    all_jobs = []
    
    with sync_playwright() as p:
        # Launch browser with anti-detection
        browser = p.chromium.launch(
            headless=config.headless,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
                "--no-sandbox",
            ]
        )
        
        # Create context with Australian settings
        context = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            locale="en-AU",
            timezone_id="Australia/Sydney",
        )
        
        # Add stealth script
        context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
            Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
            window.chrome = {runtime: {}};
        """)
        
        page = context.new_page()
        
        try:
            for keyword in config.keywords:
                log.info(f"Searching: '{keyword}' in {config.location}")
                
                for page_num in range(1, config.max_pages + 1):
                    # Build Workforce Australia search URL
                    base_url = "https://www.workforceaustralia.gov.au/individuals/find-a-job"
                    params = f"?keyword={keyword.replace(' ', '+')}&location={config.location}&page={page_num}"
                    
                    if config.job_type != "all":
                        params += f"&jobType={config.job_type}"
                    
                    url = base_url + params
                    
                    log.info(f"  Page {page_num}: {url}")
                    page.goto(url, wait_until="domcontentloaded")
                    
                    # Wait for results to load
                    time.sleep(random.uniform(2, 4))
                    
                    # Check if no results found
                    if page.query_selector(".no-results-message"):
                        log.info("  No more results found")
                        break
                    
                    # Wait for job cards
                    try:
                        page.wait_for_selector(".job-card, .result-item, [data-testid='job-result']", timeout=10000)
                    except:
                        log.warning(f"  Timeout waiting for jobs on page {page_num}")
                    
                    # Scroll naturally
                    for _ in range(random.randint(1, 3)):
                        page.evaluate(f"window.scrollBy(0, {random.randint(300, 800)})")
                        time.sleep(random.uniform(0.5, 1.5))
                    
                    # Find job cards - multiple selector attempts
                    cards = []
                    selectors = [
                        ".job-card",
                        ".result-item",
                        "[data-testid='job-result']",
                        ".search-result",
                        "article",
                    ]
                    
                    for selector in selectors:
                        cards = page.query_selector_all(selector)
                        if cards:
                            log.info(f"    Found {len(cards)} cards using: {selector}")
                            break
                    
                    if not cards:
                        log.warning(f"    No job cards found on page {page_num}")
                        continue
                    
                    page_jobs = 0
                    for card in cards:
                        try:
                            # Title
                            title_elem = card.query_selector("h2 a, h3 a, .job-title a, .title a")
                            if not title_elem:
                                title_elem = card.query_selector("a[href*='/job/']")
                            if not title_elem:
                                continue
                            
                            title = title_elem.inner_text().strip()
                            job_url = title_elem.get_attribute("href")
                            if job_url and not job_url.startswith("http"):
                                job_url = f"https://www.workforceaustralia.gov.au{job_url}"
                            
                            # Company/Employer
                            company = ""
                            company_elem = card.query_selector(".employer, .company, .recruiter")
                            if company_elem:
                                company = company_elem.inner_text().strip()
                            
                            # Location
                            location = config.location
                            loc_elem = card.query_selector(".location, .suburb, .address")
                            if loc_elem:
                                location = loc_elem.inner_text().strip()
                            
                            # Posted date
                            posted_date = ""
                            date_elem = card.query_selector(".date, .posting-date, .listed-date")
                            if date_elem:
                                posted_date = date_elem.inner_text().strip()
                            
                            # Salary (if shown)
                            salary = ""
                            salary_elem = card.query_selector(".salary, .wage")
                            if salary_elem:
                                salary = salary_elem.inner_text().strip()
                            
                            # Employment type
                            emp_type = ""
                            type_elem = card.query_selector(".employment-type, .job-type, .work-type")
                            if type_elem:
                                emp_type = type_elem.inner_text().strip()
                            
                            # Description snippet
                            description = ""
                            desc_elem = card.query_selector(".description-snippet, .summary, .job-description")
                            if desc_elem:
                                description = desc_elem.inner_text().strip()
                            
                            # Date filter
                            if not is_within_cutoff(posted_date, config.cutoff_date):
                                continue
                            
                            page_jobs += 1
                            all_jobs.append({
                                "title": title,
                                "company": company,
                                "location": location,
                                "posted_date": posted_date,
                                "salary": salary,
                                "employment_type": emp_type,
                                "description": description[:500] if description else "",
                                "url": job_url,
                                "source": "Workforce Australia (Playwright)",
                                "keyword": keyword,
                            })
                        except Exception as e:
                            continue
                    
                    log.info(f"    Kept {page_jobs} jobs from page {page_num}")
                    
                    # Check for next page
                    if page_num < config.max_pages:
                        next_btn = page.query_selector("a[rel='next'], .pagination-next, button:has-text('Next')")
                        if not next_btn:
                            break
                    
                    time.sleep(random.uniform(2, 5))
                
                time.sleep(random.uniform(3, 7))
        
        finally:
            browser.close()
    
    log.info(f"Playwright finished: {len(all_jobs)} jobs found")
    return all_jobs


# ============================================================
# VERSION 2: SELENIUM SCRAPER
# ============================================================

def selenium_scrape_workforce(config: SearchConfig) -> List[Dict]:
    """Scrape Workforce Australia using Selenium"""
    try:
        from selenium import webdriver
        from selenium.webdriver.common.by import By
        from selenium.webdriver.support.ui import WebDriverWait
        from selenium.webdriver.support import expected_conditions as EC
        from selenium.webdriver.chrome.options import Options
        from selenium.webdriver.chrome.service import Service
        from webdriver_manager.chrome import ChromeDriverManager
    except ImportError:
        log.error("Selenium not installed. Run: pip install selenium webdriver-manager")
        return []

    log.info("🚀 Starting Selenium Workforce Australia scraper...")
    
    # Chrome options
    chrome_options = Options()
    if config.headless:
        chrome_options.add_argument("--headless=new")
    
    chrome_options.add_argument("--disable-blink-features=AutomationControlled")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--window-size=1920,1080")
    
    # Remove automation flag
    chrome_options.add_experimental_option("excludeSwitches", ["enable-automation"])
    chrome_options.add_experimental_option("useAutomationExtension", False)
    
    driver = webdriver.Chrome(
        service=Service(ChromeDriverManager().install()),
        options=chrome_options
    )
    
    driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
    
    all_jobs = []
    
    try:
        for keyword in config.keywords:
            log.info(f"Searching: '{keyword}' in {config.location}")
            
            for page_num in range(1, config.max_pages + 1):
                base_url = "https://www.workforceaustralia.gov.au/individuals/find-a-job"
                params = f"?keyword={keyword.replace(' ', '+')}&location={config.location}&page={page_num}"
                if config.job_type != "all":
                    params += f"&jobType={config.job_type}"
                
                url = base_url + params
                log.info(f"  Page {page_num}: {url}")
                driver.get(url)
                
                time.sleep(random.uniform(2, 4))
                
                # Wait for results
                try:
                    WebDriverWait(driver, 10).until(
                        EC.presence_of_element_located((By.CSS_SELECTOR, ".job-card, .result-item"))
                    )
                except:
                    log.warning(f"  Timeout waiting for jobs")
                    break
                
                # Find job cards
                cards = driver.find_elements(By.CSS_SELECTOR, ".job-card, .result-item, article")
                
                if not cards:
                    log.warning(f"  No job cards found")
                    break
                
                page_jobs = 0
                for card in cards:
                    try:
                        # Title
                        title_elem = card.find_element(By.CSS_SELECTOR, "h2 a, h3 a, .job-title a")
                        title = title_elem.text.strip()
                        job_url = title_elem.get_attribute("href")
                        
                        # Company
                        company = ""
                        try:
                            company_elem = card.find_element(By.CSS_SELECTOR, ".employer, .company")
                            company = company_elem.text.strip()
                        except:
                            pass
                        
                        # Location
                        location = config.location
                        try:
                            loc_elem = card.find_element(By.CSS_SELECTOR, ".location")
                            location = loc_elem.text.strip()
                        except:
                            pass
                        
                        # Date
                        posted_date = ""
                        try:
                            date_elem = card.find_element(By.CSS_SELECTOR, ".date")
                            posted_date = date_elem.text.strip()
                        except:
                            pass
                        
                        if not is_within_cutoff(posted_date, config.cutoff_date):
                            continue
                        
                        page_jobs += 1
                        all_jobs.append({
                            "title": title,
                            "company": company,
                            "location": location,
                            "posted_date": posted_date,
                            "salary": "",
                            "employment_type": "",
                            "description": "",
                            "url": job_url,
                            "source": "Workforce Australia (Selenium)",
                            "keyword": keyword,
                        })
                    except:
                        continue
                
                log.info(f"    Kept {page_jobs} jobs from page {page_num}")
                time.sleep(random.uniform(2, 5))
            
            time.sleep(random.uniform(3, 7))
    
    finally:
        driver.quit()
    
    log.info(f"Selenium finished: {len(all_jobs)} jobs found")
    return all_jobs


# ============================================================
# MAIN EXECUTION
# ============================================================

def main():
    import sys
    
    scraper_type = "playwright"
    if len(sys.argv) > 1:
        scraper_type = sys.argv[1].lower()
    
    if scraper_type not in ["selenium", "playwright"]:
        print("Usage: python3 workforce_scraper.py [selenium|playwright]")
        return
    
    config = SearchConfig(
        keywords=["data analyst", "business analyst"],
        location="NSW (ALL)",
        days_back=14,
        max_pages=3,
        headless=False,
    )
    
    log.info("=" * 60)
    log.info(f"WORKFORCE AUSTRALIA SCRAPER - {scraper_type.upper()}")
    log.info(f"Keywords: {config.keywords}")
    log.info(f"Location: {config.location}")
    log.info("=" * 60)
    
    if scraper_type == "selenium":
        jobs = selenium_scrape_workforce(config)
    else:
        jobs = playwright_scrape_workforce(config)
    
    if jobs:
        df = pd.DataFrame(jobs)
        print(f"\n✅ Found {len(df)} jobs\n")
        print(df[["title", "company", "location", "posted_date"]].to_string())
        
        filename = f"workforce_jobs_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        df.to_csv(filename, index=False)
        print(f"\n💾 Saved to {filename}")
    else:
        print("\n❌ No jobs found")
        print("\nTroubleshooting:")
        print("  1. Check if website structure changed")
        print("  2. Try with headless=False to see the browser")
        print("  3. Check if you need to accept cookies first")


if __name__ == "__main__":
    main()