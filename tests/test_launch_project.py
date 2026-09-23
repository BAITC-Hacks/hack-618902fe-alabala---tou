"""Launcher boundaries: local configuration, readiness, and owned process cleanup."""

from dataclasses import replace
from io import StringIO
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, call, patch

import launch_project as launcher


class LauncherTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.config = launcher.Config(
            model_path=self.directory / f"{launcher.MODEL_ALIAS}.gguf",
            binary=self.directory / "llama-server",
            llama_port=18080,
            api_port=18000,
        )

    def test_paths_with_spaces_remain_single_command_arguments(self):
        model = launcher.resolve_path("models with spaces/gemma.gguf", self.directory)
        self.assertEqual(model, self.directory / "models with spaces" / "gemma.gguf")
        config = replace(self.config, model_path=model, binary=self.directory / "runtime files" / "llama-server")
        command = launcher.build_llama_command(config)
        self.assertEqual(command[0], str(config.binary))
        self.assertEqual(command[command.index("-m") + 1], str(model))

    @unittest.skipUnless(sys.platform == "linux", "Windows drive conversion targets WSL")
    def test_windows_drive_path_maps_to_wsl_without_losing_spaces(self):
        actual = launcher.resolve_path(r"C:\Local Models\gemma-4-12b-it-Q6_K.gguf", self.directory)
        self.assertEqual(actual, Path("/mnt/c/Local Models/gemma-4-12b-it-Q6_K.gguf"))
        self.assertEqual(launcher.resolve_path("D:/Models/file.gguf"), Path("/mnt/d/Models/file.gguf"))

    def test_child_connection_matches_the_model_server_command(self):
        config = replace(self.config, llama_port=19090, api_port=19000, host="127.0.0.1")
        with patch.dict(os.environ, {"LLM_PROVIDER": "obsolete_provider", "LLAMA_MODEL": "old_model",
                                     "LLAMA_URL": "http://old-host:9999", "KEEP_ME": "yes"}, clear=True):
            environment = launcher.child_environment(config)
        command = launcher.build_llama_command(config)
        self.assertEqual(environment["LLM_PROVIDER"], "local_llama")
        self.assertEqual(environment["LLAMA_MODEL"], command[command.index("--alias") + 1])
        self.assertEqual(environment["LLAMA_MODEL"], "gemma-4-12b-it-Q6_K")
        self.assertEqual(environment["LLAMA_URL"], "http://127.0.0.1:" + command[command.index("--port") + 1])
        self.assertEqual(environment["HOST"], "127.0.0.1")
        self.assertEqual(environment["PORT"], "19000")
        self.assertEqual(environment["KEEP_ME"], "yes")

    def test_environment_config_validates_ports_and_timeout(self):
        dotenv = SimpleNamespace(load_dotenv=Mock())
        for name, value in (("LLAMA_PORT", "0"), ("PORT", "65536"), ("PORT", "text"),
                            ("LLAMA_STARTUP_TIMEOUT", "0"), ("LLAMA_STARTUP_TIMEOUT", "nan"),
                            ("LLAMA_STARTUP_TIMEOUT", "inf")):
            with self.subTest(name=name, value=value):
                with patch.dict(sys.modules, {"dotenv": dotenv}), patch.dict(os.environ, {name: value}, clear=True):
                    with self.assertRaisesRegex(launcher.LaunchError, name):
                        launcher.load_config()

    def test_existing_environment_is_not_overwritten_by_dotenv(self):
        dotenv = SimpleNamespace(load_dotenv=Mock())
        values = {"LLAMA_PORT": "19090", "PORT": "19000", "LLAMA_STARTUP_TIMEOUT": "45.5",
                  "LLAMA_GPU_LAYERS": "0", "LLAMA_MODEL_PATH": str(self.config.model_path),
                  "LLAMA_SERVER_BINARY": str(self.config.binary)}
        with patch.dict(sys.modules, {"dotenv": dotenv}), patch.dict(os.environ, values, clear=True):
            config = launcher.load_config()
        self.assertEqual(config.model_path, self.config.model_path)
        self.assertEqual(config.binary, self.config.binary)
        self.assertEqual((config.llama_port, config.api_port, config.startup_timeout), (19090, 19000, 45.5))
        self.assertFalse(dotenv.load_dotenv.call_args.kwargs["override"])

    def test_equal_ports_are_rejected(self):
        with self.assertRaisesRegex(launcher.LaunchError, "different"):
            launcher.ensure_ports_available(replace(self.config, api_port=self.config.llama_port))

    def test_busy_port_is_reported_without_stopping_its_owner(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as existing:
            existing.bind(("127.0.0.1", 0))
            existing.listen()
            port = existing.getsockname()[1]
            config = replace(self.config, llama_port=port, api_port=1 if port != 1 else 2)
            with self.assertRaisesRegex(launcher.LaunchError, str(port)):
                launcher.ensure_ports_available(config)
            # The unrelated listener remains alive after the failed preflight.
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                pass

    def test_missing_empty_and_wrong_quantization_models_fail_before_dependencies(self):
        invalid = self.directory / "gemma-4-12b-it-Q8_0.gguf"
        for model in (invalid, self.config.model_path):
            with self.subTest(model=model), patch.object(launcher.sys, "platform", "linux"):
                with self.assertRaisesRegex(launcher.LaunchError, "Q6_K"):
                    launcher.preflight(replace(self.config, model_path=model))
        self.config.model_path.touch()
        with patch.object(launcher.sys, "platform", "linux"):
            with self.assertRaisesRegex(launcher.LaunchError, "missing or empty"):
                launcher.preflight(self.config)

    def test_ready_model_requires_the_expected_alias(self):
        process = Mock()
        process.poll.return_value = None
        children = [("Gemma", process, self.directory / "llama.log")]
        with patch.object(launcher, "_get", side_effect=[(200, {"status": "ok"}),
                                                        (200, {"data": [{"id": "another-model"}]})]):
            with self.assertRaisesRegex(launcher.LaunchError, "alias"):
                launcher._wait_ready(self.config, children, api=False)
        with patch.object(launcher, "_get", side_effect=[(200, {"status": "ok"}),
                                                        (200, {"data": [{"id": launcher.MODEL_ALIAS}]})]):
            launcher._wait_ready(self.config, children, api=False)

    def test_corrupt_cached_runtime_is_never_extracted_or_executed(self):
        runtime = self.directory / "runtime"
        runtime.mkdir()
        archive = runtime / "runtime.tar.gz"
        archive.write_bytes(b"corrupt or replaced archive")
        config = replace(self.config, binary=runtime / "llama-server")
        with patch.object(launcher, "DEFAULT_BINARY", config.binary), \
             patch.object(launcher, "RUNTIME_DIR", runtime), \
             patch.object(launcher, "RUNTIME_ARCHIVE", archive), \
             patch.object(launcher.sys, "platform", "linux"), \
             patch.object(launcher.platform, "machine", return_value="x86_64"), \
             patch.object(launcher, "urlopen") as download, \
             patch.object(launcher.tarfile, "open") as extract:
            with self.assertRaisesRegex(launcher.LaunchError, "SHA256 mismatch"):
                launcher.prepare_runtime(config)
        download.assert_not_called()
        extract.assert_not_called()
        self.assertFalse(config.binary.exists())

    @unittest.skipUnless(hasattr(os, "killpg"), "Process groups are managed in Linux/WSL")
    def test_cleanup_escalates_timed_out_children_and_only_signals_owned_groups(self):
        stubborn = Mock(pid=11111)
        stubborn.wait.side_effect = [subprocess.TimeoutExpired("Gemma", 5), 0]
        exited = Mock(pid=22222)
        exited.wait.return_value = 0
        children = [("Gemma", stubborn, self.directory / "llama.log"),
                    ("API", exited, self.directory / "api.log")]
        with patch.object(launcher.os, "killpg") as kill_group:
            launcher.stop_children(children)
        self.assertEqual({entry.args[0] for entry in kill_group.call_args_list}, {11111, 22222})
        self.assertIn(call(11111, signal.SIGTERM), kill_group.call_args_list)
        self.assertIn(call(11111, signal.SIGKILL), kill_group.call_args_list)
        self.assertGreaterEqual(stubborn.wait.call_count, 2)

    @unittest.skipUnless(hasattr(os, "killpg"), "Process groups are managed in Linux/WSL")
    def test_cleanup_tolerates_already_exited_process_groups(self):
        process = Mock(pid=11111)
        process.wait.return_value = 0
        with patch.object(launcher.os, "killpg", side_effect=ProcessLookupError):
            launcher.stop_children([("Gemma", process, self.directory / "llama.log")])
        process.wait.assert_called()

    def test_preflight_failure_does_not_start_processes(self):
        with patch.object(launcher, "load_config", return_value=self.config), \
             patch.object(launcher, "preflight", side_effect=launcher.LaunchError("busy port")), \
             patch.object(launcher.subprocess, "Popen") as popen, \
             patch.object(launcher, "stop_children") as stop, \
             patch.object(launcher.signal, "signal"), \
             patch("sys.stdout", new_callable=StringIO), patch("sys.stderr", new_callable=StringIO):
            self.assertEqual(launcher.main([]), 1)
        popen.assert_not_called()
        stop.assert_called_once_with([])

    def test_check_mode_does_not_download_runtime_or_launch_processes(self):
        with patch.object(launcher, "load_config", return_value=self.config), \
             patch.object(launcher, "preflight") as preflight, \
             patch.object(launcher, "prepare_runtime") as prepare, \
             patch.object(launcher.subprocess, "Popen") as popen, \
             patch.object(launcher, "stop_children"), \
             patch.object(launcher.signal, "signal"), \
             patch("sys.stdout", new_callable=StringIO):
            self.assertEqual(launcher.main(["--check"]), 0)
        preflight.assert_called_once_with(self.config)
        prepare.assert_not_called()
        popen.assert_not_called()

    def test_api_start_failure_cleans_up_the_model_and_closes_logs(self):
        process = Mock(pid=11111)
        log_directory = self.directory / "logs"
        with patch.object(launcher, "load_config", return_value=self.config), \
             patch.object(launcher, "preflight"), \
             patch.object(launcher, "LOG_DIR", log_directory), \
             patch.object(launcher, "_wait_ready"), \
             patch.object(launcher.subprocess, "Popen", side_effect=[process, OSError("API failed")]) as popen, \
             patch.object(launcher, "stop_children") as stop, \
             patch.object(launcher.signal, "signal"), \
             patch("sys.stdout", new_callable=StringIO), patch("sys.stderr", new_callable=StringIO):
            self.assertEqual(launcher.main([]), 1)
        owned_children = stop.call_args.args[0]
        self.assertEqual(len(owned_children), 1)
        self.assertIs(owned_children[0][1], process)
        for spawned in popen.call_args_list:
            self.assertTrue(spawned.kwargs["start_new_session"])
            self.assertTrue(spawned.kwargs["stdout"].closed)


if __name__ == "__main__":
    unittest.main()
