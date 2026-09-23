"""Analysis contract checks without running or downloading an LLM."""

from datetime import date
import json
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError

import meeting_analysis as analysis


ANCHOR = date(2026, 9, 23)


def task(quote="айгуль подготовьте отчет до завтра", **changes):
    result = {
        "title": "Подготовить отчет", "assignee": "айгуль", "deadline": "2026-09-24",
        "deadline_text": "до завтра", "completed": False, "completion_quote": None,
        "urgency": "medium", "direction": "finance", "source_quote": quote, "needs_review": False,
    }
    result.update(changes)
    return result


def analyze(items, text=None, as_of=ANCHOR, **options):
    transcript = {"text": text or " ".join(item["source_quote"] for item in items)}
    with patch.object(analysis, "_request_tasks", return_value=items):
        return analysis.analyze_meeting(transcript, meeting_date=ANCHOR, as_of=as_of, **options)


class GroundingTests(unittest.TestCase):
    def test_partial_speaker_segments_do_not_drop_tasks_from_full_text(self):
        transcript = {"text": "коллеги начинаем айгуль подготовьте отчет до завтра",
                      "segments": [{"text": "коллеги начинаем", "speaker": "SPEAKER_01"}]}
        with patch.object(analysis, "_request_tasks", return_value=[task()]) as model:
            result = analysis.analyze_meeting(transcript, meeting_date=ANCHOR, as_of=ANCHOR)
        self.assertEqual(len(result["tasks"]), 1)
        self.assertIsNone(result["tasks"][0]["source_speaker"])
        self.assertEqual(model.call_args.args[0][0]["text"], transcript["text"])
        self.assertEqual(len(transcript["segments"]), 1)
        self.assertTrue(any("полный текст" in text for text in result["warnings"]))

    def test_relative_deadline_is_recomputed_against_meeting_not_report_date(self):
        result = analyze([task(deadline="2030-01-01")], as_of=date(2026, 9, 25))
        item = result["tasks"][0]
        self.assertEqual(item["deadline"], "2026-09-24")
        self.assertEqual(item["status"], "overdue")
        self.assertEqual(item["urgency"], "high")
        self.assertEqual(result["dashboard"]["by_status"], {"in_progress": 0, "overdue": 1, "completed": 0})

    def test_due_today_is_in_progress_and_not_overdue(self):
        result = analyze([task()], as_of=date(2026, 9, 24))
        self.assertEqual(result["tasks"][0]["status"], "in_progress")

    def test_unknown_identity_and_deadline_stay_null(self):
        result = analyze([task("я подготовлю отчет", assignee="SPEAKER_00", deadline_text=None)])
        item = result["tasks"][0]
        self.assertIsNone(item["assignee"])
        self.assertIsNone(item["deadline"])
        self.assertTrue(item["needs_review"])

    def test_invented_identity_is_removed_even_with_valid_task_evidence(self):
        item = analyze([task(assignee="Иван Иванов")])["tasks"][0]
        self.assertIsNone(item["assignee"])
        self.assertTrue(item["needs_review"])

    def test_name_must_be_whole_words_not_substring_of_another_name(self):
        item = analyze([task("иванов подготовьте отчет до завтра", assignee="иван")])["tasks"][0]
        self.assertIsNone(item["assignee"])

    def test_source_quote_uses_original_spacing_case_and_speaker(self):
        transcript = {"segments": [{"speaker": "SPEAKER_03", "text": "айгуль  подготовьте отчет до завтра"}]}
        with patch.object(analysis, "_request_tasks", return_value=[task("Айгуль подготовьте отчет до завтра")]):
            result = analysis.analyze_meeting(transcript, meeting_date=ANCHOR, as_of=ANCHOR)
        item = result["tasks"][0]
        self.assertEqual(item["source_quote"], "айгуль  подготовьте отчет до завтра")
        self.assertEqual(item["source_speaker"], "SPEAKER_03")
        self.assertEqual(item["assignee"], "айгуль")

    def test_task_evidence_can_span_speakers_without_identity_inference(self):
        transcript = {"segments": [
            {"speaker": "SPEAKER_00", "text": "айгуль подготовьте отчет"},
            {"speaker": "SPEAKER_01", "text": "до завтра"},
        ]}
        with patch.object(analysis, "_request_tasks", return_value=[task()]):
            result = analysis.analyze_meeting(transcript, meeting_date=ANCHOR, as_of=ANCHOR)
        self.assertIsNone(result["tasks"][0]["source_speaker"])

    def test_explicit_completion_overrides_elapsed_deadline(self):
        quote = "айгуль отчет выполнен срок до 20.09.2026"
        result = analyze([task(quote, deadline="2026-09-20", deadline_text="до 20.09.2026",
                               completed=True, completion_quote="отчет выполнен")])
        self.assertEqual(result["tasks"][0]["status"], "completed")

    def test_negated_future_partial_and_ungrounded_completion_are_not_completed(self):
        for quote, evidence in [
            ("айгуль отчет не выполнен до завтра", "выполнен"),
            ("айгуль отчет будет готов до завтра", "готов"),
            ("айгуль отчет готов на 60% до завтра", "готов"),
            ("айгуль подготовьте отчет до завтра", "выполнен"),
        ]:
            with self.subTest(quote=quote):
                item = analyze([task(quote, completed=True, completion_quote=evidence)])["tasks"][0]
                self.assertEqual(item["status"], "in_progress")
                self.assertTrue(item["needs_review"])

    def test_hallucinated_quote_and_deadline_are_rejected(self):
        for item in (task("несуществующая цитата"), task(deadline_text="через неделю")):
            with self.subTest(item=item), self.assertRaises(analysis.AnalysisError):
                analyze([item], text="айгуль подготовьте отчет до завтра")

    def test_invalid_date_enum_boolean_and_extra_fields_are_rejected(self):
        for change in ({"deadline": "2026-02-30"}, {"urgency": "urgent"},
                       {"direction": "madeup"}, {"completed": "false"}, {"extra": 7}):
            with self.subTest(change=change), self.assertRaises(analysis.AnalysisError):
                analyze([task(**change)])

    def test_duplicate_evidence_is_deduplicated_and_dashboard_matches(self):
        second = task("иван проверьте договор", title="Проверить договор", assignee="иван",
                      deadline=None, deadline_text=None, direction="legal", urgency="low")
        result = analyze([task(), task(), second])
        self.assertEqual([item["id"] for item in result["tasks"]], ["task-0001", "task-0002"])
        self.assertEqual(result["dashboard"]["total"], 2)
        self.assertEqual(result["dashboard"]["by_direction"], {"finance": 1, "legal": 1})
        self.assertEqual(result["dashboard"]["needs_review"], 1)
        self.assertEqual(sum(result["dashboard"]["by_urgency"].values()), 2)

    def test_distinct_actions_in_same_quote_are_not_dropped(self):
        quote = "айгуль подготовьте отчет и проверьте договор до завтра"
        result = analyze([task(quote), task(quote, title="Проверить договор", direction="legal")])
        self.assertEqual(result["dashboard"]["total"], 2)

    def test_empty_transcript_returns_empty_dashboard_without_request(self):
        with patch.object(analysis, "_request_tasks") as request:
            result = analysis.analyze_meeting({"text": " "}, meeting_date=ANCHOR, as_of=ANCHOR)
        request.assert_not_called()
        self.assertEqual(result["dashboard"]["total"], 0)

    def test_ambiguous_deadline_is_not_invented(self):
        quote = "айгуль подготовьте отчет на следующем совещании"
        item = analyze([task(quote, deadline_text="на следующем совещании")])["tasks"][0]
        self.assertIsNone(item["deadline"])
        self.assertTrue(item["needs_review"])


