import datetime
import json
import os
import re
import sys

import feedparser
import requests
from bs4 import BeautifulSoup

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError


# ============================================================
# CONFIGURATION
# ============================================================

RSS_FEED_URL = "https://example.com/feed.xml"

# Google service account JSON file
CREDENTIALS_FILE = "credentials.json"

# Google Calendar ID
CALENDAR_ID = "your-calendar-id@group.calendar.google.com"

# File containing IDs/links of entries that have already been processed
PROCESSED_FILE = "processed_entries.json"

# Google Calendar API permissions
GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/calendar"
]

# Words that must occur on the page
REQUIRED_TITLE_WORD = "meluilmoitus"
REQUIRED_SUBTITLE_WORD = "taka-töölö"

# Time zone used by Google Calendar
TIME_ZONE = "Europe/Helsinki"


# ============================================================
# PROCESSED ENTRY HANDLING
# ============================================================

def load_processed_entries():
    """Load the set of already processed RSS entries."""

    if not os.path.exists(PROCESSED_FILE):
        print(f"{PROCESSED_FILE} does not exist. Starting with an empty set.")
        return set()

    try:
        with open(PROCESSED_FILE, "r", encoding="utf-8") as file:
            data = json.load(file)

        if not isinstance(data, list):
            print(
                f"Warning: {PROCESSED_FILE} does not contain a list. "
                "Starting with an empty set."
            )
            return set()

        return set(data)

    except json.JSONDecodeError as error:
        print(f"Error reading {PROCESSED_FILE}: {error}")
        return set()

    except OSError as error:
        print(f"Error opening {PROCESSED_FILE}: {error}")
        return set()


def save_processed_entries(processed_entries):
    """Save processed entry IDs to JSON."""

    try:
        with open(PROCESSED_FILE, "w", encoding="utf-8") as file:
            json.dump(
                sorted(processed_entries),
                file,
                indent=4,
                ensure_ascii=False
            )

        print(f"Saved {len(processed_entries)} processed entries.")

    except OSError as error:
        print(f"Error saving processed entries: {error}")


# ============================================================
# GOOGLE CALENDAR
# ============================================================

def get_google_calendar_service():
    """Create an authenticated Google Calendar API service."""

    try:
        print("Authenticating with Google Calendar...")

        credentials = (
            service_account.Credentials
            .from_service_account_file(
                CREDENTIALS_FILE,
                scopes=GOOGLE_SCOPES
            )
        )

        service = build(
            "calendar",
            "v3",
            credentials=credentials
        )

        print("Google Calendar authentication successful.")

        return service

    except FileNotFoundError:
        print(
            f"ERROR: Google credentials file not found: "
            f"{CREDENTIALS_FILE}"
        )
        return None

    except Exception as error:
        print(f"ERROR authenticating with Google Calendar: {error}")
        return None


def create_calendar_event(
    service,
    title,
    description,
    start_time,
    end_time
):
    """Create a Google Calendar event without reminders."""

    event = {
        "summary": title,
        "description": description,

        "start": {
            "dateTime": start_time,
            "timeZone": TIME_ZONE
        },

        "end": {
            "dateTime": end_time,
            "timeZone": TIME_ZONE
        },

        # Disable all reminders
        "reminders": {
            "useDefault": False,
            "overrides": []
        }
    }

    try:
        created_event = (
            service.events()
            .insert(
                calendarId=CALENDAR_ID,
                body=event
            )
            .execute()
        )

        print(
            f"Calendar event created: "
            f"{created_event.get('htmlLink')}"
        )

        return created_event

    except HttpError as error:
        print(f"Google Calendar API error: {error}")
        return None

    except Exception as error:
        print(f"Error creating calendar event: {error}")
        return None


# ============================================================
# TIME PARSING
# ============================================================

