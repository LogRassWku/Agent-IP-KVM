import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from agent_ip_kvm.video import FFmpegV4L2VideoSource, SourceHealth, VideoSourceError


class FakeProcess:
    def __init__(self, data: bytes) -> None:
        self.stdout = io.BytesIO(data)
        self.stderr = io.BytesIO()
        self.command = None
        self._returncode = None

    def poll(self):
        return self._returncode

    def terminate(self):
        self._returncode = 0

    def wait(self, timeout=None):
        self._returncode = 0
        return 0

    def kill(self):
        self._returncode = -9


class V4L2CaptureTests(unittest.TestCase):
    def test_reads_complete_mjpeg_frames_without_reencoding(self) -> None:
        first = b"\xff\xd8first\xff\xd9"
        second = b"\xff\xd8second\xff\xd9"
        process = FakeProcess(b"prefix" + first + second)
        captured_command = []

        def process_factory(command, **kwargs):
            captured_command.extend(command)
            return process

        with tempfile.TemporaryDirectory() as directory:
            device = Path(directory) / "video0"
            device.touch()
            source = FFmpegV4L2VideoSource(
                device,
                width=1920,
                height=1080,
                fps=60,
                ffmpeg_path="ffmpeg",
                process_factory=process_factory,
                platform_name="Linux",
            )
            mode = source.open()
            source.start()
            self.assertEqual(source.next_frame().data, first)
            self.assertEqual(source.next_frame().data, second)
            self.assertEqual(mode.pixel_format, "MJPEG")
            self.assertIn("-c:v", captured_command)
            self.assertIn("copy", captured_command)
            source.close()
            self.assertEqual(source.health(), SourceHealth.CLOSED)

    def test_rejects_non_linux_platform(self) -> None:
        source = FFmpegV4L2VideoSource(platform_name="Windows")
        with self.assertRaisesRegex(VideoSourceError, "requires Linux"):
            source.open()

    def test_times_out_when_capture_device_produces_no_frame(self) -> None:
        read_fd, write_fd = os.pipe()
        stdout = os.fdopen(read_fd, "rb", buffering=0)
        process = FakeProcess(b"")
        process.stdout = stdout

        def process_factory(command, **kwargs):
            return process

        with tempfile.TemporaryDirectory() as directory:
            device = Path(directory) / "video0"
            device.touch()
            source = FFmpegV4L2VideoSource(
                device,
                ffmpeg_path="ffmpeg",
                frame_timeout=0.01,
                process_factory=process_factory,
                platform_name="Linux",
            )
            source.open()
            source.start()
            with patch("agent_ip_kvm.video.v4l2_capture.select.select", return_value=([], [], [])):
                with self.assertRaisesRegex(VideoSourceError, "timed out"):
                    source.next_frame()
        os.close(write_fd)


if __name__ == "__main__":
    unittest.main()
