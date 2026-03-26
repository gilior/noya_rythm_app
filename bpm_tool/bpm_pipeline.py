
# BPM Audio Pipeline
# ------------------
# Reads the genre JSON library in assets/songs/lib/, downloads any missing audio,
# calculates BPM, and uploads mp3s to Cloudflare R2.

# The catalog JSON files (assets/songs/lib/*.json) stay local and are bundled
# with the app — no remote catalog needed.

# R2 bucket layout:
#     audio/{genre}/{video_id}.mp3      ← streamable audio

# Re-running is safe: tracks that already have both a BPM and an audio_url are
# skipped. The local JSON files are also updated so they stay in sync.

# Setup:
#     pip install -r requirements.txt

# Cloudflare R2 setup:
#     1. Create a Cloudflare account and open R2 in the dashboard
#     2. Create a bucket (e.g. noya-audio) and enable "Public access"
#     3. Create an API token with Object Read & Write permissions
#     4. Copy .env.example → .env and fill in your keys

# run script:
# cd C:\Repos\noya_rythm_app\bpm_tool
# py -m pip install -r requirements.txt
# py bpm_pipeline.py


import json
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
# Public base URL — set after enabling public access on the bucket.
# e.g. https://pub-xxxxxxxx.r2.dev  or  https://audio.yourdomain.com
R2_PUBLIC_URL   = os.getenv("R2_PUBLIC_URL", "").rstrip("/")
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


# ── Step 1: Download ──────────────────────────────────────────────────────────

_COOKIES_FILE = Path(__file__).parent / "cookies.txt"


def download_audio(video_id: str, output_dir: str) -> str:
    """Download best audio stream and convert to mp3. Returns the file path."""
    output_template = os.path.join(output_dir, f"{video_id}.%(ext)s")
    cmd = [
        sys.executable, "-m", "yt_dlp",
        "--quiet",
        "--no-warnings",
        "--ffmpeg-location", _FFMPEG_PATH,
        "--format", "bestaudio/best",
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
    """Estimate BPM using Essentia's RhythmExtractor2013 (multifeature method).

    Far more accurate than librosa for complex music.
    Octave normalization folds the result into 55–130 BPM — the range
    relevant for this app's genres (ambient, lofi, jazz, etc.).
    """
    audio = es.MonoLoader(filename=file_path, sampleRate=44100)()
    audio = audio[:44100 * 60]          # limit to first 60 s
    bpm, _, _, _, _ = es.RhythmExtractor2013(method="multifeature")(audio)
    bpm = float(bpm)
    while bpm > 130:
        bpm /= 2
    while bpm < 55:
        bpm *= 2
    return round(bpm, 2)


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

def run_pipeline(lib_dir: Path) -> None:
    if not R2_ACCOUNT_ID or not R2_ACCESS_KEY or not R2_SECRET_KEY:
        raise EnvironmentError(
            "R2_ACCOUNT_ID, R2_ACCESS_KEY, and R2_SECRET_KEY must be set in bpm_tool/.env"
        )
    if not R2_PUBLIC_URL:
        raise EnvironmentError(
            "R2_PUBLIC_URL must be set (enable public access on your R2 bucket first)"
        )
    if not lib_dir.exists():
        raise FileNotFoundError(f"Library directory not found: {lib_dir}")

    r2 = _r2_client()
    totals = {"ok": 0, "skip": 0, "err": 0}

    for json_file in sorted(lib_dir.glob("*.json")):
        genre = json_file.stem  # filename == genre id, e.g. "lofi", "jazz"
        log.info(f"── Genre: {genre}")

        try:
            songs: list[dict] = json.loads(json_file.read_text(encoding="utf-8"))
        except Exception as exc:
            log.error(f"  Cannot read {json_file.name}: {exc}")
            continue

        modified = False

        with tempfile.TemporaryDirectory() as tmp_dir:
            for song in songs:
                if not isinstance(song, dict) or "id" not in song:
                    continue

                vid     = song["id"]
                title   = song.get("title", vid)

                existing_bpm = str(song.get("BPM", "")).strip()
                existing_url = str(song.get("audio_url", "")).strip()

                if existing_bpm and existing_bpm != "Error" and existing_url:
                    log.info(f"  [{vid}] skip — already processed")
                    totals["skip"] += 1
                    continue

                log.info(f"  [{vid}] {title[:60]}")
                try:
                    log.info(f"  [{vid}]   downloading audio...")
                    file_path = download_audio(vid, tmp_dir)

                    bpm = calc_bpm(file_path)
                    log.info(f"  [{vid}]   BPM: {bpm}")

                    log.info(f"  [{vid}]   uploading to R2...")
                    audio_url = upload_audio(r2, genre, vid, file_path)

                    log.info(f"  [{vid}] ✅  {bpm} BPM — {audio_url}")

                    song["BPM"]       = str(bpm)
                    song["audio_url"] = audio_url
                    modified = True
                    totals["ok"] += 1

                except Exception as exc:
                    log.error(f"  [{vid}] ❌  {exc}")
                    song["BPM"] = "Error"
                    modified = True
                    totals["err"] += 1

        if modified:
            # Update local JSON
            json_file.write_text(
                json.dumps(songs, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
            log.info(f"  → saved {json_file.name}")

    print(f"\n{'─' * 50}")
    print(f"✅  Success : {totals['ok']}")
    print(f"⏭   Skipped : {totals['skip']}")
    print(f"❌  Failed  : {totals['err']}")


if __name__ == "__main__":
    lib_dir = Path(__file__).parent.parent / "assets" / "songs" / "lib_smaple"
    run_pipeline(lib_dir)
