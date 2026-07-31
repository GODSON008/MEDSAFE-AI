"""
MedSafe AI — Auth Module
Handles JWT creation/verification and Google OAuth ID token validation.
"""
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from fastapi import Depends, HTTPException, Request, status
try:
    from jose import JWTError, jwt
except ImportError:
    import jwt
    from jwt import PyJWTError as JWTError

# ── Configuration ──────────────────────────────────────────────────────────────
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", secrets.token_hex(32))
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_HOURS = 24

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_TOKEN_INFO_URL = "https://oauth2.googleapis.com/tokeninfo"

# ── JWT Helpers ────────────────────────────────────────────────────────────────

def create_access_token(email: str, username: str, provider: str = "local", patient_id: Optional[str] = None, is_doctor: bool = False) -> str:
    """Create a signed JWT access token."""
    expire = datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRE_HOURS)
    payload = {
        "sub": email,
        "name": username,
        "provider": provider,
        "patient_id": patient_id,
        "is_doctor": is_doctor,
        "exp": expire,
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict:
    """Decode and validate a JWT. Raises JWTError on failure."""
    return jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])


# ── Google Token Verification ──────────────────────────────────────────────────

async def verify_google_id_token(id_token: str) -> dict:
    """
    Verify a Google ID token via Google's tokeninfo endpoint.
    Returns decoded claims or raises HTTPException.
    """
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google Sign-In is not configured. Set GOOGLE_CLIENT_ID in your .env file.",
        )

    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            resp = await client.get(
                GOOGLE_TOKEN_INFO_URL,
                params={"id_token": id_token},
            )
        except httpx.RequestError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"Could not reach Google verification endpoint: {exc}",
            )

    if resp.status_code != 200:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired Google ID token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    claims = resp.json()

    # Validate audience matches our Client ID
    aud = claims.get("aud", "")
    if aud != GOOGLE_CLIENT_ID:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Google token audience mismatch — wrong Client ID.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Belt-and-suspenders expiry check
    exp = int(claims.get("exp", 0))
    if exp < int(time.time()):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Google ID token has expired.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return claims


# ── FastAPI Dependency ─────────────────────────────────────────────────────────

class AuthenticatedUser:
    """Represents a verified user extracted from a JWT."""
    def __init__(self, email: str, username: str, provider: str, patient_id: Optional[str] = None, is_doctor: bool = False):
        self.email = email
        self.username = username
        self.provider = provider
        self.patient_id = patient_id
        self.is_doctor = is_doctor


GUEST_USER = AuthenticatedUser(
    email="guest@medsafe.ai",
    username="Guest User",
    provider="guest",
    patient_id="MED-0000",
    is_doctor=False
)


def get_current_user(request: Request) -> AuthenticatedUser:
    """
    FastAPI dependency: extracts + verifies JWT from Authorization header.
    Falls back to GUEST_USER if no token present.
    Raises 401 if token is present but invalid/expired.
    """
    auth_header = request.headers.get("Authorization", "")

    if not auth_header:
        return GUEST_USER

    if not auth_header.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header must use Bearer scheme.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = auth_header[len("Bearer "):]

    try:
        payload = decode_access_token(token)
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid or expired session token. Please log in again.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    email = payload.get("sub")
    if not email:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Malformed token: missing subject claim.",
        )

    return AuthenticatedUser(
        email=email,
        username=payload.get("name", "User"),
        provider=payload.get("provider", "local"),
        patient_id=payload.get("patient_id"),
        is_doctor=payload.get("is_doctor", False)
    )
