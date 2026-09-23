from flask import Flask, request, send_file, jsonify
from pathlib import Path
import tempfile

app = Flask(__name__)

ALLOWED_EXTENSIONS = {".mp3", ".wav", ".ogg", ".m4a", ".webm"}


@app.post("/process-audio")
def process_audio():
    audio = request.files.get("audio")

    if audio is None:
        return jsonify({"error": "Файл audio не передан"}), 400

    if not audio.filename:
        return jsonify({"error": "Пустое имя файла"}), 400

    extension = Path(audio.filename).suffix.lower()

    if extension not in ALLOWED_EXTENSIONS:
        return jsonify({"error": "Неподдерживаемый формат аудио"}), 400

    with tempfile.TemporaryDirectory() as temp_dir:
        temp_dir = Path(temp_dir)

        input_path = temp_dir / f"input{extension}"
        output_path = temp_dir / "result.txt"

        audio.save(input_path)

        # Здесь твоя обработка аудио
        #
        # Например:
        # result = speech_to_text(input_path)
        #
        # Пока просто пример:
        result = f"Аудиофайл {audio.filename} успешно обработан"

        output_path.write_text(result, encoding="utf-8")

        return send_file(
            output_path,
            as_attachment=True,
            download_name="result.txt",
            mimetype="text/plain",
        )
