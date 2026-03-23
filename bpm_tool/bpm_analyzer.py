import csv
import os
import subprocess
import tempfile

import imageio_ffmpeg
import librosa

# Path to the ffmpeg binary bundled with imageio-ffmpeg (no system install needed)
_FFMPEG_PATH = imageio_ffmpeg.get_ffmpeg_exe()

# ── Add your YouTube video IDs here (up to 500) ──────────────────────────────
VIDEO_IDS: list[str] = [
    "Km7B76mRIVw",
    # ... add more IDs
]

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
    # librosa >= 0.10 returns tempo as a numpy array; flatten to scalar safely
    import numpy as np
    return round(float(np.asarray(tempo).flat[0]), 2)


def process_batch(video_ids: list[str], output_csv: str) -> None:
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
    process_batch(VIDEO_IDS, OUTPUT_CSV)
    print(f"\nDone. Results saved to {OUTPUT_CSV}")
