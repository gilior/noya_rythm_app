import logging
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import boto3
import essentia.standard as es
import imageio_ffmpeg
from botocore.config import Config
from dotenv import load_dotenv
from supabase import create_client

load_dotenv(Path(__file__).parent / ".env")

logging.basicConfig(
    level=logging.INFO,
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
AUDIO_FORMAT    = "mp3"


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

    sb = _supabase_client()
    r2 = _r2_client()

    # Fetch all rows that are missing BPM or audio_url (paginated, Supabase caps at 1000/request)
    PAGE = 1000
    offset = 0
    rows = []
    while True:
        batch = (
            sb.table("songs")
            .select("id, title, channel, genre, BPM, audio_url")
            .or_("BPM.is.null,audio_url.is.null")
            .range(offset, offset + PAGE - 1)
            .execute()
        ).data or []
        rows.extend(batch)
        if len(batch) < PAGE:
            break
        offset += PAGE
    log.info(f"Found {len(rows)} rows to process (missing BPM or audio_url)")

    totals = {"ok": 0, "err": 0}

    with tempfile.TemporaryDirectory() as tmp_dir:
        for row in rows:
            vid   = row["id"]
            title = row.get("title") or vid
            genre = row.get("genre") or "unknown"

            missing_url = _is_blank(row.get("audio_url"))
            missing_bpm = _is_blank(row.get("BPM"))

            log.info(f"[{vid}] {title[:60]}  (missing: {'audio_url ' if missing_url else ''}{'BPM' if missing_bpm else ''})")

            update: dict = {}
            try:
                if missing_url:
                    # No audio in R2 yet — download, calc BPM, upload
                    log.info(f"  [{vid}]   downloading audio...")
                    file_path = download_audio(vid, tmp_dir)

                    bpm = calc_bpm(file_path)
                    log.info(f"  [{vid}]   BPM: {bpm}")

                    log.info(f"  [{vid}]   uploading to R2...")
                    audio_url = upload_audio(r2, genre, vid, file_path)

                    update["BPM"]       = bpm
                    update["audio_url"] = audio_url
                    log.info(f"  [{vid}] ✅  {bpm} BPM — {audio_url}")

                elif missing_bpm:
                    # Audio already in R2 but BPM not calculated — download from YouTube, calc only
                    log.info(f"  [{vid}]   downloading audio for BPM calculation...")
                    file_path = download_audio(vid, tmp_dir)

                    bpm = calc_bpm(file_path)
                    log.info(f"  [{vid}]   BPM: {bpm}")

                    update["BPM"] = bpm
                    log.info(f"  [{vid}] ✅  {bpm} BPM")

                if update:
                    sb.table("songs").update(update).eq("id", vid).execute()
                    totals["ok"] += 1

            except Exception as exc:
                log.error(f"  [{vid}] ❌  {exc}")
                totals["err"] += 1

    print(f"\n{'─' * 50}")
    print(f"✅  Success : {totals['ok']}")
    print(f"❌  Failed  : {totals['err']}")


if __name__ == "__main__":
    run_pipeline()
