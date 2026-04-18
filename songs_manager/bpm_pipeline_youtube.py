import logging
import os
import subprocess
import sys
import tempfile
import json
import random
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import boto3
import essentia.standard as es
import imageio_ffmpeg
import requests
from botocore.config import Config
from dotenv import load_dotenv
from supabase import create_client

load_dotenv(Path(__file__).parent / ".env")

_LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper().strip()

logging.basicConfig(
    level=getattr(logging, _LOG_LEVEL, logging.INFO),
    format="%(asctime)s  %(levelname)s  %(message)s",
)
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

_FFMPEG_PATH    = imageio_ffmpeg.get_ffmpeg_exe()
R2_ACCOUNT_ID   = os.getenv("R2_ACCOUNT_ID", "")
R2_ACCESS_KEY   = os.getenv("R2_ACCESS_KEY", "")
R2_SECRET_KEY   = os.getenv("R2_SECRET_KEY", "")
R2_BUCKET       = os.getenv("R2_BUCKET", "noya-audio")
R2_PUBLIC_URL   = os.getenv("R2_PUBLIC_URL", "").rstrip("/")
SUPABASE_URL    = os.getenv("SUPABASE_URL", "")
SUPABASE_KEY    = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
YOUTUBE_API_KEY = os.getenv("YOUTUBE_API_KEY", "")
AUDIO_FORMAT    = "mp3"

_HARVEST_CONFIG_FILE = Path(__file__).parent / "youtube_harvest_config.json"


def _r2_client():
    return boto3.client(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY,
        aws_secret_access_key=R2_SECRET_KEY,
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )


def _supabase_client():
    return create_client(SUPABASE_URL, SUPABASE_KEY)


# ── Step 0: YouTube Harvest ───────────────────────────────────────────────────

