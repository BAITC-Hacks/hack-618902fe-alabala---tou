"""HTTP contract tests: real exports and decoding, fake GPU/LLM boundaries."""

from copy import deepcopy
from datetime import date
from io import BytesIO
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import wave

from docx import Document
from pypdf import PdfReader

import meeting_analysis
import server


TRANSCRIPT = {"text": "Айгуль, подготовьте отчёт до завтра", "duration": 2, "segments": []}
ANALYSIS = {
    "analysis_method": "local_llama:test", "warnings": [],
    "tasks": [{"id": "task-0001", "title": "Подготовить отчёт", "assignee": "Айгуль",
               "deadline": "2026-09-24", "deadline_text": "до завтра", "status": "in_progress",
               "urgency": "high", "direction": "finance", "source_quote": TRANSCRIPT["text"],
               "source_speaker": None, "needs_review": False}],
    "dashboard": {"total": 1, "by_status": {"in_progress": 1, "overdue": 0, "completed": 0},
                  "by_urgency": {"high": 1, "medium": 0, "low": 0},
                  "by_direction": {"finance": 1}, "needs_review": 0},
}
ROUTES = ("/process-audio", "/process-audio-pdf", "/process-audio-docx")


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.app = server.create_app({"TESTING": True, "STT_DIARIZE": True})
        self.app.logger.disabled = True
        self.addCleanup(setattr, self.app.logger, "disabled", False)
        self.client = self.app.test_client()
        self.paths = []

        def normalize(source, target):
            self.assertEqual(source.read_bytes(), b"audio fixture")
            self.paths.append(source.parent)
            target.write_bytes(b"decoded")

        for name, options in (
            ("normalize_audio", {"side_effect": normalize}),
            ("transcribe_audio", {"return_value": TRANSCRIPT}),
            ("analyze_meeting", {"side_effect": lambda *a, **kw: deepcopy(ANALYSIS)}),
        ):
            patcher = patch.object(server, name, **options)
            setattr(self, name, patcher.start())
            self.addCleanup(patcher.stop)

    def post(self, route=ROUTES[0], **fields):
        data = {"audio": (BytesIO(b"audio fixture"), "Совещание.mp3"), "meeting_date": "2026-09-23"}
        data.update(fields)
        return self.client.post(route, data=data, buffered=True)

    def test_json_contains_analysis_and_original_transcript(self):
        response = self.post(num_speakers="3")
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["tasks"], ANALYSIS["tasks"])
        self.assertEqual(data["dashboard"], ANALYSIS["dashboard"])
        self.assertEqual(data["transcript"], TRANSCRIPT)
        self.assertEqual(data["meeting_date"], "2026-09-23")
        self.assertEqual(data["filename"], "Совещание.mp3")
        self.assertEqual(self.analyze_meeting.call_args.kwargs["meeting_date"], date(2026, 9, 23))
        self.assertEqual(self.transcribe_audio.call_args.kwargs, {"diarize": True, "num_speakers": 3})
        self.assertIn("no-store", response.headers["Cache-Control"])
        self.assertTrue(all(not path.exists() for path in self.paths))

    def test_real_pdf_download_has_report_and_unicode_text(self):
        response = self.post(ROUTES[1])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "application/pdf")
        self.assertIn("attachment", response.headers["Content-Disposition"])
        self.assertTrue(response.data.startswith(b"%PDF-"))
        text = " ".join(page.extract_text() for page in PdfReader(BytesIO(response.data)).pages)
        for expected in ("Айгуль", "2026-09-24", "В работе", "Подготовить отчёт"):
            self.assertIn(expected, text)

    def test_real_docx_download_is_readable_after_temp_cleanup(self):
        response = self.post(ROUTES[2])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        self.assertIn("meeting-report.docx", response.headers["Content-Disposition"])
        document = Document(BytesIO(response.data))
        text = "\n".join(p.text for p in document.paragraphs)
        self.assertIn("Айгуль", text)
        self.assertIn("Подготовить отчёт", text)
        self.assertTrue(all(not path.exists() for path in self.paths))

    def test_all_routes_use_same_pipeline_once(self):
        for route in ROUTES:
            self.assertEqual(self.post(route).status_code, 200)
        self.assertEqual(self.transcribe_audio.call_count, 3)
        self.assertEqual(self.analyze_meeting.call_count, 3)

    def test_all_routes_forward_local_llama_configuration(self):
        self.app.config.update(LLM_PROVIDER="local_llama", LLAMA_URL="http://127.0.0.1:8091",
                               LLAMA_MODEL="gemma-4-12b-it-Q4_K_S", LLAMA_TIMEOUT=321)
        for route in ROUTES:
            with self.subTest(route=route):
                self.analyze_meeting.reset_mock()
                response = self.post(route)
                self.assertEqual(response.status_code, 200)
                self.analyze_meeting.assert_called_once()
                self.assertEqual(self.analyze_meeting.call_args.args, (TRANSCRIPT,))
                self.assertEqual(self.analyze_meeting.call_args.kwargs, {
                    "meeting_date": date(2026, 9, 23),
                    "as_of": self.analyze_meeting.call_args.kwargs["as_of"],
                    "provider": "local_llama", "llama_url": "http://127.0.0.1:8091",
                    "llama_model": "gemma-4-12b-it-Q4_K_S", "timeout": 321,
                })

    def test_api_routes_remain_post_only(self):
        frontend_routes = {"/", "/index.html", "/favicon.ico", "/api/config"}
        frontend_routes.update(f"/{filename}" for filename in server.FRONTEND_ASSETS)
        self.assertEqual({rule.rule for rule in self.app.url_map.iter_rules()}, set(ROUTES) | frontend_routes)
        for route in ROUTES:
            self.assertEqual(self.client.get(route).status_code, 405)
            response = self.client.post(route)
            self.assertEqual(response.status_code, 400)
            self.assertIn("error", response.get_json())
        self.transcribe_audio.assert_not_called()

    def test_frontend_and_assets_are_served_on_api_origin(self):
        for route in ("/", "/index.html"):
            with self.subTest(route=route):
                response = self.client.get(route)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.mimetype, "text/html")
                self.assertEqual(response.data, (server.BASE_DIR / "index.html").read_bytes())
                self.assertEqual(response.headers["Cache-Control"], "no-store")
                self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
                response.close()
        for filename, mimetype in server.FRONTEND_ASSETS.items():
            with self.subTest(filename=filename):
                response = self.client.get(f"/{filename}?v=latest")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.mimetype, mimetype)
                self.assertEqual(response.data, (server.BASE_DIR / filename).read_bytes())
                self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
                response.close()
        self.assertEqual(self.client.get("/favicon.ico").status_code, 204)
        self.transcribe_audio.assert_not_called()
        self.analyze_meeting.assert_not_called()

    def test_frontend_does_not_expose_private_repository_files(self):
        routes = (
            "/.env", "/.env.example", "/.git/config", "/server.py", "/README.md",
            "/tests/test_server.py", "/models/model.bin", "/media/meeting.mp3",
            "/results/report.json", "/static/.env", "/static/../.env",
            "/%2eenv", "/%2egit/config", "/%2e%2e/.env", "/%2e%2e%2f.env",
            "/app.js/../.env", "/styles.css%2f..%2f.env", "/%252e%252e%252f.env",
        )
        for route in routes:
            with self.subTest(route=route):
                response = self.client.get(route)
                self.assertEqual(response.status_code, 404)
                self.assertIn("error", response.get_json())
        for route in ("/", "/index.html", "/app.js", "/api/config"):
            self.assertEqual(self.client.post(route).status_code, 405)

    def test_public_config_contains_only_limits_and_diarization_default(self):
        self.app.config.update(MAX_CONTENT_LENGTH=123456, MAX_AUDIO_SECONDS=456,
                               STT_DIARIZE="false", LLAMA_URL="http://secret-internal-host:8080")
        response = self.client.get("/api/config")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {
            "max_upload_bytes": 123456, "max_audio_seconds": 456, "default_diarize": False,
        })
        self.assertNotIn("secret-internal-host", response.get_data(as_text=True))
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        for value in (True, "true", "1"):
            self.app.config["STT_DIARIZE"] = value
            self.assertIs(self.client.get("/api/config").get_json()["default_diarize"], True)
        self.transcribe_audio.assert_not_called()

    def test_invalid_fields_fail_before_inference(self):
        cases = [({"audio": (BytesIO(b"x"), "")}, 400),
                 ({"audio": (BytesIO(), "empty.wav")}, 400),
                 ({"audio": (BytesIO(b"x"), "malware.exe")}, 415),
                 ({"meeting_date": "2026-02-31"}, 400),
                 ({"meeting_date": "20260923"}, 400),
                 ({"diarize": "maybe"}, 400),
                 ({"num_speakers": "0"}, 400),
                 ({"num_speakers": "2.5"}, 400),
                 ({"num_speakers": "9" * 5000}, 400),
                 ({"num_speakers": "2", "diarize": "false"}, 400)]
        for fields, status in cases:
            with self.subTest(fields=list(fields)):
                self.assertEqual(self.post(**fields).status_code, status)
        self.transcribe_audio.assert_not_called()

    def test_upload_size_limit_is_json_on_each_route(self):
        self.app.config["MAX_CONTENT_LENGTH"] = 20
        for route in ROUTES:
            response = self.post(route)
            self.assertEqual(response.status_code, 413)
            self.assertIn("error", response.get_json())

    def test_busy_gpu_returns_retryable_error(self):
        with server._PIPELINE_LOCK:
            response = self.post()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.headers["Retry-After"], "30")
        self.transcribe_audio.assert_not_called()

    def test_failure_does_not_leak_traceback_or_hold_gpu_lock(self):
        self.analyze_meeting.side_effect = RuntimeError("SECRET TRACEBACK")
        response = self.post()
        self.assertEqual(response.status_code, 500)
        self.assertNotIn("SECRET", response.get_data(as_text=True))
        self.assertFalse(server._PIPELINE_LOCK.locked())
        self.assertTrue(all(not path.exists() for path in self.paths))

    def test_analysis_failure_is_json_for_download_route(self):
        self.analyze_meeting.side_effect = server.AnalysisError("llama.cpp недоступна")
        response = self.post(ROUTES[1])
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.get_json(), {"error": "llama.cpp недоступна"})

    def test_missing_meeting_date_is_explicit_and_diarization_optional(self):
        response = self.post(meeting_date="", diarize="false")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["warnings"])
        self.assertEqual(self.transcribe_audio.call_args.kwargs["diarize"], False)

    def test_upload_path_is_not_used_as_storage_path(self):
        response = self.post(audio=(BytesIO(b"audio fixture"), "../../private.wav"))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["filename"], "private.wav")
        self.assertEqual(self.normalize_audio.call_args.args[0].name, "input.wav")


