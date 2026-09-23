import argparse
import json
import logging
from pathlib import Path
import sys

from stt_kazakh_russian import transcribe, transcribe_diarized


def format_timestamp(seconds: float) -> str:
    minutes, milliseconds = divmod(round(seconds * 1000), 60000)
    return f"{minutes:02d}:{milliseconds / 1000:06.3f}"


def main() -> int:
    parser = argparse.ArgumentParser(description="Распознавание записей из папки media")
    parser.add_argument("--diarize", action="store_true", help="Разбить текст по говорящим и сохранить JSON")
    parser.add_argument("--num-speakers", type=int, help="Количество говорящих, если известно")
    parser.add_argument("--output-dir", type=Path, default=Path("results"), help="Папка с JSON (по умолчанию results)")
    args = parser.parse_args()
    if args.num_speakers is not None and (not args.diarize or args.num_speakers < 1):
        parser.error("--num-speakers должен быть положительным числом и требует --diarize")
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    media_dir = Path(__file__).resolve().parent / "media"
    if not media_dir.is_dir():
        print(f"Папка с аудиофайлами не найдена: {media_dir}", file=sys.stderr)
        return 1
    audio_files = sorted(
        path
        for path in media_dir.iterdir()
        if path.is_file() and path.suffix.lower() in {".wav", ".flac", ".mp3", ".ogg", ".m4a"}
    )

    if not audio_files:
        print(f"Аудиофайлы не найдены в папке: {media_dir}")
        return 1

    failed = False
    for audio_path in audio_files:
        print(f"\n=== {audio_path.name} ===")
        try:
            transcriber = transcribe_diarized if args.diarize else transcribe
            result = transcriber(
                audio_path,
                progress=lambda done, total: print(
                    f"\r{done:.1f} / {total:.1f} s ({100 * done / total:.0f}%)",
                    end="", file=sys.stderr, flush=True,
                ),
                **({"num_speakers": args.num_speakers} if args.diarize else {}),
            )
            print(file=sys.stderr)
            if args.diarize:
                for segment in result["segments"]:
                    speaker = segment["speaker"] or "UNKNOWN"
                    print(f"[{format_timestamp(segment['start'])}–{format_timestamp(segment['end'])}] "
                          f"{speaker}: {segment['text']}")
                args.output_dir.mkdir(parents=True, exist_ok=True)
                output_path = args.output_dir / f"{audio_path.name}.json"
                output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
                print(f"JSON сохранён: {output_path}")
            else:
                print(result)
        except Exception as exc:
            failed = True
            print(file=sys.stderr)
            print(f"Ошибка при обработке файла: {exc}", file=sys.stderr)
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
