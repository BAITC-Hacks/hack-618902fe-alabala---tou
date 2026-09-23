from pathlib import Path

from stt_kazakh_russian import transcribe


def main() -> None:
    media_dir = Path(__file__).resolve().parent / "media"
    audio_files = sorted(
        path
        for path in media_dir.iterdir()
        if path.is_file() and path.suffix.lower() in {".wav", ".flac", ".mp3", ".ogg", ".m4a"}
    )

    if not audio_files:
        print(f"Аудиофайлы не найдены в папке: {media_dir}")
        return

    for audio_path in audio_files:
        print(f"\n=== {audio_path.name} ===")
        try:
            print(transcribe(audio_path))
        except Exception as exc:
            print(f"Ошибка при обработке файла: {exc}")


if __name__ == "__main__":
    main()