class DateAndChunkTests(unittest.TestCase):
    def test_russian_kazakh_spoken_and_calendar_dates(self):
        examples = {
            "до пятницы": "2026-09-25", "жұмаға дейін": "2026-09-25",
            "до следующей среды": "2026-09-30", "ертең": "2026-09-24",
            "бүгін": "2026-09-23", "через три недели": "2026-10-14",
            "екі күн ішінде": "2026-09-25", "до пятнадцатого октября": "2026-10-15",
            "к двадцатому октября": "2026-10-20", "до двадцать шестого сентября": "2026-09-26",
            "25 қыркүйекке дейін": "2026-09-25", "до 02.01.27": "2027-01-02",
        }
        for text, expected in examples.items():
            with self.subTest(text=text):
                self.assertEqual(analysis._resolve_deadline(text, ANCHOR).isoformat(), expected)

    def test_chunking_keeps_every_word_including_end_of_long_turn(self):
        text = " ".join(f"слово{i}" for i in range(2500))
        chunks = analysis._chunks({"segments": [{"text": text, "speaker": "SPEAKER_00"}]})
        self.assertGreater(len(chunks), 1)
        recovered = {word for chunk in chunks for segment in chunk for word in segment["text"].split()}
        self.assertEqual(recovered, set(text.split()))
        self.assertTrue(all(sum(len(item["text"]) + 50 for item in chunk) <= 4500 for chunk in chunks))

    def test_multichunk_report_processes_every_chunk_and_announces_limitation(self):
        transcript = {"text": "слово " * 2000}
        with patch.object(analysis, "_request_tasks", return_value=[]) as request:
            result = analysis.analyze_meeting(transcript, meeting_date=ANCHOR, as_of=ANCHOR)
        self.assertEqual(request.call_count, len(analysis._chunks(transcript)))
        self.assertTrue(any("фрагмент" in warning for warning in result["warnings"]))


