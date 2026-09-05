import unittest

from agent_ip_kvm.video import SourceHealth, SyntheticVideoSource, VideoSourceError


class SyntheticVideoSourceTests(unittest.TestCase):
    def test_produces_complete_sequential_720p_frames(self) -> None:
        source = SyntheticVideoSource(realtime=False)
        mode = source.open()
        source.start()

        first = source.next_frame()
        second = source.next_frame()

        self.assertEqual((mode.width, mode.height), (1280, 720))
        self.assertEqual(first.pixel_format, "RGB24")
        self.assertEqual(len(first.data), 1280 * 720 * 3)
        self.assertEqual((first.sequence, second.sequence), (0, 1))
        self.assertGreaterEqual(second.timestamp_ns, first.timestamp_ns)

        source.stop()
        self.assertEqual(source.health(), SourceHealth.READY)
        source.close()
        self.assertEqual(source.health(), SourceHealth.CLOSED)

    def test_rejects_frame_request_before_start(self) -> None:
        source = SyntheticVideoSource(realtime=False)
        with self.assertRaisesRegex(VideoSourceError, "not streaming"):
            source.next_frame()


if __name__ == "__main__":
    unittest.main()

