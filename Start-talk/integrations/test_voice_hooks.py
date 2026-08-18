import json
import tempfile
import unittest
from pathlib import Path

from read_claude_response_aloud import last_assistant_text
from read_codex_response_aloud import extract_message


class VoiceHookTests(unittest.TestCase):
    def test_extracts_codex_answer(self):
        self.assertEqual(
            extract_message({"last-assistant-message": "  respuesta  "}),
            "respuesta",
        )

    def test_extracts_latest_claude_answer(self):
        records = [
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "primera"}]}},
            {"type": "user", "message": {"content": "pregunta"}},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "ultima"}]}},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "transcript.jsonl"
            path.write_text("\n".join(json.dumps(item) for item in records), encoding="utf-8")
            self.assertEqual(last_assistant_text(str(path)), "ultima")


if __name__ == "__main__":
    unittest.main()
