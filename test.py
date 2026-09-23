from pathlib import Path
import sys

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
            text = transcribe(
                audio_path,
                progress=lambda done, total: print(
                    f"\r{done:.1f} / {total:.1f} s ({100 * done / total:.0f}%)",
                    end="", file=sys.stderr, flush=True,
                ),
            )
            print(file=sys.stderr)
            print(text)
        except Exception as exc:
            print(file=sys.stderr)
            print(f"Ошибка при обработке файла: {exc}")


if __name__ == "__main__":
    main()
