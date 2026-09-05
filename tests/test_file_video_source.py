import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from agent_ip_kvm.video import EndOfStream, FFmpegFileVideoSource, SourceHealth
from agent_ip_kvm.video.file import parse_ffprobe_output


PROBE_OUTPUT = json.dumps(
    {
        "streams": [
            {
                "width": 2,
                "height": 1,
                "avg_frame_rate": "30/1",
                "r_frame_rate": "30/1",
            }
        ]
    }
)


class FakeProcess:
    def __init__(self, data: bytes) -> None:
        self.stdout = io.BytesIO(data)
        self.stderr = io.BytesIO()
        self._returncode: int | None = None

    def poll(self) -> int | None:
        return self._returncode

    def terminate(self) -> None:
        self._returncode = 0

    def wait(self, timeout: int | None = None) -> int:
        self._returncode = 0
        return 0

    def kill(self) -> None:
        self._returncode = -9


class FileVideoSourceTests(unittest.TestCase):
    def test_parses_fractional_frame_rate(self) -> None:
        capability = parse_ffprobe_output(
            json.dumps(
                {
                    "streams": [
                        {
                            "width": 1920,
                            "height": 1080,
                            "avg_frame_rate": "30000/1001",
                        }
                    ]
                }
            )
        )
        self.assertEqual((capability.width, capability.height), (1920, 1080))
        self.assertAlmostEqual(capability.fps, 29.970, places=3)
        self.assertEqual(capability.pixel_format, "RGB24")

    def test_reads_complete_frames_and_reports_end(self) -> None:
        frame_data = bytes(range(6))
        process = FakeProcess(frame_data * 2)

        with tempfile.TemporaryDirectory() as directory:
            video_path = Path(directory) / "test.mp4"
            video_path.write_bytes(b"fixture")

            def probe_runner(command: tuple[str, ...]) -> subprocess.CompletedProcess[str]:
                return subprocess.CompletedProcess(command, 0, PROBE_OUTPUT, "")

            def process_factory(*args: object, **kwargs: object) -> FakeProcess:
                return process

            source = FFmpegFileVideoSource(
                video_path,
                realtime=False,
                ffprobe_path="ffprobe",
                ffmpeg_path="ffmpeg",
                probe_runner=probe_runner,
                process_factory=process_factory,
            )
            mode = source.open()
            source.start()
            first = source.next_frame()
            second = source.next_frame()

            self.assertEqual((mode.width, mode.height, mode.fps), (2, 1, 30.0))
            self.assertEqual(first.data, frame_data)
            self.assertEqual((first.sequence, second.sequence), (0, 1))
            with self.assertRaisesRegex(EndOfStream, "end of stream"):
                source.next_frame()
            self.assertEqual(source.health(), SourceHealth.ENDED)
            source.close()
            self.assertEqual(source.health(), SourceHealth.CLOSED)

    def test_rejects_missing_file_before_probe(self) -> None:
        source = FFmpegFileVideoSource("definitely-not-present.mp4")
        with self.assertRaisesRegex(Exception, "does not exist"):
            source.open()
        self.assertEqual(source.health(), SourceHealth.ERROR)


if __name__ == "__main__":
    unittest.main()

