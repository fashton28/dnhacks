"""
Command signing + the hash-chained audit (eis_companion/security.py).

Unsigned, invalid, replayed and stale are FOUR distinct refusals here because
they are four different attacks, and a refusal that cannot say which one
happened is not much of an audit trail.

Also pins the two properties the trust argument rests on:
  * the audit chain detects mutation and deletion after the fact, and
  * a mission record whose hash does not match its content refuses dispatch
    rather than being flown on trust.
"""
from __future__ import annotations

import json

import pytest

from eis_companion.security import (
    GENESIS_HASH,
    PRIVILEGED_COMMANDS,
    SAFE_DIRECTION_COMMANDS,
    AuditChain,
    CommandVerifier,
    chain_hash,
    record_hash,
    sign_payload,
    verify_mission_record,
)

KEY = b"session-key-for-eis-1"


def signed(command: str, *, ts: int = 1_000_000, nonce: str = "n-1", **params):
    """Build the envelope a ground station would sign and send."""
    payload = {
        "type": "command",
        "vehicleId": "eis-1",
        "command": command,
        "params": dict(params),
        "ts": ts,
        "nonce": nonce,
    }
    payload["sig"] = sign_payload(payload, KEY)
    return payload


def verifier(**kwargs) -> CommandVerifier:
    kwargs.setdefault("clock_ms", lambda: 1_000_000)
    return CommandVerifier(KEY, **kwargs)


# ==========================================================================
# The four refusals
# ==========================================================================
def test_a_valid_signature_is_accepted():
    result = verifier().verify(signed("enterUnattended", operatorId="op-7"))
    assert result.ok
    assert result.failure == ""


@pytest.mark.parametrize("command", PRIVILEGED_COMMANDS)
def test_privileged_commands_are_refused_unsigned(command):
    """A compromised ground station cannot mint one (ADR D23)."""
    result = verifier().verify({
        "type": "command", "vehicleId": "eis-1", "command": command,
    })
    assert not result.ok
    assert result.failure == "unsigned"


def test_a_tampered_envelope_does_not_verify():
    payload = signed("enterUnattended", operatorId="op-7")
    payload["params"]["operatorId"] = "op-attacker"
    result = verifier().verify(payload)
    assert not result.ok and result.failure == "invalid"


def test_a_replayed_nonce_is_refused():
    v = verifier()
    payload = signed("setGimbal", pitchDeg=45.0)
    assert v.verify(payload).ok
    replayed = v.verify(dict(payload))
    assert not replayed.ok and replayed.failure == "replay"
    assert "already used" in replayed.reason


def test_a_stale_envelope_is_refused_before_it_can_consume_a_nonce():
    """Freshness is checked FIRST so replaying old traffic cannot evict live
    nonces from the cache."""
    v = verifier(max_age_ms=5_000)
    old = signed("setGimbal", ts=1_000_000 - 60_000, nonce="n-old", pitchDeg=10.0)
    result = v.verify(old)
    assert not result.ok and result.failure == "stale"
    # The nonce was never remembered, so a fresh envelope reusing it works.
    assert v.verify(signed("setGimbal", nonce="n-old", pitchDeg=10.0)).ok


def test_a_signed_command_without_a_nonce_is_refused():
    payload = {
        "type": "command", "vehicleId": "eis-1", "command": "setGimbal",
        "params": {"pitchDeg": 10.0}, "ts": 1_000_000,
    }
    payload["sig"] = sign_payload(payload, KEY)
    result = verifier().verify(payload)
    assert not result.ok and result.failure == "replay"


def test_no_key_refuses_signed_commands_rather_than_skipping_the_check():
    """A missing key must never mean "verification is off"."""
    v = CommandVerifier(b"", clock_ms=lambda: 1_000_000)
    result = v.verify(signed("enterUnattended"))
    assert not result.ok and result.failure == "no_key"
    assert not v.has_key


# ==========================================================================
# Scope: privileged always, everything else optional
# ==========================================================================
def test_ordinary_commands_pass_unsigned_by_default():
    result = verifier().verify({
        "type": "command", "vehicleId": "eis-1", "command": "arm",
    })
    assert result.ok


def test_require_all_extends_the_requirement_to_every_command():
    v = verifier(require_all=True)
    assert not v.verify({"type": "command", "command": "arm"}).ok
    assert v.verify(signed("arm")).ok


@pytest.mark.parametrize("command", SAFE_DIRECTION_COMMANDS)
def test_safe_direction_commands_survive_require_all(command):
    """Refusing an emergency stop for want of a signature is a worse failure
    than accepting an unsigned one: the attack it prevents is a denial of
    service, the accident it causes is a crash."""
    v = verifier(require_all=True)
    assert not v.requires_signature(command)
    assert v.verify({"type": "command", "command": command}).ok


def test_the_safe_direction_exemption_never_covers_a_privileged_command():
    assert not set(SAFE_DIRECTION_COMMANDS) & set(PRIVILEGED_COMMANDS)


def test_the_privileged_set_is_enforced_regardless_of_the_flag():
    v = verifier(require_all=False)
    for command in PRIVILEGED_COMMANDS:
        assert v.requires_signature(command)
    assert not v.requires_signature("arm")


def test_a_key_for_one_vehicle_does_not_sign_for_another():
    """Per-vehicle keys (ADR D26): neither airframe can mint the other's
    privileged commands."""
    other = CommandVerifier(b"session-key-for-eis-2", clock_ms=lambda: 1_000_000)
    assert not other.verify(signed("enterUnattended")).ok


