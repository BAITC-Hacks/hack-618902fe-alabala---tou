"""Real Flask JSON -> real browser adapter; only GPU/LLM I/O is mocked.

Uses synthetic statements, no models, network, microphone or user recordings.
The actual Python task validator and JavaScript adapter both run in these tests.
"""

from copy import deepcopy
from datetime import datetime, timezone
from io import BytesIO
import json
import shutil
import subprocess
import unittest
from unittest.mock import patch

import meeting_analysis
import server


NODE_ADAPTER = """
const {fromReport} = require('./backend-api.js');
const storage = require('./protocol-storage.js');
const exports = require('./protocol-export.js');
const assert = require('node:assert/strict');
const report = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const adapted = fromReport(report);
const restored = storage.parse(storage.serialize({
  type:'qorit-draft', version:1, sourceText:adapted.sourceText, sourceDirty:false,
  metadata:{title:'Контракт', meetingDate:adapted.metadata.meetingDate},
  importedUtterances:adapted.result.utterances, result:adapted.result
}));
assert.deepEqual(restored.result.tasks, adapted.result.tasks);
assert.deepEqual(restored.result.utterances, adapted.result.utterances);
assert.equal(restored.result.method, 'server');
assert.equal(restored.result.analysisMethod, adapted.result.analysisMethod);
assert.equal(restored.result.reportTimezone, adapted.result.reportTimezone);
assert.match(exports.createPrintHtml(restored.result,restored.metadata), /Источник анализа: сервер/);
assert.ok(exports.createDocx(restored.result,restored.metadata).length > 0);
process.stdout.write(JSON.stringify(adapted));
"""

STATEMENTS = (
    "Әлия, дайындаңыз есепті до 25 сентября.",
    "Нужно подготовить список участников.",
    "Ерлан, проект договора подготовлен до 22 сентября.",
    "Асель, передайте смету до 21 сентября.",
)
TRANSCRIPT = {
    "text": " ".join(STATEMENTS), "duration": 80,
    "segments": [
        {"text": text, "speaker": f"SPEAKER_{index:02d}",
         "start": index * 20 + 0.25, "end": index * 20 + 19.5}
        for index, text in enumerate(STATEMENTS)
    ],
    "speakers": [f"SPEAKER_{index:02d}" for index in range(4)],
}


def raw_task(index, title, assignee=None, deadline=None, deadline_text=None,
             completed=False, completion_quote=None, direction="general"):
    return {
        "title": title, "assignee": assignee, "deadline": deadline,
        "deadline_text": deadline_text, "completed": completed,
        "completion_quote": completion_quote, "urgency": "medium",
        "direction": direction, "source_quote": STATEMENTS[index],
        "needs_review": False,
    }


RAW_TASKS = [
    raw_task(0, "Дайындау есеп", "Әлия", "2026-09-25", "до 25 сентября", direction="finance"),
    raw_task(1, "Подготовить список участников"),
    raw_task(2, "Подготовить проект договора", "Ерлан", "2026-09-22", "до 22 сентября",
             completed=True, completion_quote="проект договора подготовлен", direction="legal"),
    raw_task(3, "Передать смету", "Асель", "2026-09-21", "до 21 сентября", direction="finance"),
]


