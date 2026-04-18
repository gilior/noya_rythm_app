import os
import requests

OUTPUT_DIR = r"C:\Users\liorgishry\OneDrive - Microsoft\Pictures\all_right"

def harvest() -> None:
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    for i in range(0, 34669509):
        padded = str(34669509-i).zfill(8)
        link = f"https://allright.com/og/{padded}_null_0_0.jpg"
        response = requests.get(link)
        if response.status_code == 200:
            print(f"Valid: {link}")
            filepath = os.path.join(OUTPUT_DIR, f"{padded}.jpg")
            with open(filepath, "wb") as f:
                f.write(response.content)

harvest()