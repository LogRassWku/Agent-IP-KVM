import subprocess
import unittest

from agent_ip_kvm.video.v4l2 import (
    DiscoveryStatus,
    V4L2NodeKind,
    discover_v4l2_devices,
    parse_device_info,
    parse_format_capabilities,
)


INFO_OUTPUT = """
Driver Info:
        Driver name      : uvcvideo
        Card type        : Display capture-UVC05
        Bus info         : usb-xhci-hcd.0.auto-1.1
        Capabilities     : 0x84a00001
                Video Capture
                Metadata Capture
                Streaming
                Device Capabilities
        Device Caps      : 0x04200001
                Video Capture
                Streaming
"""

METADATA_INFO_OUTPUT = """
Driver Info:
        Driver name      : uvcvideo
        Card type        : Display capture-UVC05
        Bus info         : usb-xhci-hcd.0.auto-1.1
        Capabilities     : 0x84a00001
                Video Capture
                Metadata Capture
                Streaming
                Device Capabilities
        Device Caps      : 0x04a00000
                Metadata Capture
                Streaming
"""

FORMATS_OUTPUT = """
ioctl: VIDIOC_ENUM_FMT
        Type: Video Capture

        [0]: 'MJPG' (Motion-JPEG, compressed)
                Size: Discrete 1920x1080
                        Interval: Discrete 0.017s (60.000 fps)
                        Interval: Discrete 0.033s (30.000 fps)
                Size: Discrete 1280x720
                        Interval: Discrete 0.033s (30.000 fps)
        [1]: 'YUYV' (YUYV 4:2:2)
                Size: Discrete 640x480
                        Interval: Discrete 0.033s (30.000 fps)
"""


class V4L2ParserTests(unittest.TestCase):
    def test_parses_device_identity_and_capture_support(self) -> None:
        self.assertEqual(
            parse_device_info(INFO_OUTPUT),
            (
                "Display capture-UVC05",
                "uvcvideo",
                "usb-xhci-hcd.0.auto-1.1",
                V4L2NodeKind.VIDEO_CAPTURE,
            ),
        )

    def test_prefers_per_node_caps_for_metadata_node(self) -> None:
        _, _, _, node_kind = parse_device_info(METADATA_INFO_OUTPUT)
        self.assertEqual(node_kind, V4L2NodeKind.METADATA_CAPTURE)

    def test_parses_discrete_format_combinations(self) -> None:
        capabilities = parse_format_capabilities(FORMATS_OUTPUT)
        self.assertEqual(len(capabilities), 4)
        self.assertEqual(
            (capabilities[0].width, capabilities[0].height),
            (1920, 1080),
        )
        self.assertEqual(capabilities[0].fps, 60.0)
        self.assertEqual(capabilities[-1].pixel_format, "YUYV")


class V4L2DiscoveryTests(unittest.TestCase):
    def test_reports_unsupported_platform_without_running_commands(self) -> None:
        report = discover_v4l2_devices(platform_name="Windows")
        self.assertEqual(report.status, DiscoveryStatus.UNSUPPORTED_PLATFORM)
        self.assertEqual(report.devices, ())

    def test_reports_linux_with_no_devices(self) -> None:
        report = discover_v4l2_devices(device_paths=(), platform_name="Linux")
        self.assertEqual(report.status, DiscoveryStatus.NO_DEVICES)
        self.assertEqual(report.devices, ())

    def test_discovers_device_and_capabilities(self) -> None:
        def runner(command: tuple[str, ...]) -> subprocess.CompletedProcess[str]:
            output = INFO_OUTPUT if command[-1] == "--info" else FORMATS_OUTPUT
            return subprocess.CompletedProcess(command, 0, stdout=output, stderr="")

        report = discover_v4l2_devices(
            device_paths=("/dev/video0",),
            platform_name="Linux",
            tool_path="v4l2-ctl",
            runner=runner,
        )

        self.assertEqual(report.status, DiscoveryStatus.OK)
        self.assertEqual(len(report.devices), 1)
        device = report.devices[0]
        self.assertEqual(device.source_id, "v4l2:/dev/video0")
        self.assertEqual(device.node_kind, V4L2NodeKind.VIDEO_CAPTURE)
        self.assertTrue(device.supports_video_capture)
        self.assertEqual(len(device.capabilities), 4)
        self.assertIsNone(device.error)


if __name__ == "__main__":
    unittest.main()
