from __future__ import annotations

import base64
import logging
from typing import Any, Dict


logger = logging.getLogger(__name__)


def parse_minew_data(raw_hex: str) -> Dict[str, Any]:
    raw_hex = (raw_hex or "").lower()
    header = "0201061bff3906"
    if not raw_hex.startswith(header):
        return {"error": "Invalid header"}

    remainder = raw_hex[len(header):]
    if not remainder.startswith("ca"):
        return {"error": "Missing protocol indicator"}
    remainder = remainder[2:]

    if len(remainder) < 2:
        return {"error": "Incomplete packet"}

    frame_version = remainder[:2]
    remainder = remainder[2:]
    parsed: Dict[str, Any] = {"frame_version": frame_version}

    if frame_version == "00":
        if len(remainder) < 12:
            return {"error": "Incomplete device info frame"}
        mac_hex = remainder[:12]
        parsed["mac"] = ":".join(mac_hex[i:i + 2] for i in range(0, 12, 2))
        remainder = remainder[12:]

        if len(remainder) >= 2:
            parsed["battery"] = int(remainder[:2], 16)
            remainder = remainder[2:]
        if len(remainder) >= 4:
            parsed["firmware_version"] = str(int(remainder[:4], 16))
            remainder = remainder[4:]
        if len(remainder) >= 16:
            parsed["peripheral_support"] = remainder[:16]
            remainder = remainder[16:]
        if len(remainder) >= 2:
            remainder = remainder[2:]
        if len(remainder) >= 4:
            parsed["salt"] = remainder[:4]
            remainder = remainder[4:]
        if len(remainder) >= 4:
            parsed["digital_signature"] = remainder[:4]
        return parsed

    if frame_version == "18":
        if len(remainder) < 2:
            return {"error": "Incomplete monitoring frame"}
        parsed["usage"] = remainder[:2]
        remainder = remainder[2:]

        if len(remainder) >= 2:
            parsed["serial_number"] = int(remainder[:2], 16)
            remainder = remainder[2:]
        if len(remainder) >= 4:
            entries_hex = remainder[:4]
            parsed["entries"] = int(entries_hex[2:] + entries_hex[:2], 16)
            remainder = remainder[4:]
        if len(remainder) >= 4:
            exits_hex = remainder[:4]
            parsed["exits"] = int(exits_hex[2:] + exits_hex[:2], 16)
            remainder = remainder[4:]
        if len(remainder) >= 24:
            remainder = remainder[24:]
        if len(remainder) >= 4:
            parsed["random_number"] = remainder[:4]
            remainder = remainder[4:]
        if len(remainder) >= 4:
            parsed["digital_signature"] = remainder[:4]
        return parsed

    parsed["error"] = "Unknown frame version"
    return parsed


def parse_mst01_ht_payload(b64_payload: str) -> Dict[str, Any]:
    try:
        decoded = base64.b64decode(b64_payload)
        if len(decoded) < 30:
            return {"error": "Frame too short"}
        if decoded[7] != 0xCA or decoded[8] != 0x05:
            return {"error": "Not an HT frame"}

        temp_raw = int.from_bytes(decoded[12:14], byteorder="big")
        hum_raw = int.from_bytes(decoded[14:16], byteorder="big")
        return {
            "temperature": round(temp_raw / 256.0, 1),
            "humidity": round(hum_raw / 256.0, 1),
        }
    except Exception as exc:
        return {"error": str(exc)}


LSG01_TAG_MAP = {
    0x52: ("pm25", 2, False, 1),
    0x9F: ("hcho", 2, False, 1),
    0x49: ("co2", 2, False, 1),
    0xA0: ("tvoc", 2, False, 1),
    0x10: ("temperature", 2, True, 100),
    0x12: ("humidity", 2, False, 10),
}


def parse_lsg01_payload_dynamically(payload_base64: str) -> Dict[str, Any]:
    try:
        payload_bytes = base64.b64decode(payload_base64)
        index = 3 if payload_bytes[:3] == b"\x00\x01\x4B" else 0
        data: Dict[str, Any] = {}

        while index < len(payload_bytes):
            tag = payload_bytes[index]
            index += 1
            if tag not in LSG01_TAG_MAP:
                logger.warning("Unknown LSG01 tag 0x%02X, stopping parse.", tag)
                break

            label, num_bytes, is_signed, scale = LSG01_TAG_MAP[tag]
            if index + num_bytes > len(payload_bytes):
                logger.warning("Insufficient bytes for LSG01 tag %s.", label)
                break

            raw_bytes = payload_bytes[index:index + num_bytes]
            index += num_bytes
            value = int.from_bytes(raw_bytes, byteorder="big", signed=is_signed)
            data[label] = round(value / scale, 2)

        return data
    except Exception as exc:
        logger.exception("Error parsing LSG01 payload.")
        return {"error": str(exc)}
