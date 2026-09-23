"""HTTP API: audio -> local STT -> local LLM -> JSON / PDF / DOCX."""

from __future__ import annotations

from datetime import date, datetime, timezone
from io import BytesIO
import logging
import os
from pathlib import Path
import re
import subprocess
import tempfile
from threading import Lock
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from flask import Flask, current_app, jsonify, request, send_file
from werkzeug.exceptions import HTTPException

from meeting_analysis import AnalysisError, analyze_meeting
from report_exports import render_docx, render_pdf


BASE_DIR = Path(__file__).resolve().parent
AUDIO_DEMUXERS = {
    ".mp3": "mp3", ".wav": "wav", ".flac": "flac", ".ogg": "ogg",
    ".m4a": "mov", ".webm": "matroska",
}
ALLOWED_EXTENSIONS = set(AUDIO_DEMUXERS)
# Serialize the STT/LLM pipeline. Use one server process, not multiple workers.
_PIPELINE_LOCK = Lock()


class ProcessingError(Exception):
    def __init__(self, message: str, status: int = 500):
        super().__init__(message)
        self.status = status


def normalize_audio(source: Path, destination: Path) -> None:
    """Decode locally, including browser WebM and M4A, to STT-compatible WAV."""
    demuxer = AUDIO_DEMUXERS.get(source.suffix.lower())
    if demuxer is None:
        raise ProcessingError("Неподдерживаемый формат аудио.", 415)
    try:
        subprocess.run(
            [current_app.config["FFMPEG_BINARY"], "-nostdin", "-v", "error", "-y",
             # Do not auto-probe playlists or manifests disguised as audio.
             "-protocol_whitelist", "file,pipe", "-f", demuxer, "-i", str(source), "-vn",
             "-ac", "1", "-ar", "16000", "-t", str(current_app.config["MAX_AUDIO_SECONDS"] + 1),
             "-f", "wav", str(destination)],
            check=True, capture_output=True, timeout=current_app.config["AUDIO_DECODE_TIMEOUT"],
        )
    except FileNotFoundError as exc:
        raise ProcessingError("FFmpeg не установлен. Установите ffmpeg или задайте FFMPEG_BINARY.", 503) from exc
    except subprocess.TimeoutExpired as exc:
        raise ProcessingError("Превышено время декодирования аудио.", 422) from exc
    except subprocess.CalledProcessError as exc:
        raise ProcessingError("Не удалось прочитать аудио: файл повреждён или кодек не поддерживается.", 422) from exc
    import soundfile as sf
    try:
        info = sf.info(str(destination))
    except (RuntimeError, OSError) as exc:
        raise ProcessingError("Не удалось прочитать декодированное аудио.", 422) from exc
    if info.frames == 0:
        raise ProcessingError("Аудиозапись не содержит звука.", 422)
    if info.duration > current_app.config["MAX_AUDIO_SECONDS"]:
        raise ProcessingError("Запись превышает допустимую длительность (MAX_AUDIO_SECONDS).", 413)


def transcribe_audio(path: Path, *, diarize: bool, num_speakers: int | None) -> dict:
    # Starting the HTTP server does not load CUDA or models.
    import stt_kazakh_russian as stt
    try:
        if diarize:
            return stt.transcribe_diarized(path, num_speakers=num_speakers)
        result = stt.transcribe_with_timestamps(path)
        return {**result, "segments": [], "speakers": [], "speaker_turns": []}
    finally:
        stt.release_models()


def _boolean(value: str, name: str) -> bool:
    if value.lower() not in {"true", "false", "1", "0"}:
        raise ProcessingError(f"{name}: ожидается true или false.", 400)
    return value.lower() in {"true", "1"}