class OllamaTransportTests(unittest.TestCase):
    def response(self, content, **outer):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({
            "done": True, "message": {"content": content}, **outer,
        }).encode()
        return response

    def test_configured_url_schema_nonstreaming_and_gpu_unload(self):
        with patch.object(analysis, "urlopen", return_value=self.response('{"tasks": []}')) as request:
            result = analysis._request_tasks([{"text": "начинаем", "speaker": None}], ANCHOR,
                                             "http://localhost:11434/", "Gemma-4-12B-it-Q6_K:latest", 42)
        self.assertEqual(result, [])
        sent = request.call_args.args[0]
        self.assertEqual(sent.full_url, "http://localhost:11434/api/chat")
        body = json.loads(sent.data)
        self.assertFalse(body["stream"])
        self.assertEqual(body["keep_alive"], 0)
        self.assertEqual(body["format"], analysis.TASK_SCHEMA)
        self.assertEqual(request.call_args.kwargs["timeout"], 42)

    def test_connection_timeout_missing_model_and_bad_json_have_no_fallback(self):
        failures = [URLError("secret-network-details"), TimeoutError("private-details"),
                    HTTPError("private", 404, "not found", {}, None)]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__), patch.object(analysis, "urlopen", side_effect=failure):
                with self.assertRaises(analysis.AnalysisError) as raised:
                    analysis.analyze_meeting({"text": "тест"}, meeting_date=ANCHOR, as_of=ANCHOR)
                self.assertNotIn("private", str(raised.exception))
                self.assertNotIn("secret", str(raised.exception))
        for content, outer in [("not json", {}), ("[]", {}), ('{"tasks": []}', {"done_reason": "length"}),
                               ('{"tasks": []}', {"done": False})]:
            with self.subTest(content=content, outer=outer), patch.object(analysis, "urlopen", return_value=self.response(content, **outer)):
                with self.assertRaises(analysis.AnalysisError):
                    analysis.analyze_meeting({"text": "тест"}, meeting_date=ANCHOR, as_of=ANCHOR)


if __name__ == "__main__":
    unittest.main()