def parse_event_time(text):
    """
    Extract a date and time range from text such as:

    - Torstaina 10.8.2023 kello 9.00–22.00 (testaus)

    Returns:
        (start_datetime, end_datetime)
    """

    # Find date such as 10.8.2023
    date_match = re.search(
        r"\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b",
        text
    )

    if not date_match:
        print(f"Could not find date in: {text}")
        return None, None

    # Find time range such as 9.00–22.00
    time_match = re.search(
        r"\b(\d{1,2})\.(\d{2})\s*[–-]\s*"
        r"(\d{1,2})\.(\d{2})\b",
        text
    )

    if not time_match:
        print(f"Could not find time range in: {text}")
        return None, None

    day = int(date_match.group(1))
    month = int(date_match.group(2))
    year = int(date_match.group(3))

    start_hour = int(time_match.group(1))
    start_minute = int(time_match.group(2))

    end_hour = int(time_match.group(3))
    end_minute = int(time_match.group(4))

    try:
        start_datetime = datetime.datetime(
            year,
            month,
            day,
            start_hour,
            start_minute
        )

        # Handle "24.00".
        #
        # Python cannot create datetime(..., hour=24).
        # In that case, the event ends at midnight the next day.
        if end_hour == 24 and end_minute == 0:
            end_datetime = (
                datetime.datetime(
                    year,
                    month,
                    day
                )
                + datetime.timedelta(days=1)
            )

        elif end_hour == 24:
            # 24.30 isn't normally valid, but this gives us
            # a safe failure rather than silently producing
            # an incorrect event.
            raise ValueError(
                "24.xx is not supported unless minutes are 00"
            )

        else:
            end_datetime = datetime.datetime(
                year,
                month,
                day,
                end_hour,
                end_minute
            )

        return start_datetime, end_datetime

    except ValueError as error:
        print(
            f"Invalid date/time in text: {text}\n"
            f"Error: {error}"
        )
        return None, None


# ============================================================
# WEBPAGE SCRAPING
# ============================================================

def get_event_details(url):
    """
    Scrape a decision page and return calendar events.

    Returns a list of dictionaries:
        [
            {
                "start": ...,
                "end": ...,
                "title": ...,
                "description": ...
            }
        ]
    """

    print()
    print("=" * 70)
    print(f"Processing webpage:\n{url}")
    print("=" * 70)

    events = []

    # --------------------------------------------------------
    # Download webpage
    # --------------------------------------------------------

    try:
        response = requests.get(
            url,
            timeout=30,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 "
                    "(compatible; RSSCalendarBot/1.0)"
                )
            }
        )

        response.raise_for_status()

    except requests.exceptions.RequestException as error:
        print(f"ERROR downloading webpage: {error}")
        return events

    # --------------------------------------------------------
    # Parse HTML
    # --------------------------------------------------------

    soup = BeautifulSoup(
        response.content,
        "html.parser"
    )

    # --------------------------------------------------------
    # Find title elements
    # --------------------------------------------------------

    issue_title_element = soup.find(
        class_="issue__title"
    )

    issue_content_title_element = soup.find(
        class_="issue-content__title"
    )

    if issue_title_element is None:
        print("Could not find issue title.")
        return events

    if issue_content_title_element is None:
        print("Could not find issue content title.")
        return events

    issue_title = issue_title_element.get_text(
        " ",
        strip=True
    )

    issue_content_title = issue_content_title_element.get_text(
        " ",
        strip=True
    )

    print(f"Issue title: {issue_title}")
    print(f"Content title: {issue_content_title}")

    # --------------------------------------------------------
    # Check required words
    # --------------------------------------------------------

    if REQUIRED_TITLE_WORD.lower() not in issue_title.lower():
        print(
            f"Skipping: '{REQUIRED_TITLE_WORD}' "
            "was not found in issue title."
        )
        return events

    if REQUIRED_SUBTITLE_WORD.lower() not in issue_content_title.lower():
        print(
            f"Skipping: '{REQUIRED_SUBTITLE_WORD}' "
            "was not found in content title."
        )
        return events

    print("Page matches the required filters.")

    # --------------------------------------------------------
    # Find "Päätös"
    # --------------------------------------------------------

    heading = None

    # First try the expected h3
    for tag in soup.find_all(["h2", "h3", "h4"]):
        heading_text = tag.get_text(
            " ",
            strip=True
        )

        if heading_text == "Päätös":
            heading = tag
            break

    if heading is None:
        print("Could not find 'Päätös' heading.")
        return events

    print("Found 'Päätös' heading.")

    # --------------------------------------------------------
    # Find the first <li> after "Päätös"
    # --------------------------------------------------------

    first_list_item = heading.find_next("li")

    if first_list_item is None:
        print("Could not find a list item under 'Päätös'.")
        return events

    print("Found decision list item.")

    # --------------------------------------------------------
    # Extract text fragments
    #
    # Using .strings means <br> elements naturally separate
    # the text into individual strings.
    # --------------------------------------------------------

    texts = [
        text.strip()
        for text in first_list_item.strings
        if text.strip()
    ]

    if not texts:
        print("No text found inside decision list item.")
        return events

    print("Extracted text:")

    for text in texts:
        print(f"  {text}")

    # --------------------------------------------------------
    # Parse dates and times
    #
    # The first text is usually the introductory sentence,
    # so we attempt parsing on every text rather than assuming
    # a specific list position.
    # --------------------------------------------------------

    for text in texts:

        # Ignore text that doesn't contain a date.
        if not re.search(
            r"\b\d{1,2}\.\d{1,2}\.\d{4}\b",
            text
        ):
            continue

        print()
        print(f"Parsing event: {text}")

        start_datetime, end_datetime = parse_event_time(
            text
        )

        if start_datetime is None or end_datetime is None:
            print("Skipping invalid event.")
            continue

        event = {
            "start": start_datetime.isoformat(),
            "end": end_datetime.isoformat(),
            "title": issue_content_title,
            "description": url
        }

        events.append(event)

        print(
            f"Start: {event['start']}\n"
            f"End:   {event['end']}"
        )

    print(f"Found {len(events)} calendar event(s).")

    return events