def _process_upload() -> dict:
    audio = request.files.get("audio")
    if audio is None:
        raise ProcessingError("Файл audio не передан. Используйте multipart/form-data.", 400)
    filename = (audio.filename or "").replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not filename:
        raise ProcessingError("Пустое имя файла.", 400)
    if any(ord(char) < 32 for char in filename):
        raise ProcessingError("Недопустимое имя файла.", 400)
    extension = Path(filename).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise ProcessingError("Неподдерживаемый формат аудио. Допустимы MP3, WAV, FLAC, OGG, M4A, WebM.", 415)
    now = datetime.now(timezone.utc)
    as_of = now.astimezone(ZoneInfo(current_app.config["APP_TIMEZONE"])).date()
    meeting_date_text = request.form.get("meeting_date", "").strip()
    meeting_date = as_of
    if meeting_date_text:
        try:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", meeting_date_text):
                raise ValueError
            meeting_date = date.fromisoformat(meeting_date_text)
        except ValueError as exc:
            raise ProcessingError("meeting_date: ожидается существующая дата YYYY-MM-DD.", 400) from exc
    diarize = _boolean(request.form.get("diarize", str(current_app.config["STT_DIARIZE"])), "diarize")
    num_speakers_text = request.form.get("num_speakers", "").strip()
    num_speakers = None
    if num_speakers_text:
        if len(num_speakers_text) > 3 or not num_speakers_text.isascii() or not num_speakers_text.isdigit() or not 1 <= int(num_speakers_text) <= 100:
            raise ProcessingError("num_speakers: ожидается целое число от 1 до 100.", 400)
        if not diarize:
            raise ProcessingError("num_speakers требует diarize=true.", 400)
        num_speakers = int(num_speakers_text)

    with tempfile.TemporaryDirectory(prefix="qorit-audio-") as temp_dir:
        source = Path(temp_dir) / f"input{extension}"
        audio.save(source)
        if source.stat().st_size == 0:
            raise ProcessingError("Передан пустой аудиофайл.", 400)
        if not _PIPELINE_LOCK.acquire(blocking=False):
            raise ProcessingError("Сервер обрабатывает другую запись. Повторите запрос позже.", 503)
        try:
            wav = Path(temp_dir) / "normalized.wav"
            normalize_audio(source, wav)
            try:
                transcript = transcribe_audio(wav, diarize=diarize, num_speakers=num_speakers)
            except (ImportError, FileNotFoundError, RuntimeError) as exc:
                current_app.logger.exception("Speech recognition failed")
                raise ProcessingError("Распознавание недоступно. Проверьте CUDA, локальные модели и окружение NeMo (Linux/WSL).", 503) from exc
            if not isinstance(transcript, dict) or not isinstance(transcript.get("text"), str):
                raise ProcessingError("Модуль распознавания вернул некорректный результат.", 502)
            analysis = analyze_meeting(
                transcript, meeting_date=meeting_date, as_of=as_of,
                provider=current_app.config["LLM_PROVIDER"],
                ollama_url=current_app.config["OLLAMA_URL"],
                ollama_model=current_app.config["OLLAMA_MODEL"],
                llama_url=current_app.config["LLAMA_URL"],
                llama_model=current_app.config["LLAMA_MODEL"],
                timeout=current_app.config[
                    "LLAMA_TIMEOUT" if current_app.config["LLM_PROVIDER"] == "local_llama" else "OLLAMA_TIMEOUT"
                ],
            )
        finally:
            _PIPELINE_LOCK.release()
    if not meeting_date_text:
        analysis["warnings"].append("Дата совещания не передана: относительные сроки рассчитаны от текущей даты.")
    return {
        "filename": filename, "meeting_date": meeting_date.isoformat(),
        "as_of": as_of.isoformat(), "timezone": current_app.config["APP_TIMEZONE"],
        "generated_at": datetime.now(timezone.utc).isoformat(), "transcript": transcript,
        **analysis,
    }


def create_app(config: dict | None = None) -> Flask:
    load_dotenv(BASE_DIR / ".env", override=False)
    app = Flask(__name__, static_folder=None)
    app.json.ensure_ascii = False
    app.config.from_mapping(
        MAX_CONTENT_LENGTH=int(os.getenv("MAX_UPLOAD_MB", "256")) * 1024 * 1024,
        MAX_AUDIO_SECONDS=float(os.getenv("MAX_AUDIO_SECONDS", "7200")),
        AUDIO_DECODE_TIMEOUT=float(os.getenv("AUDIO_DECODE_TIMEOUT", "300")),
        FFMPEG_BINARY=os.getenv("FFMPEG_BINARY", "ffmpeg"),
        APP_TIMEZONE=os.getenv("APP_TIMEZONE", "Asia/Qyzylorda"),
        STT_DIARIZE=os.getenv("STT_DIARIZE", "true"),
        LLM_PROVIDER=os.getenv("LLM_PROVIDER", "ollama"),
        OLLAMA_URL=os.getenv("OLLAMA_URL", "http://127.0.0.1:11434"),
        OLLAMA_MODEL=os.getenv("OLLAMA_MODEL", "Gemma-4-12B-it-Q6_K:latest"),
        OLLAMA_TIMEOUT=float(os.getenv("OLLAMA_TIMEOUT", "180")),
        LLAMA_URL=os.getenv("LLAMA_URL", "http://127.0.0.1:8080"),
        LLAMA_MODEL=os.getenv("LLAMA_MODEL", "gemma-4-12b-it"),
        LLAMA_TIMEOUT=float(os.getenv("LLAMA_TIMEOUT", "180")),
    )
    if config:
        app.config.update(config)
    ZoneInfo(app.config["APP_TIMEZONE"])

    @app.after_request
    def prevent_caching(response):
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.errorhandler(ProcessingError)
    def processing_error(exc):
        response = jsonify(error=str(exc))
        if exc.status == 503:
            response.headers["Retry-After"] = "30"
        return response, exc.status

    @app.errorhandler(AnalysisError)
    def analysis_error(exc):
        current_app.logger.warning("Meeting analysis failed: %s", exc)
        return jsonify(error=str(exc)), getattr(exc, "status_code", 502)

    @app.errorhandler(HTTPException)
    def http_error(exc):
        message = "Файл превышает допустимый размер (MAX_UPLOAD_MB)." if exc.code == 413 else exc.description
        return jsonify(error=message), exc.code

    @app.errorhandler(Exception)
    def internal_error(exc):
        current_app.logger.exception("Audio processing/export failed")
        return jsonify(error="Ошибка обработки или экспорта. Подробности в журнале сервера."), 500

    @app.post("/process-audio")
    def process_audio():
        return jsonify(_process_upload())

    @app.post("/process-audio-pdf")
    def process_audio_pdf():
        return send_file(BytesIO(render_pdf(_process_upload())), mimetype="application/pdf",
                         as_attachment=True, download_name="meeting-report.pdf")

    @app.post("/process-audio-docx")
    def process_audio_docx():
        return send_file(BytesIO(render_docx(_process_upload())),
                         mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                         as_attachment=True, download_name="meeting-report.docx")

    return app


app = create_app()

if __name__ == "__main__":
    from waitress import serve
    logging.basicConfig(level=logging.INFO)
    serve(app, host=os.getenv("HOST", "0.0.0.0"), port=int(os.getenv("PORT", "8000")),
          threads=4, max_request_body_size=app.config["MAX_CONTENT_LENGTH"])
