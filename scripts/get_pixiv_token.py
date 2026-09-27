#!/usr/bin/env python3
"""
Pixiv OAuth PKCE Token Extractor
Digunakan untuk mendapatkan PIXIV_REFRESH_TOKEN tanpa perlu login via browser headless / gppt.
Zero-dependency: hanya menggunakan Python standard library (urllib, json, secrets, hashlib).
"""

import sys
import os
import re
import json
import base64
import hashlib
import secrets
import urllib.request
import urllib.parse
import urllib.error

CLIENT_ID = "MOBrBDS8blbauoSck0ZfDbtuzpyT"
CLIENT_SECRET = "lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj"
LOGIN_URL = "https://app-api.pixiv.net/web/v1/login"
AUTH_TOKEN_URL = "https://oauth.secure.pixiv.net/auth/token"
CALLBACK_URI = "https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback"

HEADERS = {
    "User-Agent": "PixivIOSApp/7.13.3 (iOS 14.6; iPhone13,2)",
    "App-OS-Version": "14.6",
    "App-OS": "ios",
}


def generate_pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(32)
    digest = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
    return verifier, digest


def build_login_url(challenge: str) -> str:
    params = {
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "client": "pixiv-android",
    }
    return f"{LOGIN_URL}?{urllib.parse.urlencode(params)}"


def extract_code(raw_input: str) -> str:
    cleaned = raw_input.strip()
    if not cleaned:
        raise ValueError("Input kosong.")

    # Jika user menempelkan full URL atau query string
    if "?" in cleaned or "=" in cleaned:
        query = cleaned.partition("?")[2] if "?" in cleaned else cleaned
        parsed = urllib.parse.parse_qs(urllib.parse.urlsplit(f"?{query}").query)
        codes = parsed.get("code", [])
        if codes and codes[0].strip():
            return codes[0].strip()

    # Jika user menempelkan raw code
    if " " in cleaned:
        raise ValueError(f"Kode otorisasi tidak valid: '{cleaned}'")
    return cleaned


def exchange_token(code: str, verifier: str) -> dict:
    payload = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "code": code,
        "code_verifier": verifier,
        "grant_type": "authorization_code",
        "include_policy": "true",
        "redirect_uri": CALLBACK_URI,
    }
    data = urllib.parse.urlencode(payload).encode("utf-8")
    req = urllib.request.Request(AUTH_TOKEN_URL, data=data, headers=HEADERS)

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_msg = e.read().decode("utf-8", errors="replace")
        try:
            err_json = json.loads(err_msg)
            desc = err_json.get("error_description") or err_json.get("errors", {}).get("system", {}).get("message") or err_msg
        except Exception:
            desc = err_msg
        raise RuntimeError(f"Pixiv OAuth gagal ({e.code}): {desc}")
    except Exception as e:
        raise RuntimeError(f"Gagal menghubungi server Pixiv: {e}")


def refresh_token(old_refresh_token: str) -> dict:
    payload = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type": "refresh_token",
        "include_policy": "true",
        "refresh_token": old_refresh_token,
    }
    data = urllib.parse.urlencode(payload).encode("utf-8")
    req = urllib.request.Request(AUTH_TOKEN_URL, data=data, headers=HEADERS)

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        raise RuntimeError(f"Gagal refresh token: {e}")


def update_env_file(env_path: str, token: str) -> bool:
    target_key = "PIXIV_REFRESH_TOKEN"
    line_to_add = f"{target_key}={token}\n"

    try:
        if os.path.exists(env_path):
            with open(env_path, "r", encoding="utf-8") as f:
                content = f.read()

            if re.search(rf"^{target_key}=.*", content, flags=re.MULTILINE):
                new_content = re.sub(rf"^{target_key}=.*", f"{target_key}={token}", content, flags=re.MULTILINE)
            else:
                new_content = content.rstrip("\n") + "\n" + line_to_add

            with open(env_path, "w", encoding="utf-8") as f:
                f.write(new_content)
        else:
            with open(env_path, "w", encoding="utf-8") as f:
                f.write(line_to_add)
        return True
    except Exception as e:
        print(f"[-] Gagal menulis ke {env_path}: {e}")
        return False


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--refresh":
        if len(sys.argv) < 3:
            print("Usage: python3 get_pixiv_token.py --refresh <TOKEN>")
            sys.exit(1)
        res = refresh_token(sys.argv[2])
        print("Refresh berhasil!")
        print("Access Token :", res.get("access_token"))
        print("Refresh Token:", res.get("refresh_token"))
        sys.exit(0)

    print("==================================================")
    print("      PIXIV OAUTH PKCE TOKEN EXTRACTOR           ")
    print("==================================================")

    verifier, challenge = generate_pkce()
    login_url = build_login_url(challenge)

    print("\n[LANGKAH 1] Buka link berikut di browser (Chrome HP / PC):")
    print("-" * 50)
    print(login_url)
    print("-" * 50)

    print("\n[LANGKAH 2]")
    print("- Login dengan akun Pixiv kamu.")
    print("- Setelah login, browser akan dialihkan ke halaman kosong yang")
    print("  URL-nya berawalan 'pixiv://...' atau 'https://app-api.pixiv.net/...'.")
    print("- Copy (salin) SELURUH URL di address bar browser tersebut.")
    print("- Note: Kode otorisasi kedaluwarsa dalam ~30 detik setelah login!")

    try:
        user_input = input("\nTempelkan URL atau kode otorisasi di sini: ").strip()
    except (KeyboardInterrupt, EOFError):
        print("\nDibatalkan.")
        sys.exit(1)

    try:
        code = extract_code(user_input)
    except ValueError as e:
        print(f"\n[!] Error: {e}")
        sys.exit(1)

    print("\nMenghubungi Pixiv OAuth server untuk menukar token...")
    try:
        tokens = exchange_token(code, verifier)
    except RuntimeError as e:
        print(f"\n[X] {e}")
        sys.exit(1)

    ref_token = tokens.get("refresh_token")
    user_info = tokens.get("user", {})
    user_name = user_info.get("name", "Unknown")
    user_account = user_info.get("account", "Unknown")

    print("\n" + "=" * 50)
    print("✅ BERHASIL LOGIN PIXIV!")
    print(f"Akun        : {user_name} (@{user_account})")
    print(f"Refresh Token: {ref_token}")
    print("=" * 50)

    # Deteksi lokasi .env Allybot
    potential_envs = [
        "/root/projects/Allybot/.env",
        os.path.abspath(".env")
    ]

    for p in potential_envs:
        if os.path.exists(os.path.dirname(p)):
            try:
                ans = input(f"\nSimpan token ini ke {p}? [y/N]: ").strip().lower()
                if ans == "y":
                    if update_env_file(p, ref_token):
                        print(f"✔ Token berhasil disimpan ke {p}!")
                break
            except (KeyboardInterrupt, EOFError):
                break

    print("\nSelesai! Kamu bisa gunakan token di atas untuk env var PIXIV_REFRESH_TOKEN.\n")


if __name__ == "__main__":
    main()