def _load_harvest_config() -> Dict[str, Any]:
    if not _HARVEST_CONFIG_FILE.exists():
        raise FileNotFoundError(
            f"Missing harvest config: {_HARVEST_CONFIG_FILE}. Create it or restore it from git."
        )
    with open(_HARVEST_CONFIG_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def _is_official_channel(channel_title: str, rules: Dict[str, Any]) -> bool:
    suffix = str(rules.get("topic_suffix", "- Topic"))
    allow_vevo = bool(rules.get("allow_vevo", True))
    if channel_title.endswith(suffix):
        return True
    if allow_vevo and "VEVO" in channel_title.upper():
        return True
    return False


def _youtube_search_page(
    api_key: str,
    query: str,
    topic_id: str,
    published_after: str,
    published_before: str,
    extra_params: Dict[str, Any],
    page_token: str = "",
) -> Tuple[List[Dict[str, Any]], str]:
    url = "https://www.googleapis.com/youtube/v3/search"
    params = {
        **(extra_params or {}),
        "q": query,
        "topicId": topic_id,
        "publishedAfter": published_after,
        "publishedBefore": published_before,
        "key": api_key,
    }
    if page_token:
        params["pageToken"] = page_token

    resp = requests.get(url, params=params, timeout=30)
    if resp.status_code != 200:
        # YouTube often returns JSON error payloads; surface them.
        raise RuntimeError(f"YouTube API error {resp.status_code}: {resp.text[:500]}")

    payload = resp.json() or {}
    items = payload.get("items") or []
    next_token = payload.get("nextPageToken") or ""
    return items, next_token


def harvest_candidates(
    config: Dict[str, Any],
    skip_ids: Set[str],
) -> List[Dict[str, str]]:
    max_new_per_genre = int(config.get("max_new_per_genre", 500))
    pages_per_query = int(config.get("pages_per_query", 4))
    year_min = int(config.get("year_range_min", 2008))
    year_max = int(config.get("year_range_max", 2024))
    window = int(config.get("year_window_size", 2))
    query_template = str(
        config.get("query_template", '{term} "Provided to YouTube" -live -concert -performance')
    )

    yt_params = dict(config.get("youtube_search_params") or {})
    rules = dict(config.get("official_channel_rules") or {})
    genres = list(config.get("genres") or [])

    candidates: List[Dict[str, str]] = []

    for genre in genres:
        genre_id = str(genre.get("id") or "unknown")
        topic_id = str(genre.get("topicId") or "")
        search_terms = list(genre.get("search_terms") or [])

        if not topic_id or not search_terms:
            log.warning(f"Skipping genre '{genre_id}' due to missing topicId/search_terms")
            continue

        log.info(f"Harvesting genre: {genre_id}")

        # Track IDs within this genre run; don't exceed the per-genre cap.
        genre_seen: Set[str] = set()
        genre_new = 0

        for term in search_terms:
            if genre_new >= max_new_per_genre:
                break

            # Random 2-year window between year_min..year_max for variety
            start_year = random.randint(year_min, year_max)
            end_year = min(start_year + window, year_max)
            published_after = f"{start_year}-01-01T00:00:00Z"
            published_before = f"{end_year}-12-31T23:59:59Z"

            query = query_template.format(term=str(term))
            log.debug(f"  Query: {term} ({start_year}-{end_year})")

            next_page = ""
            pages = 0
            while pages < pages_per_query and genre_new < max_new_per_genre:
                items, next_page = _youtube_search_page(
                    api_key=YOUTUBE_API_KEY,
                    query=query,
                    topic_id=topic_id,
                    published_after=published_after,
                    published_before=published_before,
                    extra_params=yt_params,
                    page_token=next_page,
                )

                for item in items:
                    snippet = item.get("snippet") or {}
                    chan = str(snippet.get("channelTitle") or "")
                    if not _is_official_channel(chan, rules):
                        continue

                    vid = ((item.get("id") or {}) or {}).get("videoId")
                    if not vid:
                        continue
                    vid = str(vid)

                    # Skip if already complete in DB or already seen in this genre.
                    if vid in skip_ids or vid in genre_seen:
                        continue

                    genre_seen.add(vid)

                    candidates.append(
                        {
                            "id": vid,
                            "title": str(snippet.get("title") or vid),
                            "channel": chan,
                            "genre": genre_id,
                        }
                    )
                    genre_new += 1
                    if genre_new >= max_new_per_genre:
                        break

                pages += 1
                if not next_page:
                    break

        log.info(f"Harvested {genre_new} candidates for genre: {genre_id}")

    return candidates


# ── Step 1: Download ──────────────────────────────────────────────────────────

_COOKIES_FILE = Path(__file__).parent / "cookies.txt"


def download_audio(video_id: str, output_dir: str) -> str:
    """Download best audio stream and convert to mp3. Returns the file path."""
    output_template = os.path.join(output_dir, f"{video_id}.%(ext)s")
    cmd = [
        sys.executable, "-m", "yt_dlp",
        "--quiet",
        "--no-warnings",
        "--js-runtimes", "node",
        "--remote-components", "ejs:github",
        "--ffmpeg-location", _FFMPEG_PATH,
        "--format", "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best",
        "-x",
        "--audio-format", AUDIO_FORMAT,
        "--audio-quality", "0",
        "-o", output_template,
    ]
    if _COOKIES_FILE.exists():
        cmd += ["--cookies", str(_COOKIES_FILE)]
    cmd.append(f"https://www.youtube.com/watch?v={video_id}")
    subprocess.run(cmd, check=True, timeout=120)
    return os.path.join(output_dir, f"{video_id}.{AUDIO_FORMAT}")


# ── Step 2: BPM ───────────────────────────────────────────────────────────────

def calc_bpm(file_path: str) -> float:
    """Estimate BPM using Essentia's RhythmExtractor2013."""
    audio = es.MonoLoader(filename=file_path, sampleRate=44100)()
    audio = audio[:44100 * 60]          # limit to first 60 s
    bpm, _, _, _, _ = es.RhythmExtractor2013(method="multifeature")(audio)
    return int(round(float(bpm)))


# ── Step 3: Upload audio ──────────────────────────────────────────────────────

def upload_audio(r2, genre: str, video_id: str, file_path: str) -> str:
    """Upload mp3 to R2 at audio/{genre}/{video_id}.mp3. Returns the public URL."""
    key = f"audio/{genre}/{video_id}.{AUDIO_FORMAT}"
    with open(file_path, "rb") as f:
        r2.put_object(
            Bucket=R2_BUCKET,
            Key=key,
            Body=f,
            ContentType="audio/mpeg",
        )
    return f"{R2_PUBLIC_URL}/{key}"


# ── Pipeline ──────────────────────────────────────────────────────────────────

def _is_blank(value) -> bool:
    """Return True if value is None or an empty/whitespace string."""
    return value is None or str(value).strip() == ""


def run_pipeline() -> None:
    if not R2_ACCOUNT_ID or not R2_ACCESS_KEY or not R2_SECRET_KEY:
        raise EnvironmentError(
            "R2_ACCOUNT_ID, R2_ACCESS_KEY, and R2_SECRET_KEY must be set in songs_manager/.env"
        )
    if not R2_PUBLIC_URL:
        raise EnvironmentError(
            "R2_PUBLIC_URL must be set (enable public access on your R2 bucket first)"
        )
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise EnvironmentError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in songs_manager/.env"
        )

    if not YOUTUBE_API_KEY:
        raise EnvironmentError(
            "YOUTUBE_API_KEY must be set in songs_manager/.env (required for YouTube harvesting)"
        )

    sb = _supabase_client()
    r2 = _r2_client()

    # Prefetch existing rows so we can skip complete songs and repair incomplete ones.
    PAGE = 1000
    offset = 0
    existing_by_id: Dict[str, Dict[str, Any]] = {}
    complete_ids: Set[str] = set()
    while True:
        batch = (
            sb.table("songs")
            .select("id,BPM,audio_url")
            .range(offset, offset + PAGE - 1)
            .execute()
        ).data or []
        for row in batch:
            if not row.get("id"):
                continue
            vid = str(row["id"])
            existing_by_id[vid] = {
                "BPM": row.get("BPM"),
                "audio_url": row.get("audio_url"),
            }
            if not _is_blank(row.get("BPM")) and not _is_blank(row.get("audio_url")):
                complete_ids.add(vid)
        if len(batch) < PAGE:
            break
        offset += PAGE
    log.info(
        f"Loaded {len(existing_by_id)} existing songs from Supabase "
        f"({len(complete_ids)} complete, {len(existing_by_id) - len(complete_ids)} incomplete)"
    )

    config = _load_harvest_config()
    candidates = harvest_candidates(config, complete_ids)
    log.info(f"Total new candidates to process: {len(candidates)}")

    totals = {"ok": 0, "err": 0, "skipped_existing": 0}

    with tempfile.TemporaryDirectory() as tmp_dir:
        for cand in candidates:
            vid = cand["id"]
            title = cand.get("title") or vid
            channel = cand.get("channel") or ""
            genre = cand.get("genre") or "unknown"

            if vid in complete_ids:
                totals["skipped_existing"] += 1
                continue

            existed = vid in existing_by_id
            if existed:
                prev = existing_by_id.get(vid) or {}
                missing_bpm = _is_blank(prev.get("BPM"))
                missing_audio = _is_blank(prev.get("audio_url"))
                log.info(
                    f"[{vid}] {title[:60]}  (repair: "
                    f"{'BPM ' if missing_bpm else ''}"
                    f"{'audio_url' if missing_audio else ''}".rstrip()
                    + ")"
                )
            else:
                missing_bpm = True
                missing_audio = True
                log.info(f"[{vid}] {title[:60]}  (new)")

            try:
                # New or incomplete IDs: do only the work that's still missing.
                payload: Dict[str, Any] = {
                    "id": vid,
                    "title": title,
                    "channel": channel,
                    "genre": genre,
                }

                if missing_bpm or missing_audio:
                    log.info(f"  [{vid}]   downloading audio...")
                    file_path = download_audio(vid, tmp_dir)

                    if missing_bpm:
                        bpm = calc_bpm(file_path)
                        payload["BPM"] = bpm
                        log.debug(f"  [{vid}]   BPM: {bpm}")

                    if missing_audio:
                        log.info(f"  [{vid}]   uploading to R2...")
                        audio_url = upload_audio(r2, genre, vid, file_path)
                        payload["audio_url"] = audio_url

                # Write to Supabase only after successful processing.
                sb.table("songs").upsert(payload).execute()
                existing_by_id[vid] = {
                    "BPM": payload.get("BPM", existing_by_id.get(vid, {}).get("BPM")),
                    "audio_url": payload.get(
                        "audio_url", existing_by_id.get(vid, {}).get("audio_url")
                    ),
                }
                if (
                    not _is_blank(existing_by_id[vid].get("BPM"))
                    and not _is_blank(existing_by_id[vid].get("audio_url"))
                ):
                    complete_ids.add(vid)
                totals["ok"] += 1
                if "BPM" in payload and "audio_url" in payload:
                    log.info(f"  [{vid}] ✅  {payload['BPM']} BPM — {payload['audio_url']}")
                elif "BPM" in payload:
                    log.info(f"  [{vid}] ✅  {payload['BPM']} BPM")
                elif "audio_url" in payload:
                    log.info(f"  [{vid}] ✅  {payload['audio_url']}")
                else:
                    log.info(f"  [{vid}] ✅")

            except Exception as exc:
                log.error(f"  [{vid}] ❌  {exc}")
                totals["err"] += 1

    print(f"\n{'─' * 50}")
    print(f"✅  Success : {totals['ok']}")
    print(f"⏭️  Skipped : {totals['skipped_existing']}")
    print(f"❌  Failed  : {totals['err']}")


if __name__ == "__main__":
    run_pipeline()
