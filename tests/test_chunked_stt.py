"""Chunking regression tests: synthetic audio, no model download or GPU needed."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import soundfile as sf
import torch

import stt_kazakh_russian as stt


class ChunkedTranscriptionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "audio.wav"
        self.windows = []
        self.device_patch = patch.object(stt, "_get_device", return_value=torch.device("cpu"))
        self.device_patch.start()
        self.addCleanup(self.device_patch.stop)
        self.model_patch = patch.object(stt, "_load_model", return_value=(self.model, {0: "a", 1: "b", 2: "|"}, 3))
        self.loader = self.model_patch.start()
        self.addCleanup(self.model_patch.stop)

    def model(self, audio):
        self.windows.append(audio.shape[-1])
        # Each 10 ms of synthetic audio encodes one deterministic CTC token.
        ids = audio[:, ::160].round().long().clamp(0, 3)
        return (torch.nn.functional.one_hot(ids, 4).float(),)

    def write(self, wav, rate=16000):
        sf.write(self.path, wav, rate, subtype="FLOAT")

    @staticmethod
    def decode(ids):
        previous = None
        result = []
        for token in ids:
            if token != previous and token != 3:
                result.append({0: "a", 1: "b", 2: " "}[token])
            previous = token
        return " ".join("".join(result).split())

    def test_long_file_is_bounded_and_ctc_is_continuous(self):
        # Repeated letters, blanks and words straddle 10s boundaries.
        ids = np.repeat([0, 3, 0, 1, 2, 1, 3], 37).tolist() * 10
        self.write(np.repeat(ids, 160).astype(np.float32))
        progress = []
        result = stt.transcribe(self.path, progress=lambda done, total: progress.append((done, total)))
        self.assertEqual(result, self.decode(ids))
        self.assertGreater(len(self.windows), 2)
        self.assertLessEqual(max(self.windows), 12 * 16000)
        self.assertEqual(progress[-1][0], progress[-1][1])
        self.assertEqual([p[0] for p in progress], sorted({p[0] for p in progress}))

    def test_cuda_oom_retries_same_position_without_losing_text(self):
        ids = np.repeat([0, 3, 0, 2, 1, 3], 50).tolist() * 9
        self.write(np.repeat(ids, 160).astype(np.float32))
        original = stt._predict_ids
        attempted_sizes = []

        def predict(model, wav, device):
            attempted_sizes.append(len(wav))
            # Permit the first chunk, then force smaller subsequent chunks.
            if len(attempted_sizes) > 1 and len(wav) > 7 * 16000:
                raise RuntimeError("TorchScript interpreter: CUDA out of memory")
            return original(model, wav, torch.device("cpu"))

        with patch.object(stt, "_get_device", return_value=torch.device("cuda")), patch.object(stt, "_predict_ids", side_effect=predict), patch.object(torch.cuda, "empty_cache") as clear:
            self.assertEqual(stt.transcribe(self.path), self.decode(ids))
        clear.assert_called_once()
        self.assertLessEqual(max(attempted_sizes[2:]), 7 * 16000)

    def test_oom_stops_at_minimum_and_other_errors_propagate(self):
        self.write(np.zeros(3 * 16000, dtype=np.float32))
        with patch.object(stt, "_get_device", return_value=torch.device("cuda")), patch.object(stt, "_predict_ids", side_effect=torch.cuda.OutOfMemoryError("full")) as predict, patch.object(torch.cuda, "empty_cache"):
            with self.assertRaisesRegex(RuntimeError, "1-second chunk"):
                stt.transcribe(self.path, chunk_seconds=2, overlap_seconds=0.25)
            self.assertEqual(predict.call_count, 2)
        with patch.object(stt, "_predict_ids", side_effect=RuntimeError("bad model shape")) as predict:
            with self.assertRaisesRegex(RuntimeError, "bad model shape"):
                stt.transcribe(self.path)
            predict.assert_called_once()

    def test_stereo_resampling_and_short_tail(self):
        self.write(np.ones((24001, 2), dtype=np.float32), rate=8000)
        self.assertEqual(stt.transcribe(self.path, chunk_seconds=1, overlap_seconds=0), "b")
        self.assertEqual(self.windows, [16000, 16000, 16000, 1600])

    def test_short_and_empty_files(self):
        self.write(np.ones(10, dtype=np.float32))
        self.assertEqual(stt.transcribe(self.path), "b")
        self.assertEqual(self.windows, [1600])
        self.loader.reset_mock()
        self.write(np.empty(0, dtype=np.float32))
        self.assertEqual(stt.transcribe(self.path), "")
        self.loader.assert_not_called()

    def test_invalid_windows_fail_before_model_loading(self):
        for chunk, overlap in [(0, 0), (float("inf"), 1), (float("nan"), 1), (10, -1), (10, 5), (10, float("nan"))]:
            with self.subTest(chunk=chunk, overlap=overlap), self.assertRaises(ValueError):
                stt.transcribe(self.path, chunk_seconds=chunk, overlap_seconds=overlap)
        self.loader.assert_not_called()


if __name__ == "__main__":
    unittest.main()
