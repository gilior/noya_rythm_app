import csv
import os
import subprocess
import tempfile
import json
from pathlib import Path

import imageio_ffmpeg
import librosa

# Path to the ffmpeg binary bundled with imageio-ffmpeg (no system install needed)
_FFMPEG_PATH = imageio_ffmpeg.get_ffmpeg_exe()

OUTPUT_CSV = "results.csv"

def get_video_ids_from_lib(lib_dir: Path) -> list[str]:
    """Dynamically reads video IDs from all JSON files in the library directory."""
    video_ids = []
    if not lib_dir.exists():
        print(f"Warning: Library directory {lib_dir} does not exist.")
        return video_ids

    for json_file in lib_dir.glob("*.json"):
        with open(json_file, "r", encoding="utf-8") as f:
            try:
                songs = json.load(f)
                for song in songs:
                    if isinstance(song, dict) and "id" in song:
                        video_ids.append(song["id"])
            except json.JSONDecodeError:
                print(f"Error reading or parsing {json_file}")
    
    return video_ids

def download_audio(video_id: str, output_path: str) -> None:
    """Download audio for a YouTube ID to a WAV file at output_path."""
    url = f"https://www.youtube.com/watch?v={video_id}"
    subprocess.run(
        [
            "yt-dlp",
            "--quiet",
            "--no-warnings",
            "--ffmpeg-location", _FFMPEG_PATH,
            "-x",                    # extract audio only
            "--audio-format", "wav",
            "--audio-quality", "0",
            "-o", output_path,
            url,
        ],
        check=True,
        timeout=120,
    )

def estimate_bpm(file_path: str) -> float:
    """Load up to 60 s of audio and return the estimated BPM."""
    y, sr = librosa.load(file_path, mono=True, duration=60)
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    # librosa >= 0.10 returns tempo as a numpy array; flatten to scalar safely
    import numpy as np
    return round(float(np.asarray(tempo).flat[0]), 2)

def process_batch(video_ids: list[str], output_csv: str) -> None:
    if not video_ids:
        print("No video IDs found to process.")
        return

    with open(output_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["video_id", "bpm"])

        for i, vid in enumerate(video_ids, 1):
            print(f"[{i}/{len(video_ids)}] Processing {vid} ...", end=" ", flush=True)
            bpm_value: str

            with tempfile.TemporaryDirectory() as tmp_dir:
                audio_path = os.path.join(tmp_dir, f"{vid}.wav")
                try:
                    download_audio(vid, audio_path)
                    bpm_value = str(estimate_bpm(audio_path))
                    print(f"BPM: {bpm_value}")
                except Exception as exc:
                    bpm_value = "Error"
                    print(f"Error: {exc}")

            writer.writerow([vid, bpm_value])
            f.flush()  # persist each row immediately in case of early exit


if __name__ == "__main__":
    # Resolve the path to the lib folder dynamically based on this script's location
    # This assumes bpm_tool/ is parallel to assets/
    script_dir = Path(__file__).parent
    lib_dir = script_dir.parent / "assets" / "songs" / "lib"
    
    video_ids_to_process = get_video_ids_from_lib(lib_dir)
    print(f"Found {len(video_ids_to_process)} songs in the library.")
    
    process_batch(video_ids_to_process, OUTPUT_CSV)
    print(f"\nDone. Results saved to {OUTPUT_CSV}")