class ConfigurationTests(unittest.TestCase):
    def test_no_environment_defaults_to_q4_k_s_local_llama(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(server, "load_dotenv"):
            app = server.create_app({"TESTING": True})
        self.assertEqual(app.config["LLM_PROVIDER"], "local_llama")
        self.assertEqual(app.config["LLAMA_URL"], "http://127.0.0.1:8080")
        self.assertEqual(app.config["LLAMA_MODEL"], "gemma-4-12b-it-Q4_K_S")
        self.assertEqual(app.config["LLAMA_TIMEOUT"], 600)

    def test_environment_configuration_is_preserved(self):
        settings = {
            "LLM_PROVIDER": "local_llama", "LLAMA_URL": "http://127.0.0.1:8092/v1",
            "LLAMA_MODEL": "test-alias", "LLAMA_TIMEOUT": "432.5",
        }
        with patch.dict(os.environ, settings, clear=True), patch.object(server, "load_dotenv"):
            app = server.create_app({"TESTING": True})
        for key in ("LLM_PROVIDER", "LLAMA_URL", "LLAMA_MODEL"):
            self.assertEqual(app.config[key], settings[key])
        self.assertEqual(app.config["LLAMA_TIMEOUT"], 432.5)


class AdapterTests(unittest.TestCase):
    def test_json_route_uses_real_analysis_and_llama_chat_response(self):
        app = server.create_app({
            "TESTING": True, "LLM_PROVIDER": "local_llama",
            "LLAMA_URL": "http://127.0.0.1:8093", "LLAMA_MODEL": "gemma-4-12b-it-Q4_K_S",
            "LLAMA_TIMEOUT": 123,
        })
        raw_task = {
            "title": "Подготовить отчёт", "assignee": "Айгуль", "deadline": "2026-09-24",
            "deadline_text": "до завтра", "completed": False, "completion_quote": None,
            "urgency": "medium", "direction": "finance", "source_quote": TRANSCRIPT["text"],
            "needs_review": False,
        }
        payload = {"choices": [{"finish_reason": "stop", "message": {
            "content": json.dumps({"tasks": [raw_task]}, ensure_ascii=False),
        }}]}
        with patch.object(server, "normalize_audio"), \
                patch.object(server, "transcribe_audio", return_value=TRANSCRIPT), \
                patch.object(meeting_analysis, "urlopen", return_value=BytesIO(json.dumps(payload).encode())) as network:
            response = app.test_client().post("/process-audio", data={
                "audio": (BytesIO(b"audio fixture"), "meeting.wav"),
                "meeting_date": "2026-09-23", "diarize": "false",
            })
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        report = response.get_json()
        self.assertEqual(report["analysis_method"], "local_llama:gemma-4-12b-it-Q4_K_S")
        self.assertEqual(report["dashboard"]["total"], 1)
        self.assertEqual(report["tasks"][0]["assignee"], "Айгуль")
        self.assertEqual(report["tasks"][0]["deadline"], "2026-09-24")
        self.assertEqual(report["tasks"][0]["source_quote"], TRANSCRIPT["text"])
        network.assert_called_once()
        request = network.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:8093/v1/chat/completions")
        self.assertEqual(network.call_args.kwargs, {"timeout": 123})
        sent = json.loads(request.data)
        self.assertEqual(sent["model"], "gemma-4-12b-it-Q4_K_S")
        self.assertEqual(sent["response_format"]["type"], "json_schema")
        self.assertEqual(json.loads(sent["messages"][1]["content"])["meeting_date"], "2026-09-23")

    def test_speech_adapter_releases_model_after_success_and_failure(self):
        fake = SimpleNamespace(transcribe_diarized=Mock(return_value=TRANSCRIPT),
                               transcribe_with_timestamps=Mock(return_value=TRANSCRIPT), release_models=Mock())
        with patch.dict(sys.modules, {"stt_kazakh_russian": fake}):
            self.assertEqual(server.transcribe_audio(Path("a.wav"), diarize=True, num_speakers=2), TRANSCRIPT)
            fake.release_models.assert_called_once()
            fake.transcribe_diarized.side_effect = RuntimeError("GPU")
            with self.assertRaises(RuntimeError):
                server.transcribe_audio(Path("a.wav"), diarize=True, num_speakers=None)
            self.assertEqual(fake.release_models.call_count, 2)

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg not installed")
    def test_actual_ffmpeg_decodes_supported_containers_and_rejects_corrupt_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.wav"
            with wave.open(str(source), "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(16000)
                audio.writeframes(b"\0\0" * 1600)
            app = server.create_app({"TESTING": True})
            with app.app_context():
                server.normalize_audio(source, root / "decoded.wav")
                for extension in ("mp3", "flac", "ogg", "m4a", "webm"):
                    with self.subTest(extension=extension):
                        encoded = root / f"source.{extension}"
                        subprocess.run(["ffmpeg", "-v", "error", "-i", str(source), str(encoded)], check=True)
                        decoded = root / f"decoded-{extension}.wav"
                        server.normalize_audio(encoded, decoded)
                        self.assertGreater(decoded.stat().st_size, 44)
                corrupt = root / "corrupt.mp3"
                corrupt.write_bytes(b"not audio")
                with self.assertRaises(server.ProcessingError) as error:
                    server.normalize_audio(corrupt, root / "broken.wav")
                self.assertEqual(error.exception.status, 422)
                app.config["MAX_AUDIO_SECONDS"] = 0.05
                with self.assertRaises(server.ProcessingError) as error:
                    server.normalize_audio(source, root / "too-long.wav")
                self.assertEqual(error.exception.status, 413)

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg not installed")
    def test_actual_ffmpeg_rejects_playlist_disguised_as_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with wave.open(str(root / "private.wav"), "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(16000)
                audio.writeframes(b"\0\0" * 1600)
            disguised = root / "upload.mp3"
            disguised.write_text("ffconcat version 1.0\nfile 'private.wav'\n", encoding="utf-8")
            app = server.create_app({"TESTING": True})
            with app.app_context():
                with self.assertRaises(server.ProcessingError) as error:
                    server.normalize_audio(disguised, root / "decoded.wav")
            self.assertEqual(error.exception.status, 422)
            self.assertFalse((root / "decoded.wav").exists())


if __name__ == "__main__":
    unittest.main()