# ============================================================
# RSS FEED
# ============================================================

def get_rss_entries():
    """Download and parse the RSS feed."""

    print()
    print("=" * 70)
    print("Checking RSS feed")
    print("=" * 70)

    try:
        feed = feedparser.parse(RSS_FEED_URL)

    except Exception as error:
        print(f"ERROR parsing RSS feed: {error}")
        return []

    if feed.bozo:
        print(
            "Warning: RSS feed may contain malformed XML."
        )

        if hasattr(feed, "bozo_exception"):
            print(
                f"Feed parser error: "
                f"{feed.bozo_exception}"
            )

    print(f"RSS feed contains {len(feed.entries)} entries.")

    return feed.entries


# ============================================================
# MAIN
# ============================================================

def main():

    print()
    print("=" * 70)
    print("RSS → Google Calendar")
    print("=" * 70)

    # --------------------------------------------------------
    # Load already processed entries
    # --------------------------------------------------------

    processed_entries = load_processed_entries()

    print(
        f"Previously processed entries: "
        f"{len(processed_entries)}"
    )

    # --------------------------------------------------------
    # Get RSS feed
    # --------------------------------------------------------

    entries = get_rss_entries()

    if not entries:
        print("No RSS entries found.")
        return

    # --------------------------------------------------------
    # Authenticate with Google
    #
    # Only authenticate if we actually have new entries.
    # --------------------------------------------------------

    new_entries = []

    for entry in entries:

        # RSS feeds normally have an id, but some feeds don't.
        # Fall back to the link.
        entry_id = (
            entry.get("id")
            or entry.get("guid")
            or entry.get("link")
        )

        if not entry_id:
            print("Skipping RSS entry without an ID or link.")
            continue

        if entry_id in processed_entries:
            continue

        new_entries.append(
            (entry_id, entry)
        )

    print(f"New RSS entries: {len(new_entries)}")

    if not new_entries:
        print("Nothing new to process.")
        return

    service = get_google_calendar_service()

    if service is None:
        print(
            "Google Calendar authentication failed. "
            "Nothing was processed."
        )
        return

    # --------------------------------------------------------
    # Process each new entry
    # --------------------------------------------------------

    for entry_id, entry in new_entries:

        url = entry.get("link")

        if not url:
            print(
                f"Skipping entry without URL: "
                f"{entry_id}"
            )
            continue

        print()
        print("#" * 70)
        print(f"RSS entry: {entry.get('title', '(no title)')}")
        print(f"URL: {url}")
        print("#" * 70)

        try:
            events = get_event_details(url)

            if not events:
                print("No calendar events found.")

            else:
                # Create each calendar event
                for event in events:

                    create_calendar_event(
                        service=service,
                        title=event["title"],
                        description=event["description"],
                        start_time=event["start"],
                        end_time=event["end"]
                    )

            # ------------------------------------------------
            # Mark the RSS entry as processed.
            #
            # We do this even when there are no matching
            # events, so the same irrelevant RSS entry isn't
            # scraped every day.
            # ------------------------------------------------

            processed_entries.add(entry_id)

            save_processed_entries(
                processed_entries
            )

        except Exception as error:
            # Don't let one bad RSS entry stop the entire job.
            print(
                f"ERROR processing RSS entry "
                f"{entry_id}: {error}"
            )

            # Do NOT mark it as processed.
            # This means it will be retried on the next run.

    print()
    print("=" * 70)
    print("Finished.")
    print("=" * 70)


# ============================================================
# SCRIPT ENTRY POINT
# ============================================================

if __name__ == "__main__":
    try:
        main()

    except KeyboardInterrupt:
        print("\nStopped by user.")
        sys.exit(1)

    except Exception as error:
        print(f"Unexpected fatal error: {error}")
        sys.exit(1)