import json
import tempfile
import unittest
from pathlib import Path

from agent_ip_kvm.host_info import HostInfoError, HostInfoStore, validate_host_info


def inventory() -> dict[str, object]:
    return {
        "schema_version": 1,
        "collected_at": "2026-09-06T03:00:00Z",
        "hostname": "TEST-PC",
        "os": {
            "name": "Windows 11 Pro",
            "version": "10.0.26200",
            "build": "26200",
            "architecture": "64-bit",
            "last_boot": "2026-09-06T01:00:00Z",
        },
        "system": {"manufacturer": "Example", "model": "Notebook"},
        "bios": {
            "manufacturer": "Example",
            "version": "1.2.3",
            "release_date": "2026-01-01T00:00:00Z",
            "secure_boot": True,
        },
        "cpu": {
            "model": "Example CPU",
            "physical_cores": 8,
            "logical_processors": 16,
            "max_clock_mhz": 4800,
        },
        "memory": {
            "total_bytes": 17179869184,
            "modules": [
                {
                    "capacity_bytes": 8589934592,
                    "speed_mts": 5600,
                    "manufacturer": "Example",
                    "part_number": "RAM-8G",
                }
            ],
        },
        "gpus": [{"name": "Example GPU", "driver_version": "1.0", "memory_bytes": 8589934592}],
        "disks": [{"model": "Example SSD", "interface": "NVMe", "size_bytes": 1000204886016}],
        "volumes": [{"name": "C:", "label": "System", "filesystem": "NTFS", "size_bytes": 999000000000, "free_bytes": 500000000000}],
        "network": {"addresses": ["192.168.137.20"]},
    }


class HostInfoTests(unittest.TestCase):
    def test_store_validates_and_atomically_caches_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "controlled-host.json"
            store = HostInfoStore(path)

            self.assertEqual(store.status()["status"], "unavailable")
            result = store.update(inventory())

            self.assertEqual(result["status"], "available")
            self.assertEqual(result["data"]["hostname"], "TEST-PC")
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["schema_version"], 1)
            self.assertFalse(path.with_suffix(".json.tmp").exists())

    def test_rejects_unknown_schema_version(self) -> None:
        payload = inventory()
        payload["schema_version"] = 2

        with self.assertRaisesRegex(HostInfoError, "schema_version"):
            validate_host_info(payload)

    def test_rejects_oversized_device_lists(self) -> None:
        payload = inventory()
        payload["gpus"] = [{"name": f"GPU {index}"} for index in range(33)]

        with self.assertRaisesRegex(HostInfoError, "at most 32"):
            validate_host_info(payload)


if __name__ == "__main__":
    unittest.main()
