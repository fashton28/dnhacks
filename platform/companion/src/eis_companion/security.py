"""
============================================================================
Drone Safety Platform -- COMPANION command signing + the hash-chained audit
----------------------------------------------------------------------------
Two trust primitives the companion owns, kept together because they answer the
same question from opposite ends: *may I act on this?* and *can anyone prove
what I did?*

  1. ``CommandVerifier`` -- HMAC-SHA256 over a canonical serialisation of a
     command envelope. A privileged command (``enterUnattended``,
     ``exitUnattended``, ``setGimbal``) is refused unless the signature
     verifies, the nonce has not been seen, and the timestamp is inside the
     freshness window. Unsigned, replayed and stale are three different
     refusal reasons because they are three different attacks.

  2. ``AuditChain`` -- append-only JSONL where every entry carries the hash of
     the entry before it. A gap or a mutation is detectable by anyone with the
     file; the monitor refuses dispatch against a mission record whose hash
     does not match, rather than flying an unverifiable record
     (docs/THREAT_MODEL.md A7).

KEY CUSTODY IS NOT THIS SYSTEM'S PROBLEM (THREAT_MODEL, out of scope). The key
comes from an environment variable named by config -- per vehicle, so a second
airframe has its own -- and a missing key means privileged commands are
refused, never that verification is skipped.

Signing input is the canonical JSON of the envelope with the ``sig`` field
removed, sorted keys, no whitespace, UTF-8. The ground station signs exactly
the bytes it sends. Verification is constant-time (``hmac.compare_digest``).

This module does I/O (env, file append), so it lives OUTSIDE ``control/``.
Pure stdlib: hmac, hashlib, json, os, time, pathlib.
============================================================================
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import time
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Tuple

log = logging.getLogger("eis.security")

#: Commands that ALWAYS require a valid signature, whatever the config says.
#: These are the privileged transitions from docs/THREAT_MODEL.md: entering
#: unattended mode, leaving it, and re-pointing the sensor.
PRIVILEGED_COMMANDS: Tuple[str, ...] = (
    "enterUnattended", "exitUnattended", "setGimbal",
)

#: Commands exempt from ``require_all``, because every one of them moves the
#: vehicle TOWARD safety. Refusing an emergency stop for want of a signature
#: is a far worse failure than accepting an unsigned one: the attack it would
#: prevent is a denial of service, and the accident it would cause is a crash.
#: None of these is privileged, so this never weakens the privileged set.
SAFE_DIRECTION_COMMANDS: Tuple[str, ...] = (
    "emergencyStop", "disarm", "land", "rtl",
    "disengageManual", "disengageTracking", "abortPlan",
)

#: Default freshness window. Wider than any plausible link latency, far
#: narrower than a useful replay window.
DEFAULT_MAX_AGE_MS = 30_000

#: How many nonces to remember. Bounded so a flood cannot exhaust memory; the
#: freshness window is the real replay bound and the cache is the belt.
DEFAULT_NONCE_CACHE = 4096

_SIG_FIELD = "sig"
_NONCE_FIELD = "nonce"


def _canonical_bytes(payload: Mapping[str, Any]) -> bytes:
    """Canonical JSON of a command envelope, minus the signature field."""
    body = {k: v for k, v in dict(payload).items() if k != _SIG_FIELD}
    return json.dumps(
        body, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
        default=str,
    ).encode("utf-8")


def sign_payload(payload: Mapping[str, Any], key: bytes) -> str:
    """Return the hex HMAC-SHA256 a signer would attach as ``sig``.

    Exported so tests and the ground station's signer agree byte-for-byte on
    what is signed; the companion itself only ever verifies.
    """
    return hmac.new(key, _canonical_bytes(payload), hashlib.sha256).hexdigest()


@dataclass(frozen=True)
class VerifyResult:
    """Outcome of one signature check."""
    ok: bool
    reason: str = ""
    #: Which failure mode: "" | "unsigned" | "invalid" | "replay" | "stale" | "no_key"
    failure: str = ""

    @property
    def refused(self) -> bool:
        return not self.ok


class CommandVerifier:
    """Verifies signed command envelopes: authenticity, freshness, uniqueness.

    ``require_all`` makes EVERY command need a signature. It defaults off so a
    ground station that does not yet sign can still fly the demo, but the
    privileged set above is enforced regardless -- that part is not a policy
    knob. Config may turn ``require_all`` on; nothing can turn the privileged
    set off.
    """

    def __init__(
        self,
        key: Optional[bytes] = None,
        *,
        max_age_ms: int = DEFAULT_MAX_AGE_MS,
        require_all: bool = False,
        nonce_cache: int = DEFAULT_NONCE_CACHE,
        clock_ms=None,
    ) -> None:
        self._key = key if key else b""
        self._max_age_ms = max(1, int(max_age_ms))
        self._require_all = bool(require_all)
        self._nonce_cache = max(16, int(nonce_cache))
        self._seen: "OrderedDict[str, int]" = OrderedDict()
        self._clock_ms = clock_ms or (lambda: int(time.time() * 1000))

    # ---- construction ----------------------------------------------------
    @classmethod
    def from_env(
        cls,
        env_var: str,
        *,
        max_age_ms: int = DEFAULT_MAX_AGE_MS,
        require_all: bool = False,
        clock_ms=None,
    ) -> "CommandVerifier":
        """Build from the named environment variable (per vehicle, ADR D26)."""
        raw = os.environ.get(str(env_var) or "", "")
        key = raw.strip().encode("utf-8") if raw and raw.strip() else b""
        if not key:
            log.warning(
                "no session key in %s: privileged commands will be refused", env_var
            )
        return cls(
            key, max_age_ms=max_age_ms, require_all=require_all, clock_ms=clock_ms
        )

    @property
    def has_key(self) -> bool:
        return bool(self._key)

    @property
    def require_all(self) -> bool:
        return self._require_all

    def requires_signature(self, command: str) -> bool:
        """Does this command name need a signature to be accepted?"""
        name = str(command)
        if name in PRIVILEGED_COMMANDS:
            return True
        if name in SAFE_DIRECTION_COMMANDS:
            return False
        return self._require_all

    # ---- verification ----------------------------------------------------
    def verify_frame(self, payload: Mapping[str, Any]) -> VerifyResult:
        """Verify ANY inbound wire frame, not just a ``command`` envelope.

        The control socket carries ``manualInput``, ``planCommand``,
        ``planHeartbeat``, ``rfEvent`` and ``fleet`` frames too. Every one of
        them moves the aircraft or feeds a watchdog, and none of them used to
        pass through the signing layer at all -- so an unauthenticated peer on
        the same network could fly the vehicle and hold the ground-link
        deadman open (FM-40).

        A ``command`` frame keeps its existing rules exactly (privileged set
        always signed, safe-direction set never required). Every other frame
        type needs a signature only when ``require_all`` is on, which the
        config turns on automatically whenever the socket is not loopback.
        """
        data = dict(payload)
        mtype = str(data.get("type", ""))
        if mtype == "command":
            return self.verify(data)
        signature = str(data.get(_SIG_FIELD, "") or "")
        if not signature:
            if self._require_all:
                return VerifyResult(
                    False,
                    f"{mtype or 'frame'} requires a signed operator envelope",
                    "unsigned",
                )
            return VerifyResult(True, "unsigned frame accepted (signing not required)")
        return self._verify_signature(data, mtype or "frame")

    def verify(self, payload: Mapping[str, Any]) -> VerifyResult:
        """Verify one command envelope. Never raises."""
        command = str(dict(payload).get("command", ""))
        signature = str(dict(payload).get(_SIG_FIELD, "") or "")

        if not signature:
            if self.requires_signature(command):
                return VerifyResult(
                    False, f"{command or 'command'} requires a signed operator command",
                    "unsigned",
                )
            return VerifyResult(True, "unsigned command accepted (not privileged)")
        return self._verify_signature(payload, command or "command")

    def _verify_signature(self, payload: Mapping[str, Any], label: str) -> VerifyResult:
        """Authenticity + freshness + uniqueness for a signed envelope."""
        signature = str(dict(payload).get(_SIG_FIELD, "") or "")
        if not self._key:
            return VerifyResult(
                False, "no session key configured; signed commands cannot be verified",
                "no_key",
            )

        # Freshness first: a stale envelope is refused before it can consume a
        # nonce slot, so replaying old traffic cannot evict live nonces.
        ts = dict(payload).get("ts")
        try:
            ts_ms = int(ts)
        except (TypeError, ValueError):
            return VerifyResult(False, "signed command needs an integer ts", "stale")
        now = int(self._clock_ms())
        if abs(now - ts_ms) > self._max_age_ms:
            return VerifyResult(
                False,
                f"signed command is stale ({abs(now - ts_ms)} ms old, "
                f"window {self._max_age_ms} ms)",
                "stale",
            )

        expected = sign_payload(payload, self._key)
        if not hmac.compare_digest(expected, signature):
            return VerifyResult(False, "command signature does not verify", "invalid")

        nonce = str(dict(payload).get(_NONCE_FIELD, "") or "")
        if not nonce:
            return VerifyResult(False, "signed command needs a nonce", "replay")
        if nonce in self._seen:
            return VerifyResult(False, f"nonce {nonce!r} already used", "replay")
        self._remember(nonce, now)
        return VerifyResult(True, "signature verified")

    def _remember(self, nonce: str, now_ms: int) -> None:
        self._seen[nonce] = now_ms
        cutoff = now_ms - self._max_age_ms * 2
        while self._seen and (
            len(self._seen) > self._nonce_cache or next(iter(self._seen.values())) < cutoff
        ):
            self._seen.popitem(last=False)


# --------------------------------------------------------------------------
# Hash-chained, append-only audit
# --------------------------------------------------------------------------
GENESIS_HASH = "0" * 64


#: Fields excluded from a record's own hash: a record's identity is its
#: CONTENT, not its position in a chain (``prev``/``hash``), who signed the
#: envelope (``sig``), or the hash it declares about itself (``recordHash``) --
#: which must be excluded or no record could ever verify against itself.
_HASH_EXCLUDED = frozenset({_SIG_FIELD, "hash", "prev", "recordHash"})


def record_hash(payload: Mapping[str, Any]) -> str:
    """SHA-256 over the canonical JSON of a record (mission records included)."""
    body = {
        k: v for k, v in dict(payload).items() if k not in _HASH_EXCLUDED
    }
    blob = json.dumps(
        body, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str
    ).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def chain_hash(prev: str, payload: Mapping[str, Any]) -> str:
    """The chained hash of an entry: SHA-256 of ``prev`` + the record hash."""
    return hashlib.sha256(
        f"{prev or GENESIS_HASH}{record_hash(payload)}".encode("utf-8")
    ).hexdigest()


class AuditChain:
    """Append-only, hash-chained JSONL audit log.

    Every entry carries ``prev`` (the previous entry's ``hash``) and ``hash``.
    Appending is the only mutation this class offers -- there is deliberately
    no update and no delete. A write failure is logged and the in-memory chain
    still advances, so an unwritable disk degrades into "no durable record",
    never into "a chain that silently forks".
    """

    def __init__(self, path: Optional[str] = None, *, tail: int = 1000) -> None:
        self._path = Path(path) if path else None
        self._tail = max(1, int(tail))
        self._head = GENESIS_HASH
        self._entries: list = []
        self._load()

    @property
    def path(self) -> Optional[Path]:
        return self._path

    @property
    def head(self) -> str:
        """Hash of the most recent entry (``GENESIS_HASH`` when empty)."""
        return self._head

    @property
    def entries(self) -> Tuple[dict, ...]:
        return tuple(self._entries)

    def _load(self) -> None:
        if self._path is None or not self._path.exists():
            return
        try:
            lines = self._path.read_text(encoding="utf-8").splitlines()
        except Exception:
            log.exception("could not read the audit chain at %s", self._path)
            return
        for line in lines[-self._tail:]:
            try:
                item = json.loads(line)
            except (ValueError, TypeError):
                continue
            if isinstance(item, dict):
                self._entries.append(item)
        for item in self._entries:
            head = item.get("hash")
            if isinstance(head, str) and head:
                self._head = head

    def append(self, entry: Mapping[str, Any]) -> dict:
        """Chain and persist one entry; returns the stored (chained) record."""
        record = dict(entry)
        record["prev"] = self._head
        record["hash"] = chain_hash(self._head, record)
        self._head = record["hash"]
        self._entries.append(record)
        self._entries = self._entries[-self._tail:]
        if self._path is not None:
            try:
                self._path.parent.mkdir(parents=True, exist_ok=True)
                with self._path.open("a", encoding="utf-8") as handle:
                    handle.write(
                        json.dumps(record, separators=(",", ":"), default=str) + "\n"
                    )
            except Exception:
                log.exception("could not persist the audit entry")
        return record

    def verify(self, entries: Optional[Iterable[Mapping[str, Any]]] = None) -> bool:
        """Walk a chain and report whether every link holds."""
        items = list(entries if entries is not None else self._entries)
        prev = GENESIS_HASH
        for item in items:
            if str(item.get("prev", "")) != prev:
                return False
            if str(item.get("hash", "")) != chain_hash(prev, item):
                return False
            prev = str(item.get("hash", ""))
        return True


@dataclass(frozen=True)
class RecordCheck:
    """Outcome of verifying a mission record's hash before dispatch."""
    ok: bool
    reason: str = ""
    expected: str = ""
    supplied: str = ""


def verify_mission_record(
    record: Optional[Mapping[str, Any]], *, required: bool = False
) -> RecordCheck:
    """Check a mission record's self-declared hash against its content.

    A record that declares ``recordHash`` (or ``hash``) must match, or dispatch
    is refused: the monitor never runs against a record it cannot verify
    (FAILURE_MODES, "Monitor input stale -- mission record hash mismatch").
    A record with no declared hash is accepted only when ``required`` is False,
    which is what keeps an existing unsigned ``executePlan`` path working while
    the ground half learns to stamp one.
    """
    if record is None:
        return RecordCheck(
            not required, "" if not required else "a verified mission record is required"
        )
    if not isinstance(record, Mapping):
        return RecordCheck(False, "mission record must be an object")
    supplied = str(record.get("recordHash", record.get("hash", "")) or "")
    expected = record_hash(record)
    if not supplied:
        if required:
            return RecordCheck(
                False, "mission record carries no hash", expected=expected
            )
        return RecordCheck(True, "mission record unhashed", expected=expected)
    if not hmac.compare_digest(supplied, expected):
        return RecordCheck(
            False,
            f"mission record hash mismatch (record {supplied[:16]}..., "
            f"computed {expected[:16]}...)",
            expected=expected,
            supplied=supplied,
        )
    return RecordCheck(True, "mission record hash verified", expected, supplied)


__all__ = [
    "DEFAULT_MAX_AGE_MS",
    "GENESIS_HASH",
    "PRIVILEGED_COMMANDS",
    "SAFE_DIRECTION_COMMANDS",
    "AuditChain",
    "CommandVerifier",
    "RecordCheck",
    "VerifyResult",
    "chain_hash",
    "record_hash",
    "sign_payload",
    "verify_mission_record",
]
