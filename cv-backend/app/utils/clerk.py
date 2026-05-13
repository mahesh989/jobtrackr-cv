from __future__ import annotations

import logging
from typing import Any, Dict, Optional

import httpx
from cachetools import TTLCache, cached
from fastapi import HTTPException, status
from jose import JWTError, jwt
from jose.utils import base64url_decode
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicNumbers
from cryptography.hazmat.backends import default_backend
import base64
import struct

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

# Cache JWKS for 5 minutes — avoids hitting Clerk on every request
_jwks_cache: TTLCache = TTLCache(maxsize=1, ttl=300)

# Cache fetched user profiles for 5 minutes — avoids hitting Clerk API every request
_user_cache: TTLCache = TTLCache(maxsize=1024, ttl=300)


def _int_from_base64(value: str) -> int:
    """Decode a base64url-encoded integer (used for RSA key components)."""
    decoded = base64url_decode(value.encode("utf-8"))
    return int.from_bytes(decoded, "big")


def get_jwks() -> Dict[str, Any]:
    """Fetch Clerk's JWKS, cached for 5 minutes."""
    cache_key = "jwks"
    if cache_key in _jwks_cache:
        return _jwks_cache[cache_key]  # type: ignore[return-value]

    try:
        response = httpx.get(settings.CLERK_JWKS_URL, timeout=10)
        response.raise_for_status()
        jwks = response.json()
        _jwks_cache[cache_key] = jwks
        logger.debug("Fetched and cached JWKS from Clerk")
        return jwks
    except Exception as exc:
        logger.error("Failed to fetch JWKS from Clerk: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Auth service temporarily unavailable",
        ) from exc


def _build_rsa_public_key(jwk: Dict[str, Any]):
    """Build a cryptography RSA public key object from a JWK dict."""
    n = _int_from_base64(jwk["n"])
    e = _int_from_base64(jwk["e"])
    public_numbers = RSAPublicNumbers(e=e, n=n)
    return public_numbers.public_key(default_backend())


def verify_clerk_token(token: str) -> Dict[str, Any]:
    """
    Verify a Clerk-issued JWT.

    1. Decode the header (unverified) to get `kid`.
    2. Find the matching key in Clerk's JWKS.
    3. Build the RSA public key and verify the JWT signature + claims.
    4. Return the decoded payload.

    Raises HTTPException 401 on any failure.
    """
    try:
        # Decode header without verification to get kid
        unverified_header = jwt.get_unverified_header(token)
        kid = unverified_header.get("kid")
        if not kid:
            raise ValueError("No kid in token header")

        # Find matching JWK
        jwks = get_jwks()
        matching_key = None
        for key in jwks.get("keys", []):
            if key.get("kid") == kid:
                matching_key = key
                break

        if matching_key is None:
            # JWKS may be stale — clear cache and retry once
            _jwks_cache.clear()
            jwks = get_jwks()
            for key in jwks.get("keys", []):
                if key.get("kid") == kid:
                    matching_key = key
                    break

        if matching_key is None:
            raise ValueError(f"No matching JWK found for kid: {kid}")

        # Build public key
        public_key = _build_rsa_public_key(matching_key)

        # Verify and decode
        payload = jwt.decode(
            token,
            public_key,
            algorithms=["RS256"],
            options={"verify_aud": False},  # Clerk tokens don't always set aud
        )

        return payload

    except JWTError as exc:
        logger.warning("JWT verification failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("Token verification error: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc


def fetch_clerk_user(clerk_user_id: str) -> Optional[Dict[str, Any]]:
    """
    Fetch a Clerk user's profile from the REST API.

    Used as a fallback when the session JWT doesn't carry email
    (Clerk's default JWTs only contain `sub` unless a JWT template is configured).

    Returns a dict with keys:  id, email, full_name, avatar_url
    Returns None on failure.

    Cached for 5 minutes per user.
    """
    if not clerk_user_id:
        return None

    if clerk_user_id in _user_cache:
        return _user_cache[clerk_user_id]

    if not settings.CLERK_SECRET_KEY:
        logger.warning("CLERK_SECRET_KEY not set — cannot fetch user profile")
        return None

    try:
        response = httpx.get(
            f"https://api.clerk.com/v1/users/{clerk_user_id}",
            headers={"Authorization": f"Bearer {settings.CLERK_SECRET_KEY}"},
            timeout=10,
        )
        response.raise_for_status()
        data = response.json()
    except Exception as exc:
        logger.warning(
            "Failed to fetch Clerk user %s: %s", clerk_user_id, exc
        )
        return None

    # Resolve primary email
    email = ""
    primary_email_id = data.get("primary_email_address_id")
    for ea in data.get("email_addresses") or []:
        if ea.get("id") == primary_email_id:
            email = ea.get("email_address", "")
            break
    if not email:
        addrs = data.get("email_addresses") or []
        if addrs:
            email = addrs[0].get("email_address", "")

    first = data.get("first_name") or ""
    last = data.get("last_name") or ""
    full_name = f"{first} {last}".strip() or None

    profile = {
        "id": data.get("id", clerk_user_id),
        "email": email,
        "full_name": full_name,
        "avatar_url": data.get("image_url") or data.get("profile_image_url"),
    }
    _user_cache[clerk_user_id] = profile
    return profile
