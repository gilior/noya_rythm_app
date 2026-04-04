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
    return round(float(bpm), 2)


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


# ── Step 4: Upload output ────────────────────────────────────────────────────

def upload_output(r2, output_file: Path) -> str:
    """Upload the combined songs.json to R2 at output/songs.json. Returns the public URL."""
    key = "output/songs.json"
    r2.put_object(
        Bucket=R2_BUCKET,
        Key=key,
        Body=output_file.read_bytes(),
        ContentType="application/json",
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

    # Output goes to lib_output/ sibling of the input folder
    output_dir  = lib_dir.parent / "lib_output"
    output_file = output_dir / "songs.json"
    output_dir.mkdir(exist_ok=True)

    # Load existing output for skip-detection (keyed by video id)
    existing: dict[str, dict] = {}
    if output_file.exists():
        try:
            for entry in json.loads(output_file.read_text(encoding="utf-8")):
                if isinstance(entry, dict) and "id" in entry:
                    existing[entry["id"]] = entry
        except Exception as exc:
            log.warning(f"Could not load existing output ({output_file}): {exc}")

    r2 = _r2_client()
    totals   = {"ok": 0, "skip": 0, "err": 0}
    all_songs: list[dict] = []

    for json_file in sorted(lib_dir.glob("*.json")):
        genre = json_file.stem  # filename == genre id, e.g. "lofi", "jazz"
        log.info(f"── Genre: {genre}")

        try:
            songs: list[dict] = json.loads(json_file.read_text(encoding="utf-8"))
        except Exception as exc:
            log.error(f"  Cannot read {json_file.name}: {exc}")
            continue

        with tempfile.TemporaryDirectory() as tmp_dir:
            for song in songs:
                if not isinstance(song, dict) or "id" not in song:
                    continue

                vid   = song["id"]
                title = song.get("title", vid)

                # Build the output entry from the origin fields + genre tag.
                # BPM and audio_url are stripped from the origin spread so they
                # only ever come from the pipeline result or the cached output.
                # They are intentionally NOT written back to the origin files —
                # they live exclusively in lib_output/songs.json.
                out_entry = {
                    k: v for k, v in song.items()
                    if k not in ("BPM", "audio_url")
                }
                out_entry["genre"] = genre

                # Check the existing output file for already-processed tracks
                cached = existing.get(vid)
                if cached:
                    cached_bpm = str(cached.get("BPM", "")).strip()
                    cached_url = str(cached.get("audio_url", "")).strip()
                    if cached_bpm and cached_bpm != "Error" and cached_url:
                        log.info(f"  [{vid}] skip — already processed")
                        all_songs.append(cached)
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

                    out_entry["BPM"]       = str(bpm)
                    out_entry["audio_url"] = audio_url
                    totals["ok"] += 1

                except Exception as exc:
                    log.error(f"  [{vid}] ❌  {exc}")
                    out_entry["BPM"] = "Error"
                    totals["err"] += 1

                all_songs.append(out_entry)

    # Write single combined output — all genres, all songs, one file
    output_file.write_text(
        json.dumps(all_songs, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    log.info(f"  → saved {output_file}")

    # Step 4: Upload output
    log.info("  → uploading output/songs.json to R2...")
    output_url = upload_output(r2, output_file)
    log.info(f"  → uploaded {output_url}")

    print(f"\n{'─' * 50}")
    print(f"✅  Success : {totals['ok']}")
    print(f"⏭   Skipped : {totals['skip']}")
    print(f"❌  Failed  : {totals['err']}")


if __name__ == "__main__":
    lib_dir = Path(__file__).parent.parent / "assets" / "songs" / "lib_smaple"
    run_pipeline(lib_dir)
