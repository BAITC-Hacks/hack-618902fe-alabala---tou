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
    with patch.object(analysis, "_request_llama_tasks", return_value=items):
        return analysis.analyze_meeting(transcript, meeting_date=ANCHOR, as_of=as_of, **options)


class GroundingTests(unittest.TestCase):
    def test_partial_speaker_segments_do_not_drop_tasks_from_full_text(self):
        transcript = {"text": "коллеги начинаем айгуль подготовьте отчет до завтра",
                      "segments": [{"text": "коллеги начинаем", "speaker": "SPEAKER_01"}]}
        with patch.object(analysis, "_request_llama_tasks", return_value=[task()]) as model:
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
        with patch.object(analysis, "_request_llama_tasks", return_value=[task("Айгуль подготовьте отчет до завтра")]):
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
        with patch.object(analysis, "_request_llama_tasks", return_value=[task()]):
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

    def test_validation_log_has_reason_without_private_transcript(self):
        with self.assertLogs(analysis.logger, level="WARNING") as captured:
            with self.assertRaises(analysis.AnalysisError):
                analyze([task("несуществующая цитата")], text="закрытое содержание совещания")
        self.assertIn("ungrounded task", captured.output[0])
        self.assertNotIn("несуществующая цитата", " ".join(captured.output))
        self.assertNotIn("закрытое содержание", " ".join(captured.output))

    def test_repairs_only_invalid_evidence_and_preserves_actions_and_valid_tasks(self):
        original = task("Айгуль, подготовьте отчет до завтра.")
        valid = task("иван проверьте договор до завтра", title="Проверить договор",
                     assignee="иван", direction="legal")
        repair = {"source_quote": "айгуль подготовьте отчет до завтра", "deadline_text": "до завтра"}
        transcript = {"text": repair["source_quote"] + " " + valid["source_quote"]}
        with patch.object(analysis, "_request_llama_tasks", side_effect=[[original, valid], [repair]]) as model:
            result = analysis.analyze_meeting(transcript, meeting_date=ANCHOR, as_of=ANCHOR)
        self.assertEqual(model.call_count, 2)
        requests = model.call_args.kwargs["repair_requests"]
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["title"], original["title"])
        self.assertEqual(requests[0]["validation_error"], "ungrounded task")
        first, second = result["tasks"]
        self.assertEqual(first["source_quote"], repair["source_quote"])
        self.assertEqual(first["title"], original["title"])
        self.assertEqual(first["assignee"], original["assignee"])
        self.assertTrue(first["needs_review"])
        self.assertEqual(second["source_quote"], valid["source_quote"])
        self.assertEqual(second["title"], valid["title"])
        self.assertFalse(second["needs_review"])
        self.assertEqual(result["dashboard"]["total"], 2)

    def test_groups_invalid_evidence_in_one_repair_request(self):
        invalid = [task("айгуль, подготовьте отчет до завтра"), task(deadline_text="к завтра")]
        repair = {"source_quote": "айгуль подготовьте отчет до завтра", "deadline_text": "до завтра"}
        with patch.object(analysis, "_request_llama_tasks", side_effect=[invalid, [repair, repair]]) as model:
            result = analysis.analyze_meeting({"text": repair["source_quote"]},
                                              meeting_date=ANCHOR, as_of=ANCHOR)
        self.assertEqual(model.call_count, 2)
        self.assertEqual(len(model.call_args.kwargs["repair_requests"]), 2)
        self.assertEqual(result["dashboard"]["total"], 1)

    def test_real_meeting_quote_cannot_skip_intervening_speaker_reply(self):
        # Regression from the real API capture: the model omitted the objection
        # between the requested audit and the subsequently agreed deadline.
        opening = "так проврьте мне нужен полный аудит две недели вам достаточно"
        reply = "если честно то конечно две недели маловато там же ещё документооборот с площадками"
        agreement = "хорошо три недели но не больше к пятнадцатому октября жду сводный отчёт по каждой площадке отдельно"
        chunk = [{"speaker": "SPEAKER_00", "text": opening},
                 {"speaker": "SPEAKER_04", "text": reply},
                 {"speaker": "SPEAKER_00", "text": agreement}]
        raw = task(opening.removeprefix("так ") + " " + agreement,
                   title="проврьте мне нужен полный аудит", assignee="нурлн сагатович",
                   deadline="2026-10-15", deadline_text="к пятнадцатому октября",
                   urgency="high", direction="safety", needs_review=True)
        with self.assertRaisesRegex(ValueError, "ungrounded task"):
            analysis._validate_task(raw, chunk, ANCHOR, ANCHOR)
        repair = {"source_quote": " ".join((opening.removeprefix("так "), reply, agreement)),
                  "deadline_text": "к пятнадцатому октября"}
        with patch.object(analysis, "_request_llama_tasks", side_effect=[[raw], [repair]]) as model:
            result = analysis.analyze_meeting({"segments": chunk}, meeting_date=ANCHOR, as_of=ANCHOR)
        model.assert_called_with(chunk, ANCHOR, "http://127.0.0.1:8080", "gemma-4-12b-it-Q4_K_S", 600,
                                 repair_requests=[{"title": raw["title"], "source_quote": raw["source_quote"],
                                                   "deadline_text": raw["deadline_text"],
                                                   "validation_error": "ungrounded task"}])
        item = result["tasks"][0]
        self.assertEqual(item["title"], raw["title"])
        self.assertEqual(item["source_quote"], repair["source_quote"])
        self.assertIn(reply, item["source_quote"])
        self.assertEqual(item["deadline"], "2026-10-15")
        self.assertIsNone(item["source_speaker"])
        self.assertIsNone(item["assignee"])
        self.assertTrue(item["needs_review"])

    def test_failed_incomplete_or_task_replacing_repair_is_rejected_without_third_request(self):
        repairs = [[], [{"source_quote": None, "deadline_text": None}],
                   [{"source_quote": "придуманное поручение", "deadline_text": None}],
                   [{"source_quote": "айгуль подготовьте отчет до завтра", "deadline_text": "через неделю"}],
                   [{"source_quote": "айгуль подготовьте отчет до завтра", "deadline_text": "до завтра",
                     "title": "Подмененное действие"}]]
        for repaired in repairs:
            with self.subTest(repaired=repaired), patch.object(
                analysis, "_request_llama_tasks", side_effect=[[task("неверная цитата")], repaired]
            ) as model, self.assertRaises(analysis.AnalysisError):
                analysis.analyze_meeting({"text": "айгуль подготовьте отчет до завтра"},
                                         meeting_date=ANCHOR, as_of=ANCHOR)
            self.assertEqual(model.call_count, 2)

    def test_structural_errors_and_large_repair_context_are_not_retried(self):
        cases = [[task(completed="false")], [task("я" * 2500) for _ in range(3)]]
        for items in cases:
            with self.subTest(count=len(items)), patch.object(
                analysis, "_request_llama_tasks", return_value=items
            ) as model, self.assertRaises(analysis.AnalysisError):
                analysis.analyze_meeting({"text": "айгуль подготовьте отчет до завтра"},
                                         meeting_date=ANCHOR, as_of=ANCHOR)
            model.assert_called_once()

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
        with patch.object(analysis, "_request_llama_tasks") as request:
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
        with patch.object(analysis, "_request_llama_tasks", return_value=[]) as request:
            result = analysis.analyze_meeting(transcript, meeting_date=ANCHOR, as_of=ANCHOR)
        self.assertEqual(request.call_count, len(analysis._chunks(transcript)))
        self.assertTrue(any("фрагмент" in warning for warning in result["warnings"]))