@unittest.skipUnless(shutil.which("node"), "Node.js is required for the real frontend adapter")
class FrontendContractTests(unittest.TestCase):
    def setUp(self):
        self.app = server.create_app({
            "TESTING": True, "STT_DIARIZE": True, "APP_TIMEZONE": "Asia/Almaty",
            "LLM_PROVIDER": "ollama", "OLLAMA_MODEL": "contract-test",
        })
        self.client = self.app.test_client()

    def process(self, *, transcript=None, raw_tasks=None, diarize=True):
        transcript = deepcopy(TRANSCRIPT if transcript is None else transcript)
        raw_tasks = deepcopy(RAW_TASKS if raw_tasks is None else raw_tasks)
        with patch.object(server, "normalize_audio") as normalize, \
                patch.object(server, "transcribe_audio", return_value=transcript) as transcribe, \
                patch.object(meeting_analysis, "_request_tasks", return_value=raw_tasks) as llm, \
                patch.object(meeting_analysis, "urlopen", side_effect=AssertionError("Network disabled")) as network, \
                patch.object(server, "datetime", wraps=datetime) as clock:
            clock.now.return_value = datetime(2026, 9, 23, 10, 0, tzinfo=timezone.utc)
            response = self.client.post("/process-audio", data={
                "audio": (BytesIO(b"synthetic audio fixture"), "Тестовое совещание.wav"),
                "meeting_date": "2026-09-23", "diarize": str(diarize).lower(),
            })
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        normalize.assert_called_once()
        transcribe.assert_called_once()
        self.assertEqual(transcribe.call_args.kwargs, {"diarize": diarize, "num_speakers": None})
        llm.assert_called_once()
        network.assert_not_called()
        self.assertEqual(response.mimetype, "application/json")
        return response.get_json()

    def adapt(self, report):
        process = subprocess.run(
            [shutil.which("node"), "-e", NODE_ADAPTER],
            input=json.dumps(report, ensure_ascii=False), text=True,
            capture_output=True, cwd=server.BASE_DIR, timeout=15,
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        return json.loads(process.stdout)

    def test_real_report_preserves_metadata_quotes_speakers_dates_and_status(self):
        report = self.process()
        adapted = self.adapt(report)
        result, metadata = adapted["result"], adapted["metadata"]
        self.assertEqual(adapted["sourceText"], TRANSCRIPT["text"])
        self.assertEqual(result["method"], "server")
        self.assertEqual(result["analysisMethod"], "ollama:contract-test")
        self.assertEqual(metadata, {
            "meetingDate": "2026-09-23", "filename": "Тестовое совещание.wav",
            "asOf": "2026-09-23", "timezone": "Asia/Almaty",
            "generatedAt": "2026-09-23T10:00:00+00:00", "analysisMethod": "ollama:contract-test",
        })
        self.assertEqual(result["reportDate"], report["as_of"])
        self.assertEqual(result["reportTimezone"], report["timezone"])
        self.assertEqual([person[0] for person in result["people"]], TRANSCRIPT["speakers"])
        self.assertEqual(result["utterances"][3]["time"], "01:00")
        for index, (original, task) in enumerate(zip(report["tasks"], result["tasks"])):
            with self.subTest(index=index):
                self.assertEqual(task["id"], original["id"])
                self.assertEqual(task["title"], original["title"])
                self.assertEqual(task["source"], original["source_quote"])
                self.assertEqual(task["sourceSpeaker"], original["source_speaker"])
                self.assertEqual(task["sourceIndex"], index)
                self.assertEqual(task["dueDate"], original["deadline"] or "")
                self.assertEqual(task["urgency"], original["urgency"])
                self.assertEqual(task["direction"], original["direction"])
                self.assertEqual(task["serverStatus"], original["status"])
                self.assertFalse(task["reviewed"])
        self.assertEqual(result["tasks"][0]["owner"], "Әлия")
        self.assertEqual(result["tasks"][0]["status"], "В работе")
        self.assertEqual(result["tasks"][2]["status"], "Выполнено")
        self.assertEqual(result["tasks"][3]["serverStatus"], "overdue")
        self.assertEqual(result["tasks"][3]["status"], "В работе")
        self.assertEqual(result["tasks"][3]["dueDate"], "2026-09-21")
        self.assertNotIn("summary", report)
        self.assertIn("Развёрнутое саммари backend не возвращает", result["summary"])
        self.assertEqual(result["stats"]["tasks"], report["dashboard"]["total"])

    def test_nullable_assignment_and_deadline_are_not_replaced_by_speaker_or_guesses(self):
        report = self.process()
        original = report["tasks"][1]
        self.assertIsNone(original["assignee"])
        self.assertIsNone(original["deadline"])
        self.assertIsNone(original["deadline_text"])
        task = self.adapt(report)["result"]["tasks"][1]
        self.assertEqual(task["owner"], "Не указан")
        self.assertEqual(task["dueDate"], "")
        self.assertEqual(task["due"], "Не указан")
        self.assertEqual(task["sourceSpeaker"], "SPEAKER_01")
        self.assertTrue(task["needsReview"])
        self.assertFalse(task["reviewed"])

    def test_non_diarized_report_retains_full_text_without_inventing_people(self):
        transcript = {"text": STATEMENTS[0], "duration": 20, "segments": [], "speakers": []}
        report = self.process(transcript=transcript, raw_tasks=[RAW_TASKS[0]], diarize=False)
        self.assertIsNone(report["tasks"][0]["source_speaker"])
        adapted = self.adapt(report)
        self.assertEqual(adapted["sourceText"], STATEMENTS[0])
        self.assertEqual(adapted["result"]["people"], [])
        self.assertEqual(adapted["result"]["utterances"][0]["speaker"], "Не указан")
        self.assertEqual(adapted["result"]["tasks"][0]["owner"], "Әлия")
        self.assertIsNone(adapted["result"]["tasks"][0]["sourceSpeaker"])
        self.assertTrue(any("Диаризация" in message for message in adapted["result"]["warnings"]))


if __name__ == "__main__":
    unittest.main()
