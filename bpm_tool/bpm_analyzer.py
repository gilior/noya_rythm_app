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
    import numpy as np
    return round(float(np.asarray(tempo).flat[0]), 2)

def process_and_update_library(lib_dir: Path, output_csv: str) -> None:
    """Scanning JSON files, calculating missing BPMs, and updating the files."""
    if not lib_dir.exists():
        print(f"Warning: Library directory {lib_dir} does not exist.")
        return

    with open(output_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["video_id", "bpm", "source_file"])

        for json_file in lib_dir.glob("*.json"):
            print(f"\n--- Scanning {json_file.name} ---")
            try:
                with open(json_file, "r", encoding="utf-8") as jf:
                    songs = json.load(jf)
            except json.JSONDecodeError:
                print(f"Error reading or parsing {json_file}")
                continue

            modified = False

            for song in songs:
                if not isinstance(song, dict) or "id" not in song:
                    continue
                
                vid = song["id"]
                existing_bpm = str(song.get("BPM", "")).strip()
                
                # Skip if we already have a calculated BPM
                if existing_bpm and existing_bpm != "Error":
                    continue
                
                print(f"Processing {vid} ...", end=" ", flush=True)
                bpm_value: str

                with tempfile.TemporaryDirectory() as tmp_dir:
                    audio_path = os.path.join(tmp_dir, f"{vid}.wav")
                    try:
                        download_audio(vid, audio_path)
                        bpm_value = str(estimate_bpm(audio_path))
                        print(f"BPM: {bpm_value}")
                        
                        # Update the song object
                        song["BPM"] = bpm_value
                        modified = True
                    except Exception as exc:
                        bpm_value = "Error"
                        print(f"Error: {exc}")

                writer.writerow([vid, bpm_value, json_file.name])
                f.flush()

            # If any BPMs were updated, write the changes back to the JSON file
            if modified:
                with open(json_file, "w", encoding="utf-8") as jf:
                    json.dump(songs, jf, indent=2, ensure_ascii=False)
                print(f"-> Saved updates to {json_file.name}")


if __name__ == "__main__":
    script_dir = Path(__file__).parent
    lib_dir = script_dir.parent / "assets" / "songs" / "lib"
    
    process_and_update_library(lib_dir, OUTPUT_CSV)
    print(f"\nDone. Log saved to {OUTPUT_CSV}")