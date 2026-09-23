"""Report content and pagination regressions; no STT models or GPU required."""

import copy
import os
import re
import threading
import time
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from unittest.mock import patch
from xml.etree import ElementTree

from report_exports import ReportFontError, render_docx, render_pdf


def sample_result():
    return {
        "filename": "Совещание №1.mp3", "meeting_date": "2026-09-23",
        "as_of": "2026-09-24", "timezone": "Asia/Qyzylorda",
        "generated_at": "2026-09-23T10:15:00+00:00", "analysis_method": "rules",
        "transcript": {"text": "Әлия, подготовьте отчёт <бюджет> & риски.\nҚазақ тілі: Ә Ғ Қ Ң Ө Ұ Ү Һ І.", "segments": []},
        "tasks": [{
            "id": "task-001", "title": "Подготовить отчёт <бюджет> & риски",
            "assignee": "Әлия", "deadline": "2026-09-25", "deadline_text": "до пятницы",
            "status": "in_progress", "urgency": "high", "direction": "finance",
            "source_quote": "Әлия, подготовьте отчёт <бюджет> & риски.",
            "source_speaker": "SPEAKER_01", "needs_review": True,
        }],
        "dashboard": {"total": 1, "by_status": {"in_progress": 1, "overdue": 0, "completed": 0},
                      "by_urgency": {"high": 1, "medium": 0, "low": 0},
                      "by_direction": {"finance": 1}, "needs_review": 1},
        "warnings": ["Требуется уточнить ответственного & срок."],
    }


def docx_text(data):
    with zipfile.ZipFile(BytesIO(data)) as archive:
        root = ElementTree.fromstring(archive.read("word/document.xml"))
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    return "\n".join("".join(paragraph.itertext()) for paragraph in root.findall(".//w:p", ns))


class ReportExportTests(unittest.TestCase):
    def test_docx_contains_dashboard_all_task_fields_and_unicode(self):
        text = docx_text(render_docx(sample_result()))
        for expected in ("Совещание №1.mp3", "2026-09-23", "task-001", "Әлия", "2026-09-25",
                         "до пятницы", "В работе", "Просрочено", "Выполнено", "Высокая", "Финансы",
                         "Требует проверки: Да", "SPEAKER_01", "<бюджет> & риски",
                         "Статусы актуальны на: 2026-09-24", "Часовой пояс: Asia/Qyzylorda",
                         "Қазақ тілі: Ә Ғ Қ Ң Ө Ұ Ү Һ І.", "Требуется уточнить ответственного & срок."):
            self.assertIn(expected, text)

    def test_pdf_is_real_pdf_with_embedded_unicode_font(self):
        data = render_pdf(sample_result())
        self.assertTrue(data.startswith(b"%PDF-"))
        self.assertTrue(data.rstrip().endswith(b"%%EOF"))
        self.assertIn(b"/FontFile2", data)
        self.assertIn(b"/ToUnicode", data)

    def test_long_content_paginates_without_losing_docx_text(self):
        result = sample_result()
        result["tasks"][0]["source_quote"] = "Длинное поручение & уточнение. " * 800
        result["transcript"]["text"] = "Начало расшифровки. " + "Обсуждение бюджета. " * 1200 + "Последняя фраза."
        pdf = render_pdf(result)
        self.assertGreater(len(re.findall(rb"/Type\s*/Page\b", pdf)), 4)
        text = docx_text(render_docx(result))
        self.assertIn(result["tasks"][0]["source_quote"], text)
        self.assertIn(result["transcript"]["text"], text)

    def test_no_tasks_and_missing_fields_are_explicit(self):
        result = sample_result()
        result["tasks"] = []
        result["dashboard"] = {}
        result["transcript"]["text"] = ""
        text = docx_text(render_docx(result))
        self.assertIn("Поручения не обнаружены.", text)
        self.assertIn("Расшифровка отсутствует.", text)
        result["tasks"] = [{"title": "Уточнить детали", "needs_review": True}]
        text = docx_text(render_docx(result))
        self.assertIn("Ответственный: Не указан", text)
        self.assertIn("Срок: Не указан", text)

    def test_xml_control_characters_do_not_break_exports(self):
        result = sample_result()
        result["tasks"][0]["title"] = "Отчёт\x00\x0b\ud800 <тест> & детали"
        text = docx_text(render_docx(result))
        self.assertIn("Отчёт <тест> & детали", text)
        self.assertTrue(render_pdf(result).startswith(b"%PDF-"))

    def test_invalid_configured_fonts_fail_with_actionable_error(self):
        with patch.dict(os.environ, {"REPORT_FONT_PATH": "/missing/report-font.ttf"}):
            for render in (render_pdf, render_docx):
                with self.assertRaisesRegex(ReportFontError, "REPORT_FONT_PATH"):
                    render(sample_result())

    def test_parallel_exports_do_not_mix_request_contents_or_mutate_input(self):
        original = sample_result()
        unchanged = copy.deepcopy(original)

        def export(index):
            result = copy.deepcopy(original)
            result["filename"] = f"unique-request-{index}.mp3"
            return render_pdf(result), docx_text(render_docx(result))

        with ThreadPoolExecutor(max_workers=4) as pool:
            outputs = list(pool.map(export, range(4)))
        for index, (pdf, text) in enumerate(outputs):
            self.assertTrue(pdf.startswith(b"%PDF-"))
            self.assertIn(f"unique-request-{index}.mp3", text)
            for other in set(range(4)) - {index}:
                self.assertNotIn(f"unique-request-{other}.mp3", text)
        self.assertEqual(original, unchanged)

    def test_pdf_requests_do_not_subset_shared_fonts_concurrently(self):
        from reportlab.pdfbase.ttfonts import TTFontFile

        original_subset = TTFontFile.makeSubset
        guard = threading.Lock()
        active = 0
        peak = 0

        def tracked_subset(font, *args, **kwargs):
            nonlocal active, peak
            with guard:
                active += 1
                peak = max(peak, active)
            try:
                # Give concurrent requests a chance to reach the unsafe parser.
                time.sleep(0.01)
                return original_subset(font, *args, **kwargs)
            finally:
                with guard:
                    active -= 1

        with patch.object(TTFontFile, "makeSubset", tracked_subset):
            with ThreadPoolExecutor(max_workers=4) as pool:
                outputs = list(pool.map(lambda _: render_pdf(sample_result()), range(4)))
        self.assertEqual(peak, 1)
        self.assertTrue(all(data.startswith(b"%PDF-") for data in outputs))


if __name__ == "__main__":
    unittest.main()