def test_from_env_reads_the_named_variable(monkeypatch):
    monkeypatch.setenv("EIS_SESSION_KEY_EIS_2", KEY.decode())
    v = CommandVerifier.from_env(
        "EIS_SESSION_KEY_EIS_2", clock_ms=lambda: 1_000_000
    )
    assert v.has_key
    assert v.verify(signed("exitUnattended")).ok


def test_from_env_with_no_variable_has_no_key(monkeypatch):
    monkeypatch.delenv("EIS_SESSION_KEY_MISSING", raising=False)
    assert not CommandVerifier.from_env("EIS_SESSION_KEY_MISSING").has_key


# ==========================================================================
# The hash-chained audit
# ==========================================================================
def test_the_chain_links_every_entry_to_its_predecessor(tmp_path):
    chain = AuditChain(str(tmp_path / "audit.jsonl"))
    assert chain.head == GENESIS_HASH

    first = chain.append({"type": "healthEvent", "vehicleId": "eis-1", "state": "a"})
    second = chain.append({"type": "healthEvent", "vehicleId": "eis-1", "state": "b"})
    assert first["prev"] == GENESIS_HASH
    assert second["prev"] == first["hash"]
    assert chain.head == second["hash"]
    assert chain.verify()


def test_a_mutated_entry_breaks_the_chain(tmp_path):
    chain = AuditChain(str(tmp_path / "audit.jsonl"))
    chain.append({"type": "healthEvent", "vehicleId": "eis-1", "state": "a"})
    chain.append({"type": "healthEvent", "vehicleId": "eis-1", "state": "b"})
    entries = [dict(e) for e in chain.entries]
    entries[0]["state"] = "tampered"
    assert not chain.verify(entries)


def test_a_deleted_entry_breaks_the_chain(tmp_path):
    chain = AuditChain(str(tmp_path / "audit.jsonl"))
    for state in ("a", "b", "c"):
        chain.append({"type": "healthEvent", "vehicleId": "eis-1", "state": state})
    entries = [dict(e) for e in chain.entries]
    del entries[1]
    assert not chain.verify(entries)


def test_the_log_is_append_only_on_disk(tmp_path):
    path = tmp_path / "audit.jsonl"
    chain = AuditChain(str(path))
    chain.append({"type": "mode", "vehicleId": "eis-1", "mode": "unattended"})
    chain.append({"type": "escalation", "vehicleId": "eis-1", "missionId": "m-1"})
    lines = path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0])["type"] == "mode"
    assert json.loads(lines[1])["prev"] == json.loads(lines[0])["hash"]


def test_a_reopened_chain_continues_where_it_left_off(tmp_path):
    path = tmp_path / "audit.jsonl"
    first = AuditChain(str(path))
    head = first.append({"type": "mode", "vehicleId": "eis-1"})["hash"]
    reopened = AuditChain(str(path))
    assert reopened.head == head
    assert reopened.append({"type": "mode", "vehicleId": "eis-1"})["prev"] == head


def test_an_unwritable_path_degrades_to_no_record_not_a_forked_chain(tmp_path):
    """A directory where a file should be: the in-memory chain still advances
    consistently rather than silently forking."""
    blocked = tmp_path / "blocked"
    blocked.mkdir()
    chain = AuditChain(str(blocked))
    chain.append({"type": "mode", "vehicleId": "eis-1"})
    chain.append({"type": "mode", "vehicleId": "eis-1"})
    assert chain.verify()


def test_chain_hash_is_stable_and_content_addressed():
    entry = {"type": "mode", "vehicleId": "eis-1", "mode": "unattended"}
    assert chain_hash(GENESIS_HASH, entry) == chain_hash(GENESIS_HASH, entry)
    assert chain_hash(GENESIS_HASH, entry) != chain_hash("ff" * 32, entry)
    # Key order must not change the hash, or a re-serialised record breaks.
    reordered = {"mode": "unattended", "vehicleId": "eis-1", "type": "mode"}
    assert record_hash(entry) == record_hash(reordered)


# ==========================================================================
# Mission-record verification at dispatch
# ==========================================================================
def make_record(**overrides):
    record = {
        "missionId": "m-1", "vehicleId": "eis-1", "anomalyId": "anom-1",
        "mode": "attended", "startedAt": 1_000_000,
    }
    record.update(overrides)
    return record


def test_a_matching_record_hash_verifies():
    record = make_record()
    record["recordHash"] = record_hash(record)
    check = verify_mission_record(record)
    assert check.ok


def test_a_mismatched_record_hash_refuses_dispatch():
    record = make_record()
    record["recordHash"] = record_hash(record)
    record["anomalyId"] = "anom-swapped"      # mutated AFTER verification
    check = verify_mission_record(record)
    assert not check.ok
    assert "hash mismatch" in check.reason
    assert check.supplied and check.expected
    assert check.supplied != check.expected


def test_an_unhashed_record_is_accepted_only_when_not_required():
    record = make_record()
    assert verify_mission_record(record, required=False).ok
    assert not verify_mission_record(record, required=True).ok


def test_a_missing_record_is_accepted_only_when_not_required():
    assert verify_mission_record(None, required=False).ok
    assert not verify_mission_record(None, required=True).ok


def test_a_non_object_record_is_always_refused():
    assert not verify_mission_record("not-a-record").ok
