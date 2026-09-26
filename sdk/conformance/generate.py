#!/usr/bin/env python3
"""Generate the order-message golden vectors from an independent encoder.

This is a third implementation of `05` §4 (Python `struct`), so neither the
Rust nor the TypeScript encoder grades its own homework. Re-run it only when
the spec changes, and review the diff:

    python3 sdk/conformance/generate.py > sdk/conformance/order-v1.json
"""
import hashlib
import json
import struct

MAGIC = b"KRYONv1\x00"
U64_MAX = 2**64 - 1


def encode(o):
    out = (
        MAGIC
        + bytes.fromhex(o["domain"])
        + bytes.fromhex(o["owner"])
        + struct.pack("<BHB", o["sub_id"], o["market_id"], o["flags"])
        + struct.pack("<QQQQ", int(o["size"]), int(o["limit_price"]), int(o["nonce"]), int(o["expiry_ts"]))
    )
    assert len(out) == 108
    return out.hex()


def order(domain, owner, sub_id, market_id, flags, size, limit_price, nonce, expiry_ts):
    # u64s are strings so JSON readers never round them through a float.
    return dict(
        domain=domain, owner=owner, sub_id=sub_id, market_id=market_id, flags=flags,
        size=str(size), limit_price=str(limit_price), nonce=str(nonce), expiry_ts=str(expiry_ts),
    )


D = hashlib.sha256(b"kryon-conformance-domain").hexdigest()
A = hashlib.sha256(b"kryon-conformance-owner-a").hexdigest()
B = "ff" * 32

cases = [
    ("typical long", order(D, A, 0, 1, 0b001, 1_500_000_000, 250_120_000_000, 1, 1_790_602_200)),
    ("typical short reduce-only", order(D, A, 0, 7, 0b010, 2_000_000_000, 249_000_000_000, 2, 1_790_605_800)),
    ("post-only long, sub-account 3", order(D, A, 3, 2, 0b101, 10_000_000, 99_990_000_000, 1234567890123, 1_791_207_000)),
    ("all flags", order(D, A, 1, 1, 0b111, 1, 1, 3, 1)),
    ("zero numbers", order("00" * 32, "00" * 32, 0, 0, 0, 0, 0, 0, 0)),
    ("max numbers", order(B, B, 255, 65535, 0b111, U64_MAX, U64_MAX, U64_MAX, U64_MAX)),
    ("byte order: distinct bytes", order(D, A, 0x7f, 0x0102, 0b001, 0x0807060504030201, 0x100F0E0D0C0B0A09, 0x1817161514131211, 0x201F1E1D1C1B1A19)),
    ("market id high byte only", order(D, A, 0, 0x0100, 0, 1, 1, 0, 0)),
]

domains = [
    {
        "name": "mainnet-beta genesis + placeholder program",
        "genesis_hash": hashlib.sha256(b"genesis-a").hexdigest(),
        "program_id": hashlib.sha256(b"program-a").hexdigest(),
    },
    {
        "name": "zeros",
        "genesis_hash": "00" * 32,
        "program_id": "00" * 32,
    },
]
for d in domains:
    d["domain"] = hashlib.sha256(bytes.fromhex(d["genesis_hash"]) + bytes.fromhex(d["program_id"])).hexdigest()

print(json.dumps({
    "spec": "docs/prd/05-program-design-anchor.md §4",
    "version": 1,
    "length": 108,
    "vectors": [{"name": n, "order": o, "hex": encode(o)} for n, o in cases],
    "domains": domains,
}, indent=2))
