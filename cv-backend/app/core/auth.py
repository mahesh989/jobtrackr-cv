from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional


@dataclass
class ClerkTokenPayload:
    clerk_user_id: str
    email: str
    full_name: Optional[str] = None
    avatar_url: Optional[str] = None


def parse_clerk_payload(payload: Dict[str, Any]) -> ClerkTokenPayload:
    """
    Extract user identity from a decoded Clerk JWT payload.

    Clerk tokens can carry email in two ways:
      - Flat field:  payload["email"]
      - Array field: payload["email_addresses"][0]["email_address"]
    """
    clerk_user_id: str = payload["sub"]

    # Email
    email = ""
    if "email" in payload and payload["email"]:
        email = payload["email"]
    elif "email_addresses" in payload:
        addresses: List[Dict[str, Any]] = payload.get("email_addresses", [])
        if addresses:
            email = addresses[0].get("email_address", "")

    # Full name
    first = payload.get("first_name") or payload.get("given_name") or ""
    last = payload.get("last_name") or payload.get("family_name") or ""
    full_name: Optional[str] = f"{first} {last}".strip() or None

    # Avatar
    avatar_url: Optional[str] = payload.get("image_url") or payload.get("picture")

    return ClerkTokenPayload(
        clerk_user_id=clerk_user_id,
        email=email,
        full_name=full_name,
        avatar_url=avatar_url,
    )
