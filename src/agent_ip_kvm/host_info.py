"""Validated cache for information reported by the controlled host."""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1
MAX_ITEMS = 32
MAX_TEXT_LENGTH = 512


class HostInfoError(ValueError):
    """Raised when a controlled-host inventory does not match the schema."""


def _text(value: object, name: str, *, required: bool = False) -> str | None:
    if value is None and not required:
        return None
    if not isinstance(value, str) or (required and not value.strip()):
        raise HostInfoError(f"{name} must be a non-empty string")
    value = value.strip()
    if len(value) > MAX_TEXT_LENGTH:
        raise HostInfoError(f"{name} is too long")
    return value or None


def _integer(value: object, name: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise HostInfoError(f"{name} must be a non-negative integer")
    return value


def _object(value: object, name: str) -> dict[str, object]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise HostInfoError(f"{name} must be an object")
    return value


def _items(value: object, name: str) -> list[dict[str, object]]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_ITEMS:
        raise HostInfoError(f"{name} must be a list with at most {MAX_ITEMS} items")
    if any(not isinstance(item, dict) for item in value):
        raise HostInfoError(f"{name} entries must be objects")
    return value


def validate_host_info(payload: dict[str, object]) -> dict[str, object]:
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise HostInfoError(f"schema_version must be {SCHEMA_VERSION}")

    os_info = _object(payload.get("os"), "os")
    system = _object(payload.get("system"), "system")
    bios = _object(payload.get("bios"), "bios")
    cpu = _object(payload.get("cpu"), "cpu")
    memory = _object(payload.get("memory"), "memory")
    network = _object(payload.get("network"), "network")

    gpus = [
        {
            "name": _text(item.get("name"), "gpus.name", required=True),
            "driver_version": _text(item.get("driver_version"), "gpus.driver_version"),
            "memory_bytes": _integer(item.get("memory_bytes"), "gpus.memory_bytes"),
        }
        for item in _items(payload.get("gpus"), "gpus")
    ]
    memory_modules = [
        {
            "capacity_bytes": _integer(item.get("capacity_bytes"), "memory.modules.capacity_bytes"),
            "speed_mts": _integer(item.get("speed_mts"), "memory.modules.speed_mts"),
            "manufacturer": _text(item.get("manufacturer"), "memory.modules.manufacturer"),
            "part_number": _text(item.get("part_number"), "memory.modules.part_number"),
        }
        for item in _items(memory.get("modules"), "memory.modules")
    ]
    disks = [
        {
            "model": _text(item.get("model"), "disks.model", required=True),
            "interface": _text(item.get("interface"), "disks.interface"),
            "size_bytes": _integer(item.get("size_bytes"), "disks.size_bytes"),
        }
        for item in _items(payload.get("disks"), "disks")
    ]
    volumes = [
        {
            "name": _text(item.get("name"), "volumes.name", required=True),
            "label": _text(item.get("label"), "volumes.label"),
            "filesystem": _text(item.get("filesystem"), "volumes.filesystem"),
            "size_bytes": _integer(item.get("size_bytes"), "volumes.size_bytes"),
            "free_bytes": _integer(item.get("free_bytes"), "volumes.free_bytes"),
        }
        for item in _items(payload.get("volumes"), "volumes")
    ]
    addresses = network.get("addresses", [])
    if not isinstance(addresses, list) or len(addresses) > MAX_ITEMS:
        raise HostInfoError(f"network.addresses must contain at most {MAX_ITEMS} entries")

    return {
        "schema_version": SCHEMA_VERSION,
        "collected_at": _text(payload.get("collected_at"), "collected_at", required=True),
        "hostname": _text(payload.get("hostname"), "hostname", required=True),
        "os": {
            "name": _text(os_info.get("name"), "os.name", required=True),
            "version": _text(os_info.get("version"), "os.version"),
            "build": _text(os_info.get("build"), "os.build"),
            "architecture": _text(os_info.get("architecture"), "os.architecture"),
            "last_boot": _text(os_info.get("last_boot"), "os.last_boot"),
        },
        "system": {
            "manufacturer": _text(system.get("manufacturer"), "system.manufacturer"),
            "model": _text(system.get("model"), "system.model"),
        },
        "bios": {
            "manufacturer": _text(bios.get("manufacturer"), "bios.manufacturer"),
            "version": _text(bios.get("version"), "bios.version"),
            "release_date": _text(bios.get("release_date"), "bios.release_date"),
            "secure_boot": bios.get("secure_boot") if isinstance(bios.get("secure_boot"), bool) else None,
        },
        "cpu": {
            "model": _text(cpu.get("model"), "cpu.model"),
            "physical_cores": _integer(cpu.get("physical_cores"), "cpu.physical_cores"),
            "logical_processors": _integer(cpu.get("logical_processors"), "cpu.logical_processors"),
            "max_clock_mhz": _integer(cpu.get("max_clock_mhz"), "cpu.max_clock_mhz"),
        },
        "memory": {
            "total_bytes": _integer(memory.get("total_bytes"), "memory.total_bytes"),
            "modules": memory_modules,
        },
        "gpus": gpus,
        "disks": disks,
        "volumes": volumes,
        "network": {
            "addresses": [
                _text(address, "network.addresses", required=True) for address in addresses
            ],
        },
    }


class HostInfoStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()

    def update(self, payload: dict[str, object]) -> dict[str, object]:
        data = validate_host_info(payload)
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(self.path.suffix + ".tmp")
            temporary.write_text(
                json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            os.replace(temporary, self.path)
        return self.status()

    def status(self) -> dict[str, object]:
        with self._lock:
            if not self.path.exists():
                return {
                    "status": "unavailable",
                    "message": "尚未收到被控主机信息",
                    "updated_at": None,
                    "data": None,
                }
            try:
                data: Any = json.loads(self.path.read_text(encoding="utf-8"))
                if not isinstance(data, dict):
                    raise HostInfoError("host information must be an object")
                data = validate_host_info(data)
            except (OSError, json.JSONDecodeError, HostInfoError) as exc:
                return {
                    "status": "error",
                    "message": str(exc),
                    "updated_at": None,
                    "data": None,
                }
        return {
            "status": "available",
            "message": "已连接被控主机信息探针",
            "updated_at": data["collected_at"],
            "data": data,
        }
