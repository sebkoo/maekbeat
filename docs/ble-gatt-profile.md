# Maekbeat vitals GATT profile

The contract between a wearable and the iOS gateway, central side. Implemented by [apps/ios](../apps/ios) at C15 as `GattProfile`; the codec and every number below are asserted in `MaekbeatKit/Tests/MaekbeatKitTests/GattProfileTests.swift`.

**No peripheral implementing this profile exists.** It is a documented contract for hardware this project does not have and does not claim to have ([DISCLAIMER.md](../DISCLAIMER.md)). A central has to be written against something, and writing it against a profile with the arithmetic worked out is the closest an educational repository gets to the real thing.

## Service and characteristics

| Role                    | UUID                                   | Properties  |
| ----------------------- | -------------------------------------- | ----------- |
| Maekbeat vitals service | `6D61656B-0001-4265-6174-000000000001` | —           |
| Vitals frame            | `6D61656B-0001-4265-6174-000000000002` | Notify only |

A vendor 128-bit UUID rather than a SIG-assigned one, and that is a choice with a cost. Heart Rate (`0x180D`) and Pulse Oximeter (`0x1822`) exist, a real product would very likely expose them, and a generic BLE client would understand those and understands nothing here. The reason this profile does not borrow them: one notification carries four metrics in one packet, which is not what either service describes, and putting a four-field struct behind `0x180D` would misdescribe the payload to every client that knows what `0x180D` means. Borrowing a well-known identifier for a private layout is worse than being private.

Notify, not indicate. Indications are acknowledged per value at the ATT layer, which at 1 Hz spends a round trip per reading to protect against a loss the pipeline already handles: `seq` gaps are visible to the gateway, the server deduplicates, and [apps/web](../apps/web) draws missing samples as a shaded gap rather than interpolating across them. Paying battery for a guarantee three layers already provide is the wrong trade on a wearable.

## The payload, and the constraint that shaped it

19 bytes, little-endian, one notification per frame.

| Offset | Size | Field            | Encoding                |
| ------ | ---- | ---------------- | ----------------------- |
| 0      | 1    | profile version  | `uint8`, currently `1`  |
| 1      | 4    | `seq`            | `uint32`                |
| 5      | 6    | `capturedAtMs`   | `uint48`, Unix epoch ms |
| 11     | 2    | `heartRateBpm`   | `uint16`                |
| 13     | 2    | `spo2Pct`        | `uint16`, value × 100   |
| 15     | 2    | `respirationRpm` | `uint16`, value × 100   |
| 17     | 2    | `motion`         | `uint16`, value × 10000 |

### ATT MTU — the arithmetic

A profile doc that never mentions MTU is a profile doc nobody has implemented. The default ATT MTU every BLE peer must accept without negotiating anything is **23 bytes**. A notification spends three of them on ATT itself — one opcode byte and two handle bytes — so the usable payload is **20 bytes**:

```text
  23  default ATT MTU
-  3  ATT notification overhead (opcode + handle)
= 20  usable payload bytes
- 19  Maekbeat vitals frame
=  1  byte spare
```

**Frames are sized to fit, so there is no fragmentation and no reassembly layer.** That is the entire policy, and it is only honest because the arithmetic above closes. iOS negotiates a larger MTU on modern hardware (185 is typical), but nothing here relies on it: a peripheral that never negotiates still delivers whole frames.

Two consequences worth stating rather than discovering later:

- **`deviceId` is not on the air.** It is the peripheral's identity, supplied by the central from `CBPeripheral.identifier`. A 16-byte identifier in every notification would cost more than all four readings put together.
- **Adding a field breaks the fit.** The next `uint16` takes the payload to 21 and past the 20-byte ceiling. The policy for that is a profile version bump plus one of two explicit choices — require a negotiated MTU and verify it before subscribing, or add a fragmentation header — and not silent fragmentation. A reassembler that drops a fragment turns one lost packet into a corrupt frame, which is strictly worse than a visible gap.

### Resolution and range

The fixed-point scales are chosen so each field's transport bound from [packages/protocol](../packages/protocol) fits its width:

| Field            | Bound | Scaled max | Fits `uint16` |
| ---------------- | ----- | ---------- | ------------- |
| `heartRateBpm`   | 0–300 | 300        | yes           |
| `spo2Pct`        | 0–100 | 10 000     | yes           |
| `respirationRpm` | 0–120 | 12 000     | yes           |
| `motion`         | 0–1   | 10 000     | yes           |

`heartRateBpm` needs two bytes rather than one because the bound is 300 and a `uint8` stops at 255 — the kind of detail that costs a field revision when it is found on hardware instead of on paper.

`capturedAtMs` is six bytes because eight would not fit. A 48-bit millisecond counter runs to the year 10889, which is a bound this profile is content to declare.

## What the central does with it

`GattProfile.decode` refuses three things rather than guessing: a payload of the wrong length, a profile version it does not speak, and a reading outside its transport bound. The bounds are the same ones `vitalsFrameSchema` enforces — the radio path does not get a weaker contract than the WebSocket path, so a peripheral sending an SpO2 of 655% is stopped at the phone rather than forwarded to the server.

Decoding failure is a counted drop, never a disconnect. One garbled notification says nothing about whether the link is healthy, and tearing down a working stream over it is the same mistake as closing an ingest socket over one bad frame, which [apps/server](../apps/server) refuses to do.

## What this document does not cover

- **Pairing, bonding and encryption.** Vitals are health data and a real product would require an encrypted, bonded link. Nothing here does, because nothing here has a peer to bond with, and specifying a security model with no implementation would be the kind of claim [CLAUDE.md](../CLAUDE.md) G3 forbids. It belongs with the C22 threat model.
- **Connection interval and battery.** The 1 Hz rate comes from [packages/vitals-sim](../packages/vitals-sim), not from a power budget anyone has measured.
- **The peripheral side.** `GattProfile.encode` exists so the decoder can be proved against bytes it did not write, and is used only by tests. It is not a device implementation.
- **Any measured behaviour at all.** No throughput, no latency, no range. Those need hardware, and [apps/ios/README.md](../apps/ios/README.md) lists exactly which claims in this repository wait on it.
