import requests

def harvest() -> None:
    for i in range(34675588, 34675590):
        link = f"https://allright.com/og/{i}_null_0_0.jpg"
        print(link)
        response = requests.get(link)
        print("Status:", response.status_code)
        if response.status_code == 200:
            print(f"Valid: {i}")

harvest()