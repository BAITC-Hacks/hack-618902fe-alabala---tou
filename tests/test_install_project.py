"""Installation checks must preserve settings and never report partial setup as ready."""

from contextlib import ExitStack, redirect_stderr, redirect_stdout
from io import StringIO
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import call, patch

import install_project as installer
import launch_project as launcher


class InstallerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="qorit install ")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.example = self.directory / ".env.example"
        self.example.write_text("LOCAL_MODELS_DIR=models/custom\n", encoding="utf-8")
        self.model = self.directory / "gemma-4-12b-it-Q4_K_S.gguf"
        self.model.write_bytes(b"local model placeholder")

    def test_initial_config_is_copied_but_existing_settings_are_preserved(self):
        with redirect_stdout(StringIO()):
            installer.prepare_config(self.directory)
        target = self.directory / ".env"
        self.assertEqual(target.read_bytes(), self.example.read_bytes())
        original = "LLAMA_MODEL_PATH=C:/Models/Gemma.gguf\n# Existing settings\n".encode()
        target.write_bytes(original)
        with redirect_stdout(StringIO()):
            installer.prepare_config(self.directory)
        self.assertEqual(target.read_bytes(), original)

    def run_install(self, *, fail_at=None):
        calls = []
        environment = []
        errors = StringIO()

        def run(*arguments):
            calls.append(arguments)
            environment.append(os.environ.get("LOCAL_MODELS_DIR"))
            if arguments == fail_at:
                raise subprocess.CalledProcessError(7, arguments)

        with ExitStack() as stack:
            stack.enter_context(patch.object(installer, "PROJECT_DIR", self.directory))
            stack.enter_context(patch.object(installer.sys, "platform", "linux"))
            stack.enter_context(patch.object(installer, "run_python", side_effect=run))
            stack.enter_context(patch.object(launcher, "load_config", return_value=SimpleNamespace(model_path=self.model)))
            stack.enter_context(redirect_stdout(StringIO()))
            stack.enter_context(redirect_stderr(errors))
            status = installer.main()
        return status, calls, environment, errors.getvalue()

    def test_dotenv_settings_reach_downloads_and_final_check_without_starting_services(self):
        with patch.dict(os.environ, {}, clear=True):
            status, calls, environment, _ = self.run_install()
        self.assertEqual(status, 0)
        self.assertEqual(calls, [
            ("-c", installer.CUDA_CHECK),
            ("prepare_models.py", "--download"),
            ("launch_project.py", "--setup-runtime"),
            ("launch_project.py", "--check"),
        ])
        self.assertEqual(environment, ["models/custom"] * 4)

    def test_inherited_model_directory_takes_precedence_over_dotenv(self):
        with patch.dict(os.environ, {"LOCAL_MODELS_DIR": "inherited/models"}, clear=True):
            status, _, environment, _ = self.run_install()
        self.assertEqual(status, 0)
        self.assertEqual(environment, ["inherited/models"] * 4)

    def test_every_failed_step_stops_setup_and_returns_failure(self):
        steps = [
            ("-c", installer.CUDA_CHECK),
            ("prepare_models.py", "--download"),
            ("launch_project.py", "--setup-runtime"),
            ("launch_project.py", "--check"),
        ]
        for index, step in enumerate(steps):
            with self.subTest(step=step), patch.dict(os.environ, {}, clear=True):
                status, calls, _, errors = self.run_install(fail_at=step)
            self.assertEqual(status, 1)
            self.assertEqual(calls, steps[:index + 1])
            self.assertIn("exit code 7", errors)

    def test_missing_or_empty_gemma_never_reports_ready(self):
        for exists in (False, True):
            if exists:
                self.model.touch()
            else:
                self.model.unlink()
            with self.subTest(exists=exists), patch.dict(os.environ, {}, clear=True):
                status, calls, _, errors = self.run_install()
            self.assertEqual(status, 1)
            self.assertNotIn(("launch_project.py", "--check"), calls)
            self.assertIn("LLAMA_MODEL_PATH", errors)
            self.assertIn(str(self.model), errors)

    def test_child_commands_preserve_paths_with_spaces_and_propagate_errors(self):
        with patch.object(installer, "PROJECT_DIR", self.directory), \
             patch.object(installer.sys, "executable", "/opt/venv with spaces/bin/python"), \
             patch.object(installer.subprocess, "run", side_effect=subprocess.CalledProcessError(3, "child")) as run:
            with self.assertRaises(subprocess.CalledProcessError):
                installer.run_python("prepare_models.py", "--download")
        self.assertEqual(run.call_args, call(
            ["/opt/venv with spaces/bin/python", "-u", "prepare_models.py", "--download"],
            cwd=self.directory, check=True,
        ))


if __name__ == "__main__":
    unittest.main()