class LocalLlamaTransportTests(unittest.TestCase):
    def response(self, content, finish_reason="stop"):
        return self.raw_response(json.dumps({"choices": [{
            "finish_reason": finish_reason, "message": {"role": "assistant", "content": content},
        }]}).encode())

    def raw_response(self, payload):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = payload
        return response

    def test_configured_urls_schema_nonstreaming_and_disabled_thinking(self):
        for url in ("http://localhost:8080/", "http://localhost:8080/v1", "http://localhost:8080/v1/"):
            with self.subTest(url=url), patch.object(analysis, "urlopen", return_value=self.response('{"tasks": []}')) as request:
                result = analysis._request_llama_tasks([{"text": "начинаем", "speaker": None}], ANCHOR,
                                                       url, "gemma-4-12b-it-Q4_K_S", 42)
            self.assertEqual(result, [])
            sent = request.call_args.args[0]
            self.assertEqual(sent.full_url, "http://localhost:8080/v1/chat/completions")
            self.assertEqual(sent.get_method(), "POST")
            body = json.loads(sent.data)
            self.assertEqual(body["model"], "gemma-4-12b-it-Q4_K_S")
            self.assertFalse(body["stream"])
            self.assertEqual(body["response_format"], {"type": "json_schema", "json_schema": {
                "name": "meeting_tasks", "strict": True, "schema": analysis.TASK_SCHEMA,
            }})
            self.assertEqual(body["chat_template_kwargs"], {"enable_thinking": False})
            self.assertEqual(request.call_args.kwargs["timeout"], 42)

    def test_evidence_repair_schema_cannot_replace_or_drop_actions(self):
        proposed = [{"title": "Подготовить отчет", "source_quote": "айгуль, подготовьте отчет",
                     "deadline_text": None, "validation_error": "ungrounded task"}]
        content = '{"tasks": [{"source_quote": null, "deadline_text": null}]}'
        with patch.object(analysis, "urlopen", return_value=self.response(content)) as request:
            result = analysis._request_llama_tasks([{"text": "айгуль подготовьте отчет", "speaker": None}],
                                                   ANCHOR, "http://localhost:8080", "model", 42,
                                                   repair_requests=proposed)
        self.assertEqual(result, [{"source_quote": None, "deadline_text": None}])
        body = json.loads(request.call_args.args[0].data)
        array = body["response_format"]["json_schema"]["schema"]["properties"]["tasks"]
        self.assertEqual((array["minItems"], array["maxItems"]), (1, 1))
        self.assertFalse(array["items"]["additionalProperties"])
        self.assertEqual(set(array["items"]["properties"]), {"source_quote", "deadline_text"})
        self.assertEqual(json.loads(body["messages"][1]["content"])["proposed_tasks"], proposed)

    def test_default_provider_uses_q4_k_s_model(self):
        transcript = {"text": "начинаем"}
        with patch.object(analysis, "_request_llama_tasks", return_value=[]) as request:
            result = analysis.analyze_meeting(transcript, meeting_date=ANCHOR, as_of=ANCHOR)
        request.assert_called_once_with(analysis._chunks(transcript)[0], ANCHOR,
                                        "http://127.0.0.1:8080", "gemma-4-12b-it-Q4_K_S", 600)
        self.assertEqual(result["analysis_method"], "local_llama:gemma-4-12b-it-Q4_K_S")

    def test_unsupported_provider_fails_without_network_request(self):
        with patch.object(analysis, "urlopen") as request, self.assertRaises(analysis.AnalysisError):
            analysis.analyze_meeting({"text": "начинаем"}, meeting_date=ANCHOR, as_of=ANCHOR,
                                     provider="unsupported")
        request.assert_not_called()

    def test_invalid_server_url_fails_before_network_request(self):
        for url in ("file:///private/model", "localhost:8080", "http://", "http://[",
                    "http://localhost:8080?key=private", "http://localhost:8080#private"):
            with self.subTest(url=url), patch.object(analysis, "urlopen") as request:
                with self.assertRaises(analysis.AnalysisError):
                    analysis.analyze_meeting({"text": "начинаем"}, meeting_date=ANCHOR, as_of=ANCHOR,
                                             llama_url=url)
                request.assert_not_called()

    def test_connection_timeout_and_http_failures_have_no_fallback(self):
        failures = [URLError("secret-network-details"), TimeoutError("private-details"),
                    OSError("private-details"), HTTPError("private", 404, "not found", {}, None),
                    HTTPError("private", 503, "loading", {}, None), HTTPError("private", 400, "bad request", {}, None)]
        for failure in failures:
            with self.subTest(failure=failure), patch.object(analysis, "urlopen", side_effect=failure) as request:
                with self.assertRaises(analysis.AnalysisError) as raised:
                    analysis.analyze_meeting({"text": "тест"}, meeting_date=ANCHOR, as_of=ANCHOR)
                request.assert_called_once()
                self.assertIn("llama.cpp", str(raised.exception))
                self.assertNotIn("private", str(raised.exception))
                self.assertNotIn("secret", str(raised.exception))

    def test_invalid_or_truncated_model_content_is_rejected(self):
        for content, finish_reason in [("not json", "stop"), ("[]", "stop"), (None, "stop"),
                                       ('{"tasks": []}', "length"), ('{"tasks": []}', None)]:
            with self.subTest(content=content, finish_reason=finish_reason), patch.object(
                analysis, "urlopen", return_value=self.response(content, finish_reason)
            ):
                with self.assertRaises(analysis.AnalysisError):
                    analysis.analyze_meeting({"text": "тест"}, meeting_date=ANCHOR, as_of=ANCHOR)

    def test_malformed_response_envelopes_and_oversized_responses_are_rejected(self):
        payloads = [b"not json", b"[]", b"{}", b'{"choices": []}', b'{"choices": [null]}',
                    b'{"choices": [{}, {}]}', b'{"choices": [{"finish_reason": "stop"}]}',
                    b" " * 2_000_001]
        for payload in payloads:
            with self.subTest(size=len(payload), prefix=payload[:80]), patch.object(
                analysis, "urlopen", return_value=self.raw_response(payload)
            ):
                with self.assertRaises(analysis.AnalysisError):
                    analysis.analyze_meeting({"text": "тест"}, meeting_date=ANCHOR, as_of=ANCHOR)


if __name__ == "__main__":
    unittest.main()
