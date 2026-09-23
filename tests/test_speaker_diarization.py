"""Speaker alignment and integration checks without downloaded models."""

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np
import soundfile as sf

import speaker_diarization as diarization
import stt_kazakh_russian as stt


def word(text, start, end):
    return {"word": text, "start": start, "end": end}


def turn(speaker, start, end):
    return {"speaker": speaker, "start": start, "end": end}


class SpeakerAssignmentTests(unittest.TestCase):
    def test_bilingual_words_are_preserved_and_grouped_by_speaker(self):
        words = [word("әріптестер", 0.2, 0.7), word("начинаем", 0.8, 1.2), word("жақсы", 2.2, 2.8)]
        turns = [turn("SPEAKER_00", 0, 2), turn("SPEAKER_01", 2, 3)]
        labelled, segments = diarization.assign_speakers(words, turns)
        self.assertEqual([item["speaker"] for item in labelled], ["SPEAKER_00", "SPEAKER_00", "SPEAKER_01"])
        self.assertEqual([item["text"] for item in segments], ["әріптестер начинаем", "жақсы"])
        self.assertEqual([item["word"] for item in labelled], [item["word"] for item in words])
        self.assertTrue(all("speaker" not in item for item in words))

    def test_maximum_overlap_ties_and_uncovered_words(self):
        words = [word("first", 1.8, 2.5), word("tie", 3.5, 4.5), word("outside", 6, 7)]
        turns = [turn("A", 0, 2), turn("B", 2, 4), turn("A", 4, 5)]
        labelled, segments = diarization.assign_speakers(words, turns)
        self.assertEqual([item["speaker"] for item in labelled], ["B", None, None])
        self.assertEqual(" ".join(item["text"] for item in segments), "first tie outside")

    def test_pause_or_intervening_turn_splits_same_speaker(self):
        words = [word("one", 0, 0.5), word("two", 2.5, 3), word("three", 4.1, 4.5)]
        turns = [turn("A", 0, 3), turn("B", 3, 4), turn("A", 4, 5)]
        _, segments = diarization.assign_speakers(words, turns)
        self.assertEqual([segment["text"] for segment in segments], ["one", "two", "three"])

    def test_empty_and_unassigned_transcripts(self):
        self.assertEqual(diarization.assign_speakers([], []), ([], []))
        words, segments = diarization.assign_speakers([word("hello", 0, 1)], [])
        self.assertIsNone(words[0]["speaker"])
        self.assertIsNone(segments[0]["speaker"])
        self.assertEqual(segments[0]["text"], "hello")

    def test_invalid_speaker_counts_fail_before_loading_audio_or_model(self):
        for options in [dict(num_speakers=0), dict(min_speakers=-1), dict(max_speakers=True),
                        dict(min_speakers=3, max_speakers=2), dict(num_speakers=3, min_speakers=2)]:
            with self.subTest(options=options), patch.object(diarization, "_load_pipeline") as loader:
                with self.assertRaises(ValueError):
                    diarization.diarize("missing.wav", **options)
                loader.assert_not_called()


class DiarizationIntegrationTests(unittest.TestCase):
    def test_waveform_is_mono_16khz_and_turns_are_clipped(self):
        annotation = Mock()
        annotation.itertracks.return_value = [(SimpleNamespace(start=-0.1, end=1.5), 0, "SPEAKER_00")]
        pipeline = Mock(return_value=SimpleNamespace(exclusive_speaker_diarization=annotation))
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "audio.wav"
            sf.write(path, np.zeros((8000, 2), dtype=np.float32), 8000)
            with patch.object(diarization.torch.cuda, "is_available", return_value=True), patch.object(diarization, "_load_pipeline", return_value=pipeline):
                result = diarization.diarize(path, num_speakers=2)
        self.assertEqual(result, [turn("SPEAKER_00", 0, 1)])
        audio = pipeline.call_args.args[0]
        self.assertEqual(audio["sample_rate"], 16000)
        self.assertEqual(tuple(audio["waveform"].shape), (1, 16000))
        self.assertEqual(pipeline.call_args.kwargs, {"num_speakers": 2})
        self.assertEqual([call.args[0].type for call in pipeline.method_calls if call[0] == "to"], ["cuda", "cpu"])

    def test_diarized_api_passes_counts_and_preserves_transcript(self):
        transcript = {"text": "сәлем коллеги", "duration": 2, "timestamps_approximate": True,
                      "words": [word("сәлем", 0, 0.5), word("коллеги", 1.1, 1.7)]}
        turns = [turn("A", 0, 1), turn("B", 1, 2)]
        with patch.object(diarization, "diarize", return_value=turns) as diarize, patch.object(stt, "transcribe_with_timestamps", return_value=transcript):
            result = stt.transcribe_diarized("meeting.wav", num_speakers=2)
        diarize.assert_called_once_with("meeting.wav", num_speakers=2, min_speakers=None, max_speakers=None)
        self.assertEqual(result["text"], transcript["text"])
        self.assertEqual(result["speakers"], ["A", "B"])
        self.assertEqual(result["speaker_turns"], turns)
        self.assertEqual([segment["speaker"] for segment in result["segments"]], ["A", "B"])

    def test_bad_windows_fail_before_diarization(self):
        with patch.object(diarization, "diarize") as diarize, self.assertRaises(ValueError):
            stt.transcribe_diarized("missing.wav", chunk_seconds=0)
        diarize.assert_not_called()


if __name__ == "__main__":
    unittest.main()